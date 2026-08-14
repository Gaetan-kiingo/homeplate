// src/outbox/worker.js — U2-OUTBOX: the polling worker — claim, execute, retry/backoff,
// dead-letter (ADR-001/003 deferred-work mechanism; SPMP WA-3/WA-10).
//
// Requirement traceability (SRS Appendix B):
//   FR-13  — booking (and other) notifications enqueued transactionally are delivered here,
//            OUTSIDE the request path, so a provider failure never touches the business
//            transaction. Retries are bounded by config.outbox.maxAttempts, then the job
//            dead-letters with its failure reason, still queryable (outbox.listDeadLetters).
//   NFR-09 — an external-service outage makes handler calls fail; the affected jobs back off
//            exponentially (config.outbox.backoffBaseMs, doubling, capped at backoffMaxMs)
//            and complete once the service recovers. Non-critical work is deferred, never lost.
//   NFR-08 — every worker log line for a job carries the ORIGINATING request's correlation ID
//            (stamped on the row by enqueue); handlers run inside requestContext.run so any
//            code they call sees the same ID (MT-01: same ID on both sides).
//   RT-02  — claim semantics: FOR UPDATE SKIP LOCKED with the lock held for the duration of
//            processing. Two concurrent workers can never double-process a row; a worker that
//            crashes mid-job rolls back its claim, the row stays 'pending' and is re-claimed.
//            Redelivery is made exactly-once by the idempotency key handed to handlers
//            (ctx.idempotencyKey = dedupe_key, or a stable per-job key when none was given).
//
// Public interface (build-plan wave-2 contract):
//   pollOnce({ registry, batchSize, maxAttempts, backoffBaseMs, backoffMaxMs, log })
//     → { claimed, delivered, retried, deadLettered }   (one claim-execute-commit cycle)
//   claimBatch(client, { batchSize })  → locked pending rows (exported for RT-02 tests)
//   startWorker({ registry, pollIntervalMs, … })  → { stop() }   (the polling loop;
//     scripts/worker.js runs it standalone, npm run dev runs it next to the API)
'use strict';

const crypto = require('crypto');
const config = require('../config');
const { withTransaction } = require('../db/tx');
const { computeBackoffDelay } = require('../lib/resilience');
const { logger: baseLogger } = require('../lib/logger');
const requestContext = require('../middleware/requestContext');

// The claim: due pending jobs, oldest due first, row-locked and invisible to concurrent
// claimers (FOR UPDATE SKIP LOCKED — RT-02). The lock is held while the handler runs; a
// crash rolls the claim back and the job is re-claimed on the next poll.
const CLAIM_SQL = `
  SELECT * FROM outbox_jobs
  WHERE status = 'pending' AND available_at <= now()
  ORDER BY available_at, id
  FOR UPDATE SKIP LOCKED
  LIMIT $1
`;

/**
 * Claim up to batchSize due jobs on `client` (which must be inside an open transaction —
 * the returned rows stay locked until that transaction ends).
 */
async function claimBatch(client, { batchSize = config.outbox.batchSize } = {}) {
  if (!client || typeof client.query !== 'function') {
    throw new TypeError('claimBatch(client, …): client must be a pg client inside a transaction');
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new TypeError('claimBatch: batchSize must be a positive integer');
  }
  const { rows } = await client.query(CLAIM_SQL, [batchSize]);
  return rows;
}

/**
 * Execute one CLAIMED job and record its outcome on the claim client (same transaction that
 * holds the row lock). Returns 'delivered' | 'retried' | 'deadLettered'.
 */
