// src/modules/auth/service.js — U2-IDENTITY: the single auth service (ADR-006) —
// registration, email verification, login, logout.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-10 (TC-10) — register() creates the USER row (email_verified=false, Argon2id hash),
//                   the single-use verification token and the 'email.verification' outbox
//                   row in ONE PostgreSQL transaction (ADR-001/003 — no dual writes; zero
//                   adapter calls on the request path). createVerificationLink() mints the
//                   DELIVERABLE single-use link worker-side (the raw token is unrecoverable
//                   afterwards by design, so it can neither ride in the outbox payload nor
//                   be reconstructed from the stored digest). verifyEmail() flips the flag
//                   only for a correct, unconsumed, unexpired token; anything else is 400
//                   with the flag unchanged. resendVerificationEmail() is the RECOVERY path
//                   (NFR-09): when the first delivery dead-letters or never arrives it
//                   commits a fresh token + a fresh outbox row in one transaction, throttled
//                   on its own counter and answering identically for an unknown, an
//                   already-verified and a freshly re-queued address (AB-05).
//   NFR-04 (ST-02) — passwords enter only ./passwords.hashPassword; the plaintext is never
//                   stored, logged or echoed anywhere.
//   NFR-05 (ST-03) — login() consults ./rateLimit BEFORE verifying credentials: the 6th
//                   attempt inside the window is 429 + Retry-After even with correct
//                   credentials; success resets the account counter.
//   NFR-06 (IT-02) — registration and verification recompute + persist the eligibility
//                   flags through the ONE policy interface (users/service.recomputeEligibility).
//   NFR-08 (MT-01) — registration/login/logout/verification each write one audit record
//                   with correlation IDs via the request-scoped logger; IDs only, no PII.
//   AB-05          — opaque 256-bit Redis-backed sessions (./sessions); logout destroys the
//                   Redis record so the cookie token is unusable immediately; login timing
//                   does not reveal whether an account exists (dummy verify).
//   AB-07          — duplicate email registration maps the users_email_key unique-constraint
//                   violation (23505) to 409, never a second row.
//
// Public interface (build-plan §3): authService.register/login/logout/verifyEmail/
// resendVerificationEmail (request path) + createVerificationLink (WORKER path only).
'use strict';

const config = require('../../config');
const { withTransaction } = require('../../db/tx');
const {
  AppError,
  AuthenticationError,
  ConflictError,
  RateLimitError,
} = require('../../lib/errors');
const { logger, audit } = require('../../lib/logger');
// Namespace import (not destructured) so the test suite can inject an enqueue failure and
// prove the register transaction rolls back atomically (ADR-001/003 — no dual writes).
const outbox = require('../../outbox/outbox');
const usersRepo = require('../users/repo');
const usersService = require('../users/service');
const tokens = require('../users/tokens');
const passwords = require('./passwords');
const sessions = require('./sessions');
const rateLimit = require('./rateLimit');

/** Outbox job type consumed by src/outbox/handlers/emailVerification.js (FR-10). */
const EMAIL_VERIFICATION_JOB_TYPE = 'email.verification';

/** Route that consumes the emailed token (src/modules/auth/routes.js — GET/POST). */
const VERIFY_EMAIL_PATH = '/api/auth/verify-email';

/**
 * Register a new account (FR-10). One transaction commits the USER row, the verification
 * token (digest only) and the 'email.verification' outbox row carrying IDs only; the
 * worker later delivers the email through the U2-ADAPTERS-COMMS transport — NO adapter is
 * touched on this request path (ADR-001/003).
 *
 * @param {{email: string, password: string, fullName?: string, phone?: string}} input
 *   validated body (src/schemas/auth.js register)
 * @param {{log?: object}} [ctx]  request-scoped logger (correlation ID — NFR-08)
 * @returns {Promise<{user: object, verification: {rawToken: string, expiresAt: Date}}>}
 *   `verification.rawToken` NEVER leaves the process: routes must not return it to the
 *   client (the whole point of FR-10 is proving inbox ownership), and it is deliberately
 *   absent from the outbox payload (ADR-003 — IDs only), which is why the emailed link is
 *   minted worker-side by createVerificationLink() instead of being carried across.
 */
