// src/outbox/outbox.js — U2-OUTBOX: transactional enqueue (the ONLY way deferred work is
// created) plus dead-letter visibility helpers.
//
// Requirement traceability (SRS Appendix B):
//   FR-13  — enqueue(client, …) writes the outbox row on the SAME client/transaction as the
//            business write (ADR-001/003 "no dual writes"): both commit or neither does. A
//            notification-provider failure therefore never rolls back or delays a booking.
//   NFR-09 — deferred actions are persisted here and executed later by the worker, so an
//            external-service outage defers work instead of failing the triggering request.
//   NFR-08 — the originating request's correlation ID (src/middleware/requestContext) is
//            stamped onto the row so the worker's log lines carry the same ID (MT-01).
//   RT-02  — dedupeKey is the idempotency key: a duplicate enqueue is a no-op, and the worker
//            hands the key to handlers so redelivery after a crash stays exactly-once.
//
// ADR-003 payload rule: payloads carry entity IDs only — NEVER raw personal data. enqueue()
// REJECTS payloads containing an email-, phone- or name-shaped key or value (defence in depth;
// the adr-conformance lane audits stored payloads too).
//
// Public interface (build-plan wave-2 contract):
//   await enqueue(client, { type, payload, dedupeKey, availableAt })
//     → { job, deduped } — `client` MUST be the transaction client the business write used
//       (the one src/db/tx.js withTransaction passes to its callback); passing the pool is an
//       error because that would be a dual write.
//   await listDeadLetters({ limit })      → dead-lettered jobs, newest first (NFR-09 visibility)
//   await requeueDeadLetter(jobId)        → re-opens a dead job with a fresh retry budget
'use strict';

const { Pool } = require('pg');
const { isPiiKey } = require('../lib/logger');
const requestContext = require('../middleware/requestContext');
const pooled = require('../db/pool');

// Job type: handler-registry key, e.g. 'notification.emailVerification'. Bounded and shaped
// so a typo'd or injected value fails at enqueue time, not in the worker.
const TYPE_PATTERN = /^[a-z][a-z0-9_.-]{0,199}$/i;

// Email-shaped substring anywhere in a string value (mirrors src/lib/logger's scrubber).
const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
// Phone-shaped WHOLE string value: optional +, then 7–20 digits/separators with 7–15 digits
// total. ISO dates ('2030-06-01') are explicitly excluded; UUIDs never match (hex letters).
const PHONE_CHARS = /^\+?[0-9\s().-]{7,20}$/;
const ISO_DATE_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

function looksLikeEmail(value) {
  return EMAIL_SHAPE.test(value);
}

function looksLikePhone(value) {
  if (ISO_DATE_SHAPE.test(value)) return false;
  if (!PHONE_CHARS.test(value)) return false;
  const digits = value.replace(/\D/g, '');
  return digits.length >= 7 && digits.length <= 15;
}

/**
 * Walk a JSON-normalized payload and collect every PII-shaped key or value (ADR-003:
 * IDs only). Key detection reuses src/lib/logger's isPiiKey — the same email/phone/name/
 * secret vocabulary the log redactor uses — so the two guards can never drift apart.
 */
function collectPiiProblems(value, keyPath, problems) {
  if (typeof value === 'string') {
    if (looksLikeEmail(value)) {
      problems.push(`${keyPath || 'payload'}: value is email-shaped`);
    } else if (looksLikePhone(value)) {
      problems.push(`${keyPath || 'payload'}: value is phone-shaped`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectPiiProblems(item, `${keyPath}[${index}]`, problems));
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      const childPath = keyPath ? `${keyPath}.${key}` : key;
      if (isPiiKey(key)) {
        problems.push(`${childPath}: key is PII-shaped (email/phone/name/secret)`);
        continue; // the key alone is disqualifying; no need to scan beneath it
      }
      collectPiiProblems(entry, childPath, problems);
    }
  }
}

function piiError(problems) {
  const err = new Error(
    'outbox enqueue rejected: payloads carry IDs only, never raw personal data (ADR-003). ' +
      `Offending fields: ${problems.join('; ')}`
  );
  err.code = 'OUTBOX_PAYLOAD_PII';
  return err;
}

/**
 * Validate and JSON-normalize a payload (Dates become ISO strings, undefined entries drop,
 * circular structures throw), then reject any email/phone/name-shaped key or value.
 * @returns {object} the normalized payload safe to persist as jsonb
 */
function assertIdOnlyPayload(payload) {
  if (Object.prototype.toString.call(payload) !== '[object Object]') {
    throw new TypeError('outbox enqueue: payload must be a plain JSON object');
  }
  let normalized;
  try {
    normalized = JSON.parse(JSON.stringify(payload));
  } catch (err) {
    throw new TypeError(`outbox enqueue: payload must be JSON-serializable (${err.message})`);
  }
  const problems = [];
  collectPiiProblems(normalized, '', problems);
  if (problems.length > 0) throw piiError(problems);
  return normalized;
}

