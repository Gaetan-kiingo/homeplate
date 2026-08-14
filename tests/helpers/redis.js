// tests/helpers/redis.js — U1-DB: shared Redis test harness. tests/helpers/env.js has already
// pointed REDIS_URL at the isolated test DB index (…/1), so flushing here can never clear dev
// sessions (SRS §4.1 reproducibility; SRS §2.4 — Redis is sessions + read cache only).
//
// Public surface for sibling units' tests:
//   redis / key      — the app's own client + namespacing (src/db/redis.js), re-exported
//   flushTestRedis() — FLUSHDB on the isolated test index (guarded to NODE_ENV=test)
//   flushNamespace(ns) — delete only 'hp:<ns>:*' keys (e.g. one lane's cache between tests)
//   closeTestRedis() — quit the shared client (call from afterAll so Jest can exit cleanly)
'use strict';

const { redis, key, closeRedis } = require('../../src/db/redis');

function assertTestEnv() {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('tests/helpers/redis.js may only run under NODE_ENV=test');
  }
}

/** Flush the entire isolated test Redis DB index. */
async function flushTestRedis() {
  assertTestEnv();
  await redis.flushdb();
}

/**
 * Delete every key in one Homeplate namespace ('hp:<ns>:*') without touching the rest —
 * lets a test clear, say, the cache namespace while another lane's session fixtures survive.
 * @param {string} ns
 * @returns {Promise<number>} keys deleted
 */
async function flushNamespace(ns) {
  assertTestEnv();
  if (typeof ns !== 'string' || ns.length === 0) {
    throw new TypeError('flushNamespace(ns): ns must be a non-empty string');
  }
  let deleted = 0;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `hp:${ns}:*`, 'COUNT', 200);
    cursor = next;
    if (keys.length > 0) {
      deleted += await redis.del(...keys);
    }
  } while (cursor !== '0');
  return deleted;
}

/** Quit the shared client so Jest exits without open-handle warnings. */
async function closeTestRedis() {
  await closeRedis();
}

module.exports = { redis, key, flushTestRedis, flushNamespace, closeTestRedis };