async function register({ email, password, fullName, phone }, { log = logger } = {}) {
  // Hash OUTSIDE the transaction: ~50-100 ms of intentional Argon2id work must not hold
  // a connection/locks open (NFR-01 discipline; NFR-04 cost parameters).
  const passwordHash = await passwords.hashPassword(password);

  let user;
  let verification;
  try {
    ({ user, verification } = await withTransaction(async (client) => {
      const created = await usersRepo.createUser(client, {
        email,
        passwordHash,
        fullName: fullName ?? null,
        phone: phone ?? null,
      });

      // FR-10: single-use expiring token; PostgreSQL stores the digest only.
      const token = await tokens.createEmailVerificationToken(client, created.id);

      // ADR-001/003: outbox row on the SAME client — IDs only (userId + token digest).
      await outbox.enqueue(client, {
        type: EMAIL_VERIFICATION_JOB_TYPE,
        payload: { userId: created.id, tokenHash: token.hash },
        dedupeKey: `${EMAIL_VERIFICATION_JOB_TYPE}:${token.hash}`,
      });

      // NFR-06: flags recomputed through the ONE policy even at registration (they are
      // false here — email unverified — but the invariant is "recomputed after every
      // mutation", not "defaulted").
      const flagged = await usersService.recomputeEligibility(client, created.id);

      return {
        user: flagged ?? created,
        verification: { rawToken: token.raw, expiresAt: token.expiresAt },
      };
    }));
  } catch (err) {
    if (err && err.code === '23505' && err.constraint === 'users_email_key') {
      // AB-07: duplicate account blocked by the unique constraint — 409, no row created.
      audit(log, { event: 'user.registered', outcome: 'failure', reason: 'duplicate_email' });
      throw new ConflictError('An account with this email already exists', {
        code: 'EMAIL_IN_USE',
        cause: err,
      });
    }
    throw err;
  }

  audit(log, {
    event: 'user.registered',
    outcome: 'success',
    actorUserId: user.id,
    entityType: 'user',
    entityId: user.id,
  });
  return { user, verification };
}

/**
 * Re-queue a verification email (FR-10 recovery path; NFR-09 "deferred, never dropped").
 *
 * Why this exists (finding TCBV2-03): users.email_verified is written ONLY by consuming a
 * raw token that arrives by email, and the only producer of a mailable link is the
 * 'email.verification' outbox job. config.outbox.maxAttempts bounds the worker's retry
 * budget, so a provider outage longer than that budget DEAD-LETTERS the job — and without a
 * way to ask for another one the account could never be verified, which (FR-09/NFR-06)
 * refuses POST /api/bookings and POST /api/listings for that user forever. A bounced or
 * mistyped-but-real mailbox produces the same dead end.
 *
 * Behaviour (all four cases are indistinguishable to the caller — the route always answers
 * 202, AB-05 anti-enumeration):
 *   - unknown address, soft-deleted account, or already-verified account → nothing is
 *     enqueued (an already-verified account has nothing to verify, and mailing strangers on
 *     request would make this an open relay for harassment);
 *   - active unverified account → a FRESH single-use token and its 'email.verification'
 *     outbox row commit in ONE transaction, exactly as register() does (ADR-001/003: no dual
 *     writes, payload carries IDs only, and no adapter is touched on this request path —
 *     the worker delivers).
 *
 * The new job's dedupeKey derives from the NEW token digest, so it is independent of the
 * original job: a dead-lettered predecessor cannot suppress it, and the worker mints the
 * mailable link at delivery time as always (createVerificationLink).
 *
 * @param {{email: string, ip?: string}} input  validated body + req.ip (throttle key)
 * @param {{log?: object}} [ctx]
 * @returns {Promise<{enqueued: boolean}>} for logging/tests; the ROUTE must not vary its
 *   response on this value.
 * @throws {RateLimitError} when the resend throttle is engaged (its own counter — never the
 *   login lockout, so this endpoint cannot be used to lock anyone out of login)
 */
