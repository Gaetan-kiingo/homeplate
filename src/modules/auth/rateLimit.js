// src/modules/auth/rateLimit.js — U2-IDENTITY: login attempt limiting (NFR-05, ST-03).
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-05 (ST-03) — 5 failed login attempts for the same ACCOUNT within a 10-minute
//                    window lock the 6th attempt out with 429 + Retry-After, EVEN when its
//                    credentials are correct. Counters live in Redis keyed by account AND
//                    by source IP, each with a 600-second TTL (config.auth.loginWindowSeconds).
//                    Window expiry restores login; a successful login resets the account
//                    counter.
//   AB-05          — the per-IP counter blunts credential stuffing that cycles ACCOUNTS
//                    from one source; the per-account counter blunts brute force against
//                    one account from many sources.
//   ADR-001/006    — these counters are protective, loseable state: a Redis flush merely
//                    re-opens the window. Redis never holds business state (SRS §2.4).
//
// Redis layout (all TTL = config.auth.loginWindowSeconds, set when the first failure
// starts the window):
//   hp:ratelimit:login:acct:<sha256(email)>  → failure count   (threshold: loginMaxAttempts)
//   hp:ratelimit:login:ip:<ip>               → failure count   (threshold: loginMaxAttempts
//                                              × IP_ATTEMPT_MULTIPLIER)
// The account key hashes the attempted email so no PII (SRS §3.4 register) is ever written
// into a Redis key — and unknown accounts are counted too (enumeration hammering costs the
// attacker the same window).
//
// A third, INDEPENDENT namespace throttles the FR-10 verification-resend path
// (hp:ratelimit:verify-resend:*) — see the block above checkResend() for why it must never
// share a counter with the login lockout.
'use strict';

const crypto = require('crypto');
const config = require('../../config');
const { redis, key } = require('../../db/redis');

// The per-IP threshold is a multiple of the per-account one: strict enough to stop scripted
// account-cycling (AB-05) while one shared NAT of legitimate users failing occasionally does
// not lock everyone out. The NFR-05 "5 in 10 minutes" bound applies to the ACCOUNT counter;
// this multiplier is an internal defence parameter, not a jurisdiction cap (ADR-009 scope).
const IP_ATTEMPT_MULTIPLIER = 10;

/** SHA-256 of the normalized address — no PII (SRS §3.4 register) ever enters a Redis key. */
function emailDigest(email) {
  return crypto.createHash('sha256').update(String(email).toLowerCase(), 'utf8').digest('hex');
}

function accountKey(email) {
  return key('ratelimit', 'login', 'acct', emailDigest(email));
}

function ipKey(ip) {
  return key('ratelimit', 'login', 'ip', String(ip));
}

// ---- FR-10 verification-resend throttle -------------------------------------------------------
// A SEPARATE counter namespace, deliberately: re-requesting a verification email is not a
// credential guess. If resend requests fed the login counters above, any unauthenticated
// stranger could lock an arbitrary account out of login (NFR-05 lockout) simply by asking for
// verification emails — an account-lockout denial of service. The two windows are therefore
// independent in both directions.
//
//   hp:ratelimit:verify-resend:acct:<sha256(email)>  → request count (threshold: RESEND_MAX_ATTEMPTS)
//   hp:ratelimit:verify-resend:ip:<ip>               → request count (threshold: × IP_ATTEMPT_MULTIPLIER)
//
// The budget is tighter than the login one because each request costs an outbound email:
// three per address per window is enough for "it never arrived, try again", far too few to
// weaponize the mailer. Requests are counted for UNKNOWN addresses too, so the throttle
// boundary is identical whether or not the account exists (AB-05 anti-enumeration).
const RESEND_MAX_ATTEMPTS = 3;

function resendAccountKey(email) {
  return key('ratelimit', 'verify-resend', 'acct', emailDigest(email));
}

function resendIpKey(ip) {
  return key('ratelimit', 'verify-resend', 'ip', String(ip));
}

/** Longest positive TTL among the given Redis keys, in whole seconds (for Retry-After). */
async function longestTtl(keys) {
  let max = 0;
  for (const k of keys) {
    const ttl = await redis.ttl(k);
    if (ttl > max) max = ttl;
  }
  return max > 0 ? max : config.auth.loginWindowSeconds;
}

/**
 * Is this login attempt locked out? Checked BEFORE credential verification, so a locked
 * account refuses even correct credentials (ST-03 boundary: attempt 6 is 429).
 * @param {{email: string, ip: string}} attempt
 * @returns {Promise<{limited: boolean, retryAfterSeconds: number | null}>}
 */
