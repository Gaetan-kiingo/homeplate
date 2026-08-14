// tests/rt-lt-resilience/rt02-outbox.test.js — RT-02 (SRS §4.4; ADR-001/ADR-003).
//
// Verifier lane: outbox processing after a worker crash, duplicate-delivery idempotency,
// retry/backoff, and dead-letter handling — executed against the real PostgreSQL outbox,
// the real polling worker, the real email.verification handler and the real notification
// transport (mock adapter per ADR-011, asserting on persisted NOTIFICATION_ATTEMPT rows).
'use strict';

const crypto = require('crypto');

const outbox = require('../../src/outbox/outbox');
const { pollOnce, claimBatch, CLAIM_SQL } = require('../../src/outbox/worker');
const { loadHandlers, createRegistry } = require('../../src/outbox/dispatch');
const mockTransport = require('../../src/adapters/mockTransport');
const { withTransaction } = require('../../src/db/tx');

const dbh = require('../helpers/db');
const rh = require('../helpers/redis');
const { quietLogger, sleep } = require('./helpers');

const quiet = quietLogger();

async function enqueueJob(fields) {
  return withTransaction(async (client) => {
    const { job } = await outbox.enqueue(client, fields);
    return job;
  });
}

async function getJob(id) {
  const { rows } = await dbh.query(`SELECT * FROM outbox_jobs WHERE id = $1`, [id]);
  return rows[0];
}

async function makeDue(id) {
  await dbh.query(
    `UPDATE outbox_jobs SET available_at = now() - interval '1 second' WHERE id = $1`,
    [id]
  );
}

beforeAll(async () => {
  // Neutralize pending jobs left behind by other lane files (their types are not in the
  // registries used here) so claim/deliver counters are deterministic.
  await dbh.query(
    `UPDATE outbox_jobs SET status = 'delivered', delivered_at = now() WHERE status = 'pending'`
  );
});

afterAll(async () => {
  mockTransport.reset();
  await dbh.closeDb();
  await rh.closeTestRedis();
});

describe('RT-02 — crash recovery: a crashed worker releases its claim; the job is re-claimed and delivered exactly once', () => {
  test('claim is FOR UPDATE SKIP LOCKED held in an open transaction', () => {
    expect(CLAIM_SQL).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(CLAIM_SQL).toMatch(/status = 'pending'/);
  });

  test('backend termination mid-processing rolls the claim back; redelivery happens exactly once', async () => {
    let invocations = 0;
    const registry = createRegistry([
      {
        type: 'rt02.crash',
        handle: async () => {
          invocations += 1;
        },
      },
    ]);
    const job = await enqueueJob({ type: 'rt02.crash', payload: { entityId: 'rt02-crash-1' } });

    // Worker A claims the job and "crashes" while holding the row lock.
    const clientA = await dbh.getClient();
    // The terminated backend emits async 'error' events on this connection — expected in a
    // crash drill; swallow them so Jest does not treat the simulated crash as a test error.
    clientA.on('error', () => {});
    let pid;
    try {
      await clientA.query('BEGIN');
      const claimed = await claimBatch(clientA, { batchSize: 10 });
      expect(claimed.map((j) => j.id)).toContain(job.id);
      ({
        rows: [{ pid }],
      } = await clientA.query('SELECT pg_backend_pid() AS pid'));

      // While A holds the lock, a concurrent worker MUST NOT see the job (SKIP LOCKED).
      const statsWhileLocked = await pollOnce({ registry, log: quiet });
      expect(statsWhileLocked.claimed).toBe(0);
      expect(invocations).toBe(0);

      // Crash: terminate worker A's backend — its transaction rolls back server-side.
      await dbh.query('SELECT pg_terminate_backend($1)', [pid]);
      await sleep(100);
    } finally {
      try {
        clientA.release(new Error('rt02: simulated crash — discard broken connection'));
      } catch {
        /* connection already destroyed */
      }
    }

    // The claim auto-released: the job is still pending with NO attempt burned.
    const afterCrash = await getJob(job.id);
    expect(afterCrash.status).toBe('pending');
    expect(afterCrash.attempt_count).toBe(0);

    // A healthy worker re-claims and delivers exactly once.
    const stats = await pollOnce({ registry, log: quiet });
    expect(stats.delivered).toBe(1);
    expect(invocations).toBe(1);
    const delivered = await getJob(job.id);
    expect(delivered.status).toBe('delivered');
    expect(delivered.delivered_at).not.toBeNull();
  }, 20000);
});

