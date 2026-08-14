// src/modules/auth/sessions.js — U2-IDENTITY: opaque Redis-backed sessions (ADR-006).
//
// Requirement / decision traceability (SRS Appendix B):
//   AB-05 (ST-03) — session tokens are OPAQUE, 256 bits of CSPRNG entropy (>= the 128-bit
//                   floor AB-05 demands), delivered ONLY in an HttpOnly + Secure +
//                   SameSite=Lax cookie; the server stores a SHA-256 digest of the token,
//                   so a Redis dump yields no usable tokens. Logout deletes the Redis
//                   record — the token is unusable from that instant.
//   NFR-03        — the cookie is always flagged Secure; the transport layer (U1-HTTP)
//                   refuses plain HTTP, so the cookie only ever travels over TLS 1.2+.
//   ADR-001/006   — Redis holds SESSIONS and read cache only. A session is by definition
//                   loseable state: a Redis flush logs users out, changes no booking,
//                   listing or moderation outcome, and PostgreSQL remains source of truth.
//
// Redis layout: key hp:session:<sha256(token) hex> → JSON { userId, roles, createdAt },
// EX config.auth.sessionTtlSeconds. The digest doubles as the sessionId exposed on
// req.auth (safe to log — it cannot be inverted to the cookie token).
'use strict';

const crypto = require('crypto');
const config = require('../../config');
const { redis, key } = require('../../db/redis');

const TOKEN_BYTES = 32; // 256 bits of entropy (AB-05: >= 128 required, >= 256 delivered)

/** SHA-256 hex digest of a session token — the Redis key part AND the loggable sessionId. */
function sessionIdFor(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function redisKeyFor(sessionId) {
  return key('session', sessionId);
}

/**
 * Create a session for a user: mint a 256-bit opaque token, store its record in Redis
 * with the configured TTL, and return the token for cookie delivery.
 * @param {{id: string, roles?: string[]}} user  users row (id + roles)
 * @returns {Promise<{token: string, sessionId: string, ttlSeconds: number}>}
 */
async function createSession(user) {
  if (!user || typeof user.id !== 'string') {
    throw new TypeError('createSession(user): user.id is required');
  }
  const token = crypto.randomBytes(TOKEN_BYTES).toString('base64url');
  const sessionId = sessionIdFor(token);
  const ttlSeconds = config.auth.sessionTtlSeconds;
  const record = JSON.stringify({
    userId: user.id,
    roles: Array.isArray(user.roles) ? user.roles : ['user'],
    createdAt: new Date().toISOString(),
  });
  await redis.set(redisKeyFor(sessionId), record, 'EX', ttlSeconds);
  return { token, sessionId, ttlSeconds };
}

/**
 * Resolve a cookie token to its session, or null when absent/expired/destroyed.
 * @param {string} token
 * @returns {Promise<{userId: string, sessionId: string, roles: string[]} | null>}
 */
async function getSession(token) {
  if (typeof token !== 'string' || token.length === 0) return null;
  const sessionId = sessionIdFor(token);
  const raw = await redis.get(redisKeyFor(sessionId));
  if (raw === null) return null;
  let record;
  try {
    record = JSON.parse(raw);
  } catch (_corruptRecord) {
    // A corrupt session record is unusable — treat as no session (fail closed).
    await redis.del(redisKeyFor(sessionId));
    return null;
  }
  return {
    userId: record.userId,
    sessionId,
    roles: Array.isArray(record.roles) ? record.roles : ['user'],
  };
}

/**
 * Destroy the session behind a cookie token (logout — AB-05: the token is unusable
 * immediately afterwards).
 * @param {string} token
 * @returns {Promise<boolean>} true when a live session was deleted
 */
async function destroySession(token) {
  if (typeof token !== 'string' || token.length === 0) return false;
  const deleted = await redis.del(redisKeyFor(sessionIdFor(token)));
  return deleted > 0;
}

/**
 * Set the session cookie on a response (AB-05: HttpOnly + Secure + SameSite=Lax, no JS
 * access, no cross-site send; maxAge mirrors the Redis TTL so cookie and record expire
 * together).
 * @param {import('express').Response} res
 * @param {string} token
 * @param {number} ttlSeconds
 */
function setSessionCookie(res, token, ttlSeconds = config.auth.sessionTtlSeconds) {
  res.cookie(config.auth.sessionCookieName, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: ttlSeconds * 1000,
  });
}

/** Clear the session cookie (logout). Attributes must match setSessionCookie's. */
function clearSessionCookie(res) {
  res.clearCookie(config.auth.sessionCookieName, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
  });
}

/** Read the raw session token from a parsed request (cookie-parser is mounted by U1-HTTP). */
function tokenFromRequest(req) {
  const token = req.cookies && req.cookies[config.auth.sessionCookieName];
  return typeof token === 'string' && token.length > 0 ? token : null;
}

module.exports = {
  createSession,
  getSession,
  destroySession,
  setSessionCookie,
  clearSessionCookie,
  tokenFromRequest,
  sessionIdFor,
  TOKEN_BYTES,
};