async function check({ email, ip }) {
  const acctKey = accountKey(email);
  const sourceKey = ipKey(ip);
  const [acctRaw, ipRaw] = await Promise.all([redis.get(acctKey), redis.get(sourceKey)]);
  const acctCount = Number(acctRaw) || 0;
  const ipCount = Number(ipRaw) || 0;

  const acctLimited = acctCount >= config.auth.loginMaxAttempts;
  const ipLimited = ipCount >= config.auth.loginMaxAttempts * IP_ATTEMPT_MULTIPLIER;
  if (!acctLimited && !ipLimited) {
    return { limited: false, retryAfterSeconds: null };
  }
  const limitingKeys = [];
  if (acctLimited) limitingKeys.push(acctKey);
  if (ipLimited) limitingKeys.push(sourceKey);
  return { limited: true, retryAfterSeconds: await longestTtl(limitingKeys) };
}

/**
 * Record one FAILED login attempt against both counters. The window TTL starts with the
 * first failure and is NOT extended by later ones — "5 within 10 minutes" measures from
 * the first failure of the window (NFR-05).
 * @param {{email: string, ip: string}} attempt
 * @returns {Promise<{accountFailures: number, ipFailures: number}>}
 */
async function recordFailure({ email, ip }) {
  const windowSeconds = config.auth.loginWindowSeconds;
  const results = await redis
    .multi()
    .incr(accountKey(email))
    .expire(accountKey(email), windowSeconds, 'NX')
    .incr(ipKey(ip))
    .expire(ipKey(ip), windowSeconds, 'NX')
    .exec();
  return {
    accountFailures: results[0][1],
    ipFailures: results[2][1],
  };
}

/**
 * A successful login RESETS the account counter (ST-03: "success resets the counter") —
 * the legitimate owner's occasional typos never accumulate into a lockout. The IP counter
 * is deliberately left to expire on its own TTL: one cracked account must not reopen the
 * window for a source that is cycling many accounts (AB-05).
 * @param {{email: string}} attempt
 */
async function resetAccount({ email }) {
  await redis.del(accountKey(email));
}

/**
 * Is this verification-resend request throttled (FR-10 recovery path)? Same window length as
 * the login limiter, its own counters and its own (tighter) threshold — see the namespace
 * note above for why the two must never share a counter.
 * @param {{email: string, ip: string}} attempt
 * @returns {Promise<{limited: boolean, retryAfterSeconds: number | null}>}
 */
async function checkResend({ email, ip }) {
  const acctKey = resendAccountKey(email);
  const sourceKey = resendIpKey(ip);
  const [acctRaw, ipRaw] = await Promise.all([redis.get(acctKey), redis.get(sourceKey)]);
  const acctLimited = (Number(acctRaw) || 0) >= RESEND_MAX_ATTEMPTS;
  const ipLimited = (Number(ipRaw) || 0) >= RESEND_MAX_ATTEMPTS * IP_ATTEMPT_MULTIPLIER;
  if (!acctLimited && !ipLimited) {
    return { limited: false, retryAfterSeconds: null };
  }
  const limitingKeys = [];
  if (acctLimited) limitingKeys.push(acctKey);
  if (ipLimited) limitingKeys.push(sourceKey);
  return { limited: true, retryAfterSeconds: await longestTtl(limitingKeys) };
}

/**
 * Count one verification-resend REQUEST against both counters. Every request counts —
 * including one for an address with no account — so a probe cannot tell the two apart by
 * watching when the throttle engages (AB-05). The window TTL starts with the first request
 * and is not extended by later ones.
 * @param {{email: string, ip: string}} attempt
 * @returns {Promise<{accountRequests: number, ipRequests: number}>}
 */
async function recordResend({ email, ip }) {
  const windowSeconds = config.auth.loginWindowSeconds;
  const results = await redis
    .multi()
    .incr(resendAccountKey(email))
    .expire(resendAccountKey(email), windowSeconds, 'NX')
    .incr(resendIpKey(ip))
    .expire(resendIpKey(ip), windowSeconds, 'NX')
    .exec();
  return {
    accountRequests: results[0][1],
    ipRequests: results[2][1],
  };
}

module.exports = {
  check,
  recordFailure,
  resetAccount,
  checkResend,
  recordResend,
  accountKey,
  ipKey,
  resendAccountKey,
  resendIpKey,
  IP_ATTEMPT_MULTIPLIER,
  RESEND_MAX_ATTEMPTS,
};