async function resendVerificationEmail({ email, ip }, { log = logger } = {}) {
  const attempt = { email, ip: ip || 'unknown' };

  const gate = await rateLimit.checkResend(attempt);
  if (gate.limited) {
    audit(log, { event: 'user.verification_resent', outcome: 'failure', reason: 'rate_limited' });
    throw new RateLimitError('Too many verification requests — try again later', {
      code: 'VERIFICATION_RESEND_RATE_LIMITED',
      details: { retryAfterSeconds: gate.retryAfterSeconds },
    });
  }
  // Counted BEFORE the account lookup so an existing and a non-existent address consume the
  // budget identically (AB-05).
  await rateLimit.recordResend(attempt);

  const user = await usersRepo.findByEmail(email);
  if (!user || user.deleted_at !== null || user.email_verified) {
    // NFR-08: the audit trail records what really happened (IDs only); the CLIENT still gets
    // the same 202 it gets for a successful re-queue.
    audit(log, {
      event: 'user.verification_resent',
      outcome: 'noop',
      reason: !user || user.deleted_at !== null ? 'no_active_account' : 'already_verified',
      actorUserId: user ? user.id : undefined,
    });
    return { enqueued: false };
  }

  await withTransaction(async (client) => {
    // FR-10: a fresh single-use token (digest only in PostgreSQL) …
    const token = await tokens.createEmailVerificationToken(client, user.id);
    // … and its delivery job, on the SAME client (ADR-001/003 — IDs only, no dual writes).
    await outbox.enqueue(client, {
      type: EMAIL_VERIFICATION_JOB_TYPE,
      payload: { userId: user.id, tokenHash: token.hash },
      dedupeKey: `${EMAIL_VERIFICATION_JOB_TYPE}:${token.hash}`,
    });
  });

  audit(log, {
    event: 'user.verification_resent',
    outcome: 'success',
    actorUserId: user.id,
    entityType: 'user',
    entityId: user.id,
  });
  return { enqueued: true };
}

/**
 * Mint the DELIVERABLE verification link for a user (FR-10) — the one value that lets a real
 * recipient finish registration.
 *
 * Why this exists (finding TCB-W3-01): PostgreSQL stores only the SHA-256 DIGEST of a
 * verification token (users/tokens.js) and the outbox payload carries IDs only (ADR-003), so
 * the raw token minted during register() is unrecoverable by the time the worker mails it.
 * A digest is not a credential — submitting one is (correctly) a 400 — so the email had
 * nothing usable in it and email_verified could never become true.
 *
 * The fix keeps every invariant instead of relaxing one: the WORKER mints a fresh single-use
 * token here, at delivery time, in its own transaction. The raw value exists only in worker
 * memory and in the outgoing email — never in the outbox payload, never in a
 * NOTIFICATION_ATTEMPT row, never in a log line, never in Redis (ADR-003, §3.4 PII register).
 * Each token is independently single-use and expires with EMAIL_TOKEN_TTL_HOURS, so a retried
 * or resent delivery simply carries its own link.
 *
 * CALLER CONTRACT (ADR-001/003): this is worker-side work. It is called from
 * src/outbox/handlers/emailVerification.js, never from a request handler — nothing here
 * touches an adapter, but minting a credential belongs to the delivery path that mails it.
 *
 * @param {string} userId  owner of the account being verified
 * @param {{log?: object}} [ctx]
 * @returns {Promise<{url: string, expiresAt: Date}>} `url` carries the raw single-use token
 *   and must be treated as a secret: hand it to the mail transport, never log or persist it.
 */
async function createVerificationLink(userId, { log = logger } = {}) {
  const token = await withTransaction((client) =>
    tokens.createEmailVerificationToken(client, userId)
  );
  // The base origin is configuration (src/config/schema.js PUBLIC_BASE_URL): a guessed host
  // would mail dead links, so production refuses to start without it.
  const url = `${config.server.publicBaseUrl}${VERIFY_EMAIL_PATH}?token=${token.raw}`;

  // NFR-08: IDs and timestamps only — the URL embeds the raw token, so it is never logged.
  log.info(
    {
      event: 'email_verification_link_minted',
      userId,
      expiresAt: token.expiresAt.toISOString(),
    },
    'email_verification_link_minted'
  );
  return { url, expiresAt: token.expiresAt };
}

/**
 * Confirm an email-verification token (FR-10). Correct + unconsumed + unexpired →
 * email_verified=true, token consumed, eligibility flags recomputed — one transaction.
 * Wrong, already-used or expired → 400, flag untouched (the same failure on purpose:
 * a probe learns nothing about which tokens exist).
 *
 * @param {string} rawToken
 * @param {{log?: object}} [ctx]
 * @returns {Promise<{userId: string, emailVerified: true}>}
 */