describe('RT-02 — duplicate-delivery idempotency (dedupe key end-to-end through the real handler)', () => {
  test('duplicate enqueue is a no-op; redelivery after a lost commit does not double-send', async () => {
    mockTransport.reset();
    const registry = loadHandlers({ log: quiet }); // real handlers incl. email.verification
    const user = await dbh.makeUser();
    const tokenHash = crypto.createHash('sha256').update(`rt02-idem-${Date.now()}`).digest('hex');
    const dedupeKey = `rt02:email.verification:${tokenHash}`;

    const first = await withTransaction((c) =>
      outbox.enqueue(c, {
        type: 'email.verification',
        payload: { userId: user.id, tokenHash },
        dedupeKey,
      })
    );
    expect(first.deduped).toBe(false);

    // Idempotent enqueue: the same key again is a no-op returning the existing row.
    const second = await withTransaction((c) =>
      outbox.enqueue(c, {
        type: 'email.verification',
        payload: { userId: user.id, tokenHash },
        dedupeKey,
      })
    );
    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    const { rows: keyRows } = await dbh.query(
      `SELECT count(*)::int AS n FROM outbox_jobs WHERE dedupe_key = $1`,
      [dedupeKey]
    );
    expect(keyRows[0].n).toBe(1);

    // First delivery.
    const stats1 = await pollOnce({ registry, log: quiet });
    expect(stats1.delivered).toBe(1);
    expect(mockTransport.deliveries().filter((d) => d.userId === user.id)).toHaveLength(1);
    const { rows: attempts1 } = await dbh.query(
      `SELECT * FROM notification_attempts WHERE recipient_user_id = $1`,
      [user.id]
    );
    expect(attempts1).toHaveLength(1);
    expect(attempts1[0].status).toBe('sent');

    // Redelivery drill: simulate the crash-after-side-effect window (handler ran, but the
    // worker died before committing the 'delivered' status) by re-opening the job.
    await dbh.query(
      `UPDATE outbox_jobs SET status = 'pending', delivered_at = NULL, available_at = now()
       WHERE id = $1`,
      [first.job.id]
    );
    const stats2 = await pollOnce({ registry, log: quiet });
    expect(stats2.delivered).toBe(1); // job completes again…

    // …but the idempotency key made the side effect exactly-once:
    expect(mockTransport.deliveries().filter((d) => d.userId === user.id)).toHaveLength(1);
    const { rows: attempts2 } = await dbh.query(
      `SELECT * FROM notification_attempts WHERE recipient_user_id = $1`,
      [user.id]
    );
    expect(attempts2).toHaveLength(1);
    expect(attempts2[0].status).toBe('sent');
    expect(attempts2[0].attempt_count).toBe(attempts1[0].attempt_count); // no extra try burned
  }, 20000);
});

