// src/modules/auth/service.js — U2-IDENTITY: the single auth service (ADR-006) —
// registration, email verification, login, logout.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-10 (TC-10) — register() creates the USER row (email_verified=false, Argon2id hash),
//                   the single-use verification token and the 'email.verification' outbox
//                   row in ONE PostgreSQL transaction (ADR-001/003 — no dual writes; zero
//                   adapter calls on the request path). verifyEmail() flips the flag only
//                   for a correct, unconsumed, unexpired token; anything else is 400 with
//                   the flag unchanged.
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
// Public interface (build-plan §3): authService.register/login/logout/verifyEmail.
'use strict';

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
 *   `verification.rawToken` is for the emailed link ONLY — routes must never return it to
 *   the client (the whole point of FR-10 is proving inbox ownership).
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
  EMAIL_VERIFICATION_JOB_TYPE,
};