async function processClaimedJob(
  client,
  job,
  { registry, maxAttempts, backoffBaseMs, backoffMaxMs, log }
) {
  const attempt = job.attempt_count + 1;
  // NFR-08: the originating request's correlation ID; a fresh one only if none was stamped.
  const correlationId = job.correlation_id || crypto.randomUUID();
  const jobLog = log.child({
    correlationId,
    jobId: String(job.id),
    jobType: job.type,
    attempt,
  });
  try {
    const handler = registry.get(job.type);
    if (!handler) {
      // Retryable: the handler may be registered by a later deploy; dead-letters at the cap.
      throw new Error(`no outbox handler registered for job type "${job.type}"`);
    }
    const ctx = {
      jobId: String(job.id),
      type: job.type,
      attempt,
      correlationId,
      // RT-02: handlers key their side effects on this so redelivery is exactly-once.
      idempotencyKey: job.dedupe_key || `outbox:${job.id}`,
      log: jobLog,
    };
    // requestContext.run scopes the job like a request: code the handler calls (transports,
    // repos) reads the SAME correlation ID via requestContext.getCorrelationId() (NFR-08).
    await requestContext.run({ correlationId, log: jobLog }, () =>
      handler.handle(job.payload, ctx)
    );
    await client.query(
      `UPDATE outbox_jobs
       SET status = 'delivered', attempt_count = $2, delivered_at = now(), last_error = NULL
       WHERE id = $1`,
      [job.id, attempt]
    );
    jobLog.info({ event: 'outbox_job_delivered' }, 'outbox_job_delivered');
    return 'delivered';
  } catch (err) {
    const reason = (err && err.message) || String(err);
    if (attempt >= maxAttempts) {
      // Dead-letter: budget exhausted. The row stays queryable with its failure reason
      // (NFR-09 visibility); outbox.requeueDeadLetter re-opens it after the fault is fixed.
      await client.query(
        `UPDATE outbox_jobs SET status = 'dead', attempt_count = $2, last_error = $3 WHERE id = $1`,
        [job.id, attempt, reason]
      );
      jobLog.error({ event: 'outbox_job_dead_letter', err, maxAttempts }, 'outbox_job_dead_letter');
      return 'deadLettered';
    }
    // Exponential backoff: baseMs × 2^(attempt-1), capped (NFR-09 bounded retries).
    const delayMs = computeBackoffDelay(attempt, {
      baseMs: backoffBaseMs,
      factor: 2,
      maxMs: backoffMaxMs,
    });
    await client.query(
      `UPDATE outbox_jobs
       SET attempt_count = $2,
           available_at = now() + ($3::bigint * interval '1 millisecond'),
           last_error = $4
       WHERE id = $1`,
      [job.id, attempt, delayMs, reason]
    );
    jobLog.warn({ event: 'outbox_job_retry', err, delayMs, maxAttempts }, 'outbox_job_retry');
    return 'retried';
  }
}

/**
 * One poll cycle: claim a batch under FOR UPDATE SKIP LOCKED, run each job's handler, record
 * outcomes, commit. Runs on its own transaction via withTransaction (U1-DB), so a worker
 * crash mid-cycle rolls the claim back and every in-flight job is re-claimed (RT-02).
 *
 * @returns {Promise<{claimed:number, delivered:number, retried:number, deadLettered:number}>}
 */
async function pollOnce(options = {}) {
  const {
    registry,
    batchSize = config.outbox.batchSize,
    maxAttempts = config.outbox.maxAttempts,
    backoffBaseMs = config.outbox.backoffBaseMs,
    backoffMaxMs = config.outbox.backoffMaxMs,
    log = baseLogger,
  } = options;
  if (!registry || typeof registry.get !== 'function') {
    throw new TypeError('pollOnce: options.registry is required (dispatch.loadHandlers())');
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new TypeError('pollOnce: maxAttempts must be a positive integer');
  }
  return withTransaction(async (client) => {
    const stats = { claimed: 0, delivered: 0, retried: 0, deadLettered: 0 };
    const jobs = await claimBatch(client, { batchSize });
    stats.claimed = jobs.length;
    for (const job of jobs) {
      const outcome = await processClaimedJob(client, job, {
        registry,
        maxAttempts,
        backoffBaseMs,
        backoffMaxMs,
        log,
      });
      stats[outcome] += 1;
    }
    return stats;
  });
}

/**
 * The polling loop. Polls every pollIntervalMs; after a cycle that claimed work it polls
 * again immediately (drain), so a burst clears at batch speed while an idle worker costs one
 * cheap indexed query per interval. A failing poll (e.g. PostgreSQL restart) is logged and
 * retried on the next interval — the loop never dies (NFR-09).
 *
 * @returns {{ stop(): Promise<void> }} stop() halts scheduling and awaits the in-flight poll.
 */
function startWorker(options = {}) {
  const {
    registry,
    pollIntervalMs = config.outbox.pollIntervalMs,
    log = baseLogger,
    ...pollOptions
  } = options;
  if (!registry || typeof registry.get !== 'function') {
    throw new TypeError('startWorker: options.registry is required (dispatch.loadHandlers())');
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 1) {
    throw new TypeError('startWorker: pollIntervalMs must be a positive integer');
  }

  let stopped = false;
  let timer = null;
  let inFlight = null;

  async function tick() {
    if (stopped) return;
    inFlight = (async () => {
      try {
        return await pollOnce({ registry, log, ...pollOptions });
      } catch (err) {
        log.error({ event: 'outbox_poll_error', err }, 'outbox_poll_error');
        return null;
      }
    })();
    const stats = await inFlight;
    inFlight = null;
    if (stopped) return;
    const delayMs = stats && stats.claimed > 0 ? 0 : pollIntervalMs;
    timer = setTimeout(tick, delayMs);
  }

  log.info(
    { event: 'outbox_worker_started', pollIntervalMs, handlerTypes: registry.types() },
    'outbox_worker_started'
  );
  timer = setTimeout(tick, 0);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight;
      log.info({ event: 'outbox_worker_stopped' }, 'outbox_worker_stopped');
    },
  };
}

module.exports = { pollOnce, claimBatch, startWorker, CLAIM_SQL };
