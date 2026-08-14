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
'use strict';

const crypto = require('crypto');
const config = require('../../config');
const { redis, key } = require('../../db/redis');

// The per-IP threshold is a multiple of the per-account one: strict enough to stop scripted
// account-cycling (AB-05) while one shared NAT of legitimate users failing occasionally does
// not lock everyone out. The NFR-05 "5 in 10 minutes" bound applies to the ACCOUNT counter;
// this multiplier is an internal defence parameter, not a jurisdiction cap (ADR-009 scope).
const IP_ATTEMPT_MULTIPLIER = 10;

function accountKey(email) {
  const digest = crypto.createHash('sha256').update(String(email).toLowerCase(), 'utf8');
  return key('ratelimit', 'login', 'acct', digest.digest('hex'));
}

function ipKey(ip) {
  return key('ratelimit', 'login', 'ip', String(ip));
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

module.exports = {
  check,
  recordFailure,
  resetAccount,
  accountKey,
  ipKey,
  IP_ATTEMPT_MULTIPLIER,
};
