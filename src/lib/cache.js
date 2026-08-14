// src/lib/cache.js — U1-DB: Redis-backed read cache (SRS §2.4: Redis is sessions + READ CACHE
// only — cached values are always recomputable from PostgreSQL).
//
// Requirement traceability (SRS Appendix B):
//   NFR-01 — hot read paths (search results, geocoding) serve from this cache
//   NFR-09 — DEGRADED MODE BY CONSTRUCTION: every Redis failure is swallowed and logged;
//            get() reports a miss, wrap() falls through to the loader — a cache outage slows
//            reads down, it never breaks them. Only programmer errors (bad key/TTL) throw.
//   ADR-005 — the Maps adapter's Redis result cache is exactly this helper; those cached
//            results are the NFR-09 fallback when Google Maps is down
//   ADR-010 — precision discipline: WRITERS must only cache public-precision payloads
//            (coarse coordinates + area label). This helper is generic; the conformance lane
//            audits cache contents via the shared key prefix (src/db/redis.js key()).
//
// Public interface (build-plan wave-1 contract): { get, set, wrap(key, ttl, fn), del }.
// Values are JSON-serialized. A cached `null` is a legitimate HIT (negative caching);
// `undefined` is the miss signal and is never stored.
'use strict';

const { redis } = require('../db/redis');

let _logger;
function logWarn(msg, err) {
  if (_logger === undefined) {
    try {
      _logger = require('./logger'); // U1-OBS wave-1 module; console fallback for isolation
    } catch {
      _logger = null;
    }
  }
  if (_logger && typeof _logger.warn === 'function') {
    _logger.warn({ err: err.message }, msg);
  } else {
    console.warn(`${msg}: ${err.message}`);
  }
}

function assertKey(cacheKey) {
  if (typeof cacheKey !== 'string' || cacheKey.length === 0) {
    throw new TypeError('cache: key must be a non-empty string (use redis key(ns, ...parts))');
  }
}

function assertTtl(ttlSeconds) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new TypeError('cache: ttlSeconds must be a positive integer');
  }
}

/**
 * Read a cached value.
 * @param {string} cacheKey
 * @returns {Promise<*>} the cached value (may be null), or `undefined` on miss OR Redis failure
 */
async function get(cacheKey) {
  assertKey(cacheKey);
  try {
    const raw = await redis.get(cacheKey);
    if (raw === null) return undefined; // miss
    return JSON.parse(raw);
  } catch (err) {
    logWarn(`cache.get degraded (miss) for ${cacheKey}`, err); // NFR-09
    return undefined;
  }
}

/**
 * Store a value with a TTL. Failures are logged and swallowed (NFR-09) — the source of truth
 * is PostgreSQL, so a failed cache write costs latency, not correctness.
 * @param {string} cacheKey
 * @param {*} value — JSON-serializable; `undefined` is rejected (it is the miss signal)
 * @param {number} ttlSeconds — positive integer; expiry is enforced by Redis EX
 * @returns {Promise<boolean>} true if the write reached Redis
 */
async function set(cacheKey, value, ttlSeconds) {
  assertKey(cacheKey);
  assertTtl(ttlSeconds);
  if (value === undefined) {
    throw new TypeError('cache.set: value must not be undefined (use del to remove a key)');
  }
  try {
    await redis.set(cacheKey, JSON.stringify(value), 'EX', ttlSeconds);
    return true;
  } catch (err) {
    logWarn(`cache.set degraded (skipped) for ${cacheKey}`, err); // NFR-09
    return false;
  }
}

/**
 * Read-through caching: serve the cached value on hit; on miss, run `fn`, cache its result
 * with the TTL, and return it. If Redis is down, `fn` still runs — degraded, never broken.
 * @param {string} cacheKey
 * @param {number} ttlSeconds
 * @param {() => Promise<*>} fn — loader hitting the source of truth; its `undefined` result
 *   is returned but never cached
 * @returns {Promise<*>}
 */
async function wrap(cacheKey, ttlSeconds, fn) {
  assertKey(cacheKey);
  assertTtl(ttlSeconds);
  if (typeof fn !== 'function') {
    throw new TypeError('cache.wrap: fn must be a function');
  }
  const hit = await get(cacheKey);
  if (hit !== undefined) return hit;
  const value = await fn();
  if (value !== undefined) {
    await set(cacheKey, value, ttlSeconds);
  }
  return value;
}

/**
 * Invalidate a key. Failures are logged and swallowed — a missed invalidation ages out via TTL.
 * @param {string} cacheKey
 * @returns {Promise<boolean>} true if the delete reached Redis
 */
async function del(cacheKey) {
  assertKey(cacheKey);
  try {
    await redis.del(cacheKey);
    return true;
  } catch (err) {
    logWarn(`cache.del degraded (skipped) for ${cacheKey}`, err); // NFR-09
    return false;
  }
}

module.exports = { get, set, wrap, del };