/**
 * The transaction-client guard (ADR-001/003). enqueue must run on the SAME client as the
 * business write; the pool (or the pool module) auto-commits each statement, which would be
 * a dual write. A checked-out PoolClient is recognizable by its release() method.
 */
function assertTransactionClient(client) {
  if (client instanceof Pool || client === pooled.pool || client === pooled) {
    throw new TypeError(
      'outbox enqueue: received the connection pool — pass the TRANSACTION client the ' +
        'business write used (withTransaction hands it to your callback). ADR-001/003: the ' +
        'business row and the outbox row must commit in the same transaction.'
    );
  }
  if (!client || typeof client.query !== 'function' || typeof client.release !== 'function') {
    throw new TypeError(
      'outbox enqueue: first argument must be a checked-out pg client (from withTransaction)'
    );
  }
}

/**
 * Enqueue a deferred job in the caller's transaction (FR-13, ADR-001/003).
 *
 * @param {import('pg').PoolClient} client  The SAME client the business write used.
 * @param {object} options
 * @param {string} options.type        Handler type (src/outbox/handlers/*.js contract).
 * @param {object} [options.payload]   IDs-only JSON payload (PII-shaped content is rejected).
 * @param {string} [options.dedupeKey] Idempotency key: at most one job row ever exists per
 *                                     key; a duplicate enqueue returns the existing job.
 * @param {Date|string} [options.availableAt]  Earliest execution time (default: now).
 * @returns {Promise<{job: object, deduped: boolean}>} the outbox row as persisted.
 */
async function enqueue(client, { type, payload = {}, dedupeKey, availableAt } = {}) {
  assertTransactionClient(client);
  if (typeof type !== 'string' || !TYPE_PATTERN.test(type)) {
    throw new TypeError(
      'outbox enqueue: type must be a short identifier string (e.g. "notification.bookingCreated")'
    );
  }
  if (dedupeKey !== undefined && dedupeKey !== null) {
    if (typeof dedupeKey !== 'string' || dedupeKey.length === 0 || dedupeKey.length > 300) {
      throw new TypeError('outbox enqueue: dedupeKey must be a non-empty string (max 300 chars)');
    }
    if (looksLikeEmail(dedupeKey)) {
      throw piiError(['dedupeKey: value is email-shaped']);
    }
  }
  let available = null;
  if (availableAt !== undefined && availableAt !== null) {
    available = availableAt instanceof Date ? availableAt : new Date(availableAt);
    if (Number.isNaN(available.getTime())) {
      throw new TypeError('outbox enqueue: availableAt must be a Date or a parseable timestamp');
    }
  }
  const normalizedPayload = assertIdOnlyPayload(payload);
  // NFR-08: carry the originating request's correlation ID to the worker's log lines.
  const correlationId = requestContext.getCorrelationId() || null;

  const insert = await client.query(
    `INSERT INTO outbox_jobs (type, payload, correlation_id, dedupe_key, available_at)
     VALUES ($1, $2::jsonb, $3, $4, COALESCE($5, now()))
     ON CONFLICT (dedupe_key) DO NOTHING
     RETURNING *`,
    [type, JSON.stringify(normalizedPayload), correlationId, dedupeKey ?? null, available]
  );
  if (insert.rows.length > 0) {
    return { job: insert.rows[0], deduped: false };
  }
  // Idempotent enqueue: the key already has a job row — return it unchanged (RT-02).
  const existing = await client.query('SELECT * FROM outbox_jobs WHERE dedupe_key = $1', [
    dedupeKey,
  ]);
  if (existing.rows.length === 0) {
    // Unique-conflict with no surviving row can only mean concurrent delete — surface it.
    throw new Error(`outbox enqueue: dedupe conflict but no existing job for key "${dedupeKey}"`);
  }
  return { job: existing.rows[0], deduped: true };
}

/**
 * Dead-letter visibility (NFR-09): jobs whose retry budget is exhausted, newest first,
 * each carrying its failure reason in last_error. Queryable at any time.
 */
async function listDeadLetters({ limit = 100 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
    throw new TypeError('listDeadLetters: limit must be an integer in 1..1000');
  }
  const { rows } = await pooled.query(
    `SELECT * FROM outbox_jobs WHERE status = 'dead' ORDER BY created_at DESC, id DESC LIMIT $1`,
    [limit]
  );
  return rows;
}

/**
 * Re-open a dead-lettered job with a fresh retry budget (operator action after fixing the
 * underlying fault). last_error is kept until the next attempt overwrites it.
 * @returns {Promise<object|null>} the requeued row, or null if the job is not dead-lettered.
 */
async function requeueDeadLetter(jobId) {
  const { rows } = await pooled.query(
    `UPDATE outbox_jobs
     SET status = 'pending', attempt_count = 0, available_at = now(), delivered_at = NULL
     WHERE id = $1 AND status = 'dead'
     RETURNING *`,
    [jobId]
  );
  return rows[0] || null;
}

module.exports = {
  enqueue,
  listDeadLetters,
  requeueDeadLetter,
  // exported for the unit tests that pin the guard behaviour
  assertIdOnlyPayload,
};