describe('RT-02 — retry with exponential backoff, dead-letter, requeue (NFR-09)', () => {
  test('failing job backs off exponentially, dead-letters at maxAttempts with its reason, and requeues', async () => {
    let fail = true;
    let invocations = 0;
    const registry = createRegistry([
      {
        type: 'rt02.retry',
        handle: async () => {
          invocations += 1;
          if (fail) throw new Error('rt02 injected provider outage');
        },
      },
    ]);
    const job = await enqueueJob({ type: 'rt02.retry', payload: { entityId: 'rt02-retry-1' } });

    const opts = {
      registry,
      maxAttempts: 4,
      backoffBaseMs: 200,
      backoffMaxMs: 60000,
      log: quiet,
    };

    const delays = [];
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      const stats = await pollOnce(opts);
      expect(stats.retried).toBe(1);
      const row = await getJob(job.id);
      expect(row.status).toBe('pending'); // still queued between retries
      expect(row.attempt_count).toBe(attempt);
      expect(row.last_error).toContain('rt02 injected provider outage');
      // Backoff = available_at − updated_at (both stamped from the same transaction clock).
      const delayMs = new Date(row.available_at).getTime() - new Date(row.updated_at).getTime();
      delays.push(delayMs);
      await makeDue(job.id);
    }
    // Exponential: 200, 400, 800 (±25% tolerance for clock granularity).
    expect(delays[0]).toBeGreaterThanOrEqual(150);
    expect(delays[0]).toBeLessThanOrEqual(250);
    expect(delays[1] / delays[0]).toBeGreaterThanOrEqual(1.5);
    expect(delays[1] / delays[0]).toBeLessThanOrEqual(2.5);
    expect(delays[2] / delays[1]).toBeGreaterThanOrEqual(1.5);
    expect(delays[2] / delays[1]).toBeLessThanOrEqual(2.5);

    // Attempt 4 of 4: dead-letter with the failure reason, queryable.
    const statsDead = await pollOnce(opts);
    expect(statsDead.deadLettered).toBe(1);
    const dead = await getJob(job.id);
    expect(dead.status).toBe('dead');
    expect(dead.attempt_count).toBe(4);
    expect(dead.last_error).toContain('rt02 injected provider outage');
    expect(invocations).toBe(4);

    const deadLetters = await outbox.listDeadLetters({ limit: 100 });
    expect(deadLetters.map((j) => j.id)).toContain(job.id);

    // No further claims while dead.
    const statsAfterDead = await pollOnce(opts);
    expect(statsAfterDead.claimed).toBe(0);

    // Operator requeues after fixing the fault → fresh budget → delivered.
    const requeued = await outbox.requeueDeadLetter(job.id);
    expect(requeued).not.toBeNull();
    expect(requeued.status).toBe('pending');
    expect(requeued.attempt_count).toBe(0);
    fail = false;
    const statsFixed = await pollOnce(opts);
    expect(statsFixed.delivered).toBe(1);
    expect((await getJob(job.id)).status).toBe('delivered');
    expect(invocations).toBe(5);
  }, 30000);
});

describe('RT-02 — two concurrent workers never double-process a job', () => {
  test('6 jobs, 2 workers polling concurrently: every job handled exactly once', async () => {
    const handled = new Map(); // jobId -> count
    const registry = createRegistry([
      {
        type: 'rt02.concurrent',
        handle: async (payload, ctx) => {
          handled.set(ctx.jobId, (handled.get(ctx.jobId) || 0) + 1);
          await sleep(120); // hold the claim long enough for real overlap
        },
      },
    ]);
    const jobs = [];
    for (let i = 0; i < 6; i += 1) {
      jobs.push(await enqueueJob({ type: 'rt02.concurrent', payload: { n: i } }));
    }

    const [a, b] = await Promise.all([
      pollOnce({ registry, batchSize: 3, log: quiet }),
      pollOnce({ registry, batchSize: 3, log: quiet }),
    ]);
    // Drain any remainder (in case one worker raced ahead before the other claimed).
    let drained = a.delivered + b.delivered;
    while (drained < 6) {
      const s = await pollOnce({ registry, batchSize: 3, log: quiet });
      if (s.claimed === 0) break;
      drained += s.delivered;
    }

    expect(handled.size).toBe(6);
    for (const [, count] of handled) expect(count).toBe(1); // never double-processed
    for (const job of jobs) {
      expect((await getJob(job.id)).status).toBe('delivered');
    }
  }, 30000);
});