async function verifyEmail(rawToken, { log = logger } = {}) {
  const result = await withTransaction(async (client) => {
    const userId = await tokens.consumeEmailVerificationToken(client, rawToken);
    if (userId === null) return null;
    await usersRepo.markEmailVerified(client, userId);
    await usersService.recomputeEligibility(client, userId); // NFR-06
    return userId;
  });

  if (result === null) {
    audit(log, { event: 'user.email_verified', outcome: 'failure', reason: 'invalid_token' });
    throw new AppError('Invalid or expired verification token', {
      status: 400,
      code: 'INVALID_VERIFICATION_TOKEN',
      retryable: false,
    });
  }

  audit(log, {
    event: 'user.email_verified',
    outcome: 'success',
    actorUserId: result,
    entityType: 'user',
    entityId: result,
  });
  return { userId: result, emailVerified: true };
}

/**
 * Log in (NFR-05, AB-05). Order matters and is load-bearing:
 *   1. rate-limit check (429 even for correct credentials — ST-03 boundary),
 *   2. credential verification (constant-shape failures; dummy verify equalizes timing
 *      for unknown accounts),
 *   3. session mint + account-counter reset on success.
 *
 * @param {{email: string, password: string, ip: string}} input
 * @param {{log?: object}} [ctx]
 * @returns {Promise<{user: object, session: {token: string, sessionId: string, ttlSeconds: number}}>}
 */
async function login({ email, password, ip }, { log = logger } = {}) {
  const attempt = { email, ip: ip || 'unknown' };

  const gate = await rateLimit.check(attempt);
  if (gate.limited) {
    audit(log, { event: 'auth.login', outcome: 'failure', reason: 'rate_limited' });
    throw new RateLimitError('Too many failed login attempts — try again later', {
      code: 'LOGIN_RATE_LIMITED',
      details: { retryAfterSeconds: gate.retryAfterSeconds },
    });
  }

  const user = await usersRepo.findByEmail(email);
  let valid = false;
  if (user && user.deleted_at === null) {
    valid = await passwords.verifyPassword(user.password_hash, password);
  } else {
    // AB-05: burn an equivalent verification so "no such account" and "wrong password"
    // cost the same wall-clock time.
    valid = await passwords.verifyAgainstDummy(password);
  }

  if (!valid) {
    await rateLimit.recordFailure(attempt);
    audit(log, {
      event: 'auth.login',
      outcome: 'failure',
      reason: 'invalid_credentials',
      actorUserId: user ? user.id : undefined,
    });
    // One indistinguishable failure for unknown email vs wrong password (AB-05).
    throw new AuthenticationError('Invalid email or password', { code: 'INVALID_CREDENTIALS' });
  }

  await rateLimit.resetAccount(attempt); // ST-03: success resets the account counter
  const session = await sessions.createSession(user);
  await usersRepo.touchLastActive(user.id); // NFR-12 inactivity clock

  audit(log, {
    event: 'auth.login',
    outcome: 'success',
    actorUserId: user.id,
    entityType: 'user',
    entityId: user.id,
    sessionId: session.sessionId,
  });
  return { user, session };
}

/**
 * Log out (AB-05): delete the Redis session record — the cookie token is unusable from
 * this moment even if the client keeps it.
 * @param {string} token  raw cookie token
 * @param {{log?: object, userId?: string, sessionId?: string}} [ctx]
 * @returns {Promise<boolean>} whether a live session was destroyed
 */
async function logout(token, { log = logger, userId, sessionId } = {}) {
  const destroyed = await sessions.destroySession(token);
  audit(log, {
    event: 'auth.logout',
    outcome: destroyed ? 'success' : 'noop',
    actorUserId: userId,
    entityType: 'session',
    entityId: sessionId,
  });
  return destroyed;
}

module.exports = {
  register,
  login,
  logout,
  verifyEmail,
  resendVerificationEmail,
  createVerificationLink,
  EMAIL_VERIFICATION_JOB_TYPE,
  VERIFY_EMAIL_PATH,
};
