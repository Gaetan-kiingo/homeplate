// src/db/redis.js — U1-DB: the single Redis client + key namespacing.
//
// SRS §2.4 / ADR-001 / ADR-006: Redis holds SESSIONS and READ CACHE ONLY — never business
// state whose loss would change a booking, listing or moderation outcome. Anything that must
// survive a Redis flush belongs in PostgreSQL.
//
// Requirement traceability (SRS Appendix B):
//   NFR-01 — read cache substrate (src/lib/cache.js builds on this client)
//   NFR-05 — login rate-limit counters live here (U2-IDENTITY)
//   NFR-09 — commands fail fast (bounded retries) so a Redis outage degrades reads instead of
//            hanging requests; ADR-005's cached results are the degraded-mode fallback
//   ADR-010 — cache keys built through key() carry PUBLIC-precision payloads only (enforced by
//            the writers; the shared prefix makes the conformance lane's audit scan possible)
//
// Public interface (build-plan wave-1 contract):
//   redis            — shared ioredis instance (lazy-connects on first command)
//   key(ns, ...parts) — 'hp:<ns>:<part>:…' — ALL Homeplate keys go through this
//   closeRedis()     — quit (tests, graceful shutdown)
//   retryStrategy(attempt) — the NFR-09 bounded reconnect backoff (exported for tests)
'use strict';

const Redis = require('ioredis');
const config = require('../config');

/**
 * Bounded reconnect backoff (NFR-09): 200 ms per prior attempt, capped at 5 s, and it
 * NEVER returns undefined/null — that would tell ioredis to stop reconnecting, turning a
 * transient outage into a permanent one. Explicit (not ioredis's implicit default) so the
 * degraded-mode policy is application code that tests/unit/db.test.js executes directly.
 * @param {number} attempt — 1-based reconnect attempt count supplied by ioredis
 * @returns {number} milliseconds to wait before the next reconnect attempt
 */
function retryStrategy(attempt) {
  return Math.min(attempt * 200, 5_000);
}

const redis = new Redis(config.redis.url, {
  // Connect on first command: importing this module never blocks on infra.
  lazyConnect: true,
  connectTimeout: 4_000,
  // Fail fast instead of queueing forever — a Redis outage must degrade, not hang (NFR-09).
  maxRetriesPerRequest: 2,
  retryStrategy,
});

// ioredis emits 'error' on connection trouble; an unhandled 'error' event kills the process.
// The reconnect strategy keeps trying in the background — callers just see failed commands.
redis.on('error', (err) => {
  logWarn('redis: connection error (commands fail fast until it recovers)', err);
});

let _logger;
function logWarn(msg, err) {
  if (_logger === undefined) {
    try {
      // U1-OBS shared instance (module exports { logger, ... }); fallback below for isolation.
      _logger = require('../lib/logger').logger || null;
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

/**
 * Build a namespaced Redis key: key('session', sid) → 'hp:session:<sid>'.
 * Every Homeplate key uses this helper so namespaces never collide and the adr-conformance
 * lane can enumerate cache contents by prefix (ADR-010 public-precision audit).
 * @param {string} ns — namespace, e.g. 'session', 'cache', 'ratelimit'
 * @param {...(string|number)} parts — at least one identifying part
 * @returns {string}
 */
function key(ns, ...parts) {
  if (typeof ns !== 'string' || ns.length === 0) {
    throw new TypeError('redis key(): namespace must be a non-empty string');
  }
  if (parts.length === 0) {
    throw new TypeError('redis key(): at least one key part is required');
  }
  const rendered = parts.map((p) => {
    if ((typeof p !== 'string' && typeof p !== 'number') || p === '') {
      throw new TypeError(`redis key(): invalid key part ${JSON.stringify(p)}`);
    }
    return String(p);
  });
  return `hp:${ns}:${rendered.join(':')}`;
}

/** Graceful shutdown: QUIT if connected, hard-disconnect otherwise. */
async function closeRedis() {
  try {
    await redis.quit();
  } catch {
    redis.disconnect();
  }
}

module.exports = { redis, key, closeRedis, retryStrategy };
