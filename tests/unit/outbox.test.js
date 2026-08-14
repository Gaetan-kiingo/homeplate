// tests/unit/outbox.test.js — U2-OUTBOX acceptance tests (SPMP WA-3/WA-10).
//
// Requirement traceability (SRS Appendix B):
//   FR-13  — enqueue writes the outbox row in the SAME transaction as the business write:
//            a forced post-insert error leaves ZERO rows of both (atomicity); payloads carry
//            IDs only — email/phone/name-shaped content is rejected (ADR-003).
//   NFR-09 — bounded retries with exponential backoff up to config.outbox.maxAttempts, then
//            dead-letter with the failure reason, still queryable; requeue re-opens the job.
//   NFR-08 — the originating request's correlation ID is stamped on the row and appears in
//            the worker's structured log lines and in handler ctx (MT-01 both-sides check).
//   RT-02  — FOR UPDATE SKIP LOCKED claims: two concurrent workers never double-process; a
//            crashed claim (backend killed mid-job) is re-claimed and delivered exactly once
//            per idempotency key.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const dbh = require('../helpers/db');
const config = require('../../src/config');
const { enqueue, listDeadLetters, requeueDeadLetter } = require('../../src/outbox/outbox');
const { loadHandlers, createRegistry } = require('../../src/outbox/dispatch');
const { pollOnce, claimBatch, startWorker, CLAIM_SQL } = require('../../src/outbox/worker');
const requestContext = require('../../src/middleware/requestContext');
const { createLogger } = require('../../src/lib/logger');
const pooled = require('../../src/db/pool');

jest.setTimeout(120_000);

const ROOT = path.join(__dirname, '..', '..');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tempDirs = [];

function makeTempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

/** Captures structured log lines emitted through a real logger pipeline (NFR-08 asserts). */
function makeSink() {
  const lines = [];
  const log = createLogger({
    level: 'info',
    stream: {
      write: (line) => {
        lines.push(JSON.parse(line));
      },
    },
  });
  return { lines, log };
}

async function waitFor(fn, { timeoutMs = 10_000, stepMs = 50, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await fn();
    if (result) return result;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await sleep(stepMs);
  }
}

async function getJob(id) {
  const { rows } = await dbh.query('SELECT * FROM outbox_jobs WHERE id = $1', [id]);
  return rows[0];
}

/** Milliseconds until the job becomes claimable again, measured by the DATABASE clock. */
async function backoffDelayMs(id) {
  const { rows } = await dbh.query(
    `SELECT extract(epoch FROM (available_at - now())) * 1000 AS delay_ms
     FROM outbox_jobs WHERE id = $1`,
    [id]
  );
  return Number(rows[0].delay_ms);
}

async function fastForward(id) {
  await dbh.query(
    `UPDATE outbox_jobs SET available_at = now() - interval '1 second' WHERE id = $1`,
    [id]
  );
}

beforeEach(async () => {
  // Each test builds its own jobs; leftovers from other suites must never be claimed here.
  await dbh.query('DELETE FROM outbox_jobs');
});

afterAll(async () => {
  await dbh.query('DELETE FROM outbox_jobs');
  await dbh.query(`DELETE FROM users WHERE email LIKE '%@dbunit.homeplate.invalid'`);
  await dbh.closeDb();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------
describe('enqueue — same-transaction atomicity (FR-13, ADR-001/003)', () => {
  test('a post-insert error rolls back BOTH the business row and the outbox row', async () => {
    const marker = `atomic.${crypto.randomUUID()}`;
    const email = `${marker}@dbunit.homeplate.invalid`;
    await expect(
      dbh.withTransaction(async (client) => {
        const user = await dbh.makeUser({ email }, client);
        await enqueue(client, { type: 'test.atomicity', payload: { userId: user.id } });
        throw new Error('boom after business insert');
      })
    ).rejects.toThrow('boom after business insert');

    const users = await dbh.query('SELECT 1 FROM users WHERE email = $1', [email]);
    const jobs = await dbh.query(`SELECT 1 FROM outbox_jobs WHERE type = 'test.atomicity'`);
    expect(users.rowCount).toBe(0); // zero rows of both — no dual write possible
    expect(jobs.rowCount).toBe(0);
  });

  test('without an error, the business row and the outbox row commit together', async () => {
    const { user, job } = await dbh.withTransaction(async (client) => {
      const u = await dbh.makeUser({}, client);
      const { job: j, deduped } = await enqueue(client, {
        type: 'test.atomicity.commit',
        payload: { userId: u.id },
      });
      expect(deduped).toBe(false);
      return { user: u, job: j };
    });
    const users = await dbh.query('SELECT 1 FROM users WHERE id = $1', [user.id]);
    const persisted = await getJob(job.id);
    expect(users.rowCount).toBe(1);
    expect(persisted).toMatchObject({
      type: 'test.atomicity.commit',
      status: 'pending',
      attempt_count: 0,
      payload: { userId: user.id },
    });
  });

  test('enqueue refuses the pool (a pool write would be a dual write)', async () => {
    await expect(enqueue(pooled.pool, { type: 'test.pool' })).rejects.toThrow(
      /transaction client/i
    );
    await expect(enqueue(pooled, { type: 'test.pool' })).rejects.toThrow(/transaction client/i);
    await expect(enqueue(null, { type: 'test.pool' })).rejects.toThrow(TypeError);
  });

  test('type and availableAt are validated', async () => {
    await dbh.withRollback(async (client) => {
      await expect(enqueue(client, { type: '' })).rejects.toThrow(TypeError);
      await expect(enqueue(client, {})).rejects.toThrow(TypeError);
      await expect(enqueue(client, { type: 'ok.type', payload: 'nope' })).rejects.toThrow(
        /plain JSON object/
      );
      await expect(enqueue(client, { type: 'ok.type', availableAt: 'not-a-date' })).rejects.toThrow(
        /availableAt/
      );
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('enqueue — IDs-only payload guard (ADR-003)', () => {
  test('email/phone/name-shaped keys and values are rejected; ID payloads pass', async () => {
    await dbh.withRollback(async (client) => {
      const cases = [
        { email: 'guest@example.com' }, // PII key
        { note: 'reach me at foo@bar.com' }, // email-shaped value under an innocent key
        { phone: '5551234567' }, // PII key
        { contact: '+1 (415) 555-1212' }, // phone-shaped value
        { guestName: 'John Smith' }, // name-shaped key
        { booking: { hostEmail: 'x@y.com' } }, // nested PII key
        { recipients: [{ userPhone: '555' }] }, // PII key inside an array element
      ];
      for (const payload of cases) {
        await expect(enqueue(client, { type: 'test.pii', payload })).rejects.toMatchObject({
          code: 'OUTBOX_PAYLOAD_PII',
        });
      }
      // dedupe keys are scanned too — they are persisted alongside the payload
      await expect(
        enqueue(client, { type: 'test.pii', dedupeKey: 'notify-a@b.com' })
      ).rejects.toMatchObject({ code: 'OUTBOX_PAYLOAD_PII' });

      // an IDs-only payload passes, including ISO dates and UUIDs (no false positives)
      const { job } = await enqueue(client, {
        type: 'test.pii.ok',
        payload: {
          bookingId: crypto.randomUUID(),
          listingId: crypto.randomUUID(),
          localDate: '2030-06-01',
          template: 'booking_confirmed',
        },
      });
      expect(job.status).toBe('pending');
    });
  });

  test('a duplicate dedupeKey is a no-op returning the existing job (idempotent enqueue)', async () => {
    const dedupeKey = `dedupe-${crypto.randomUUID()}`;
    const first = await dbh.withTransaction((client) =>
      enqueue(client, { type: 'test.dedupe', payload: { n: 1 }, dedupeKey })
    );
    const second = await dbh.withTransaction((client) =>
      enqueue(client, { type: 'test.dedupe', payload: { n: 2 }, dedupeKey })
    );
    expect(first.deduped).toBe(false);
    expect(second.deduped).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.payload).toEqual({ n: 1 }); // the original job is untouched
    const { rows } = await dbh.query(
      'SELECT count(*)::int AS n FROM outbox_jobs WHERE dedupe_key = $1',
      [dedupeKey]
    );
    expect(rows[0].n).toBe(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('dispatch — handler discovery from handlers/*.js (build-plan convention 3)', () => {
  test('loadHandlers discovers {type, handle} modules and ignores non-JS files', () => {
    const dir = makeTempDir('hp-outbox-handlers-');
    fs.writeFileSync(
      path.join(dir, 'alpha.js'),
      `'use strict';\nmodule.exports = { type: 'test.alpha', handle: async () => {} };\n`
    );
    fs.writeFileSync(
      path.join(dir, 'beta.js'),
      `'use strict';\nmodule.exports = { type: 'test.beta', handle: async () => {} };\n`
    );
    fs.writeFileSync(path.join(dir, '.gitkeep'), '');
    const registry = loadHandlers({ dir });
    expect(registry.types()).toEqual(['test.alpha', 'test.beta']);
    expect(registry.has('test.alpha')).toBe(true);
    expect(typeof registry.get('test.beta').handle).toBe('function');
  });

  test('duplicate types and malformed handlers abort startup', () => {
    const dupDir = makeTempDir('hp-outbox-dup-');
    for (const name of ['one.js', 'two.js']) {
      fs.writeFileSync(
        path.join(dupDir, name),
        `'use strict';\nmodule.exports = { type: 'test.same', handle: async () => {} };\n`
      );
    }
    expect(() => loadHandlers({ dir: dupDir })).toThrow(/duplicate outbox handler/);

    const badDir = makeTempDir('hp-outbox-bad-');
    fs.writeFileSync(
      path.join(badDir, 'broken.js'),
      `'use strict';\nmodule.exports = { type: 'test.broken' };\n` // no handle()
    );
    expect(() => loadHandlers({ dir: badDir })).toThrow(/handle/);

    expect(() =>
      createRegistry([
        { type: 'x.y', handle: () => {} },
        { type: 'x.y', handle: () => {} },
      ])
    ).toThrow(/duplicate/);
    expect(() => createRegistry([{ type: '', handle: () => {} }])).toThrow(TypeError);
  });

  test('an empty handlers directory yields a valid empty registry (wave-2 state)', () => {
    const dir = makeTempDir('hp-outbox-empty-');
    const registry = loadHandlers({ dir });
    expect(registry.size).toBe(0);
    expect(registry.types()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('worker — claim, execute, correlation propagation (FR-13, NFR-08)', () => {
  test('the claim uses FOR UPDATE SKIP LOCKED', () => {
    expect(CLAIM_SQL).toMatch(/FOR UPDATE SKIP LOCKED/);
  });

  test('delivers a job; handler ctx and worker log lines carry the originating correlation ID', async () => {
    const correlationId = `corr-${crypto.randomUUID()}`;
    const bookingId = crypto.randomUUID();
    const calls = [];
    const registry = createRegistry([
      {
        type: 'test.deliver',
        handle: async (payload, ctx) => {
          calls.push({
            payload,
            ctxCorrelationId: ctx.correlationId,
            ctxIdempotencyKey: ctx.idempotencyKey,
            ctxAttempt: ctx.attempt,
            // NFR-08: code the handler calls sees the same ID via AsyncLocalStorage
            contextCorrelationId: requestContext.getCorrelationId(),
          });
        },
      },
    ]);

    // Enqueue "inside a request": requestContext supplies the correlation ID to stamp.
    const { job } = await requestContext.run({ correlationId }, () =>
      dbh.withTransaction((client) =>
        enqueue(client, { type: 'test.deliver', payload: { bookingId } })
      )
    );
    expect(job.correlation_id).toBe(correlationId);

    const { lines, log } = makeSink();
    const stats = await pollOnce({ registry, log });
    expect(stats).toEqual({ claimed: 1, delivered: 1, retried: 0, deadLettered: 0 });

    expect(calls).toHaveLength(1);
    expect(calls[0].payload).toEqual({ bookingId });
    expect(calls[0].ctxCorrelationId).toBe(correlationId);
    expect(calls[0].contextCorrelationId).toBe(correlationId);
    expect(calls[0].ctxIdempotencyKey).toBe(`outbox:${job.id}`); // stable per-job default
    expect(calls[0].ctxAttempt).toBe(1);

    const deliveredLine = lines.find((l) => l.event === 'outbox_job_delivered');
    expect(deliveredLine).toBeDefined();
    expect(deliveredLine.correlationId).toBe(correlationId); // MT-01: same ID on both sides
    expect(deliveredLine.jobId).toBe(String(job.id));

    const persisted = await getJob(job.id);
    expect(persisted.status).toBe('delivered');
    expect(persisted.attempt_count).toBe(1);
    expect(persisted.delivered_at).not.toBeNull();
  });

  test('a job scheduled in the future (availableAt) is not claimed yet', async () => {
    const { job } = await dbh.withTransaction((client) =>
      enqueue(client, {
        type: 'test.future',
        payload: {},
        availableAt: new Date(Date.now() + 3_600_000),
      })
    );
    const registry = createRegistry([{ type: 'test.future', handle: async () => {} }]);
    const { log } = makeSink();
    const stats = await pollOnce({ registry, log });
    expect(stats.claimed).toBe(0);
    expect((await getJob(job.id)).status).toBe('pending');
  });
});

// ---------------------------------------------------------------------------------------------
describe('worker — retry, exponential backoff, dead-letter (NFR-09)', () => {
  test('failing jobs back off exponentially, then dead-letter with the failure reason', async () => {
    let fail = true;
    const registry = createRegistry([
      {
        type: 'test.retry',
        handle: async () => {
          if (fail) throw new Error('simulated failure');
        },
      },
    ]);
    const { log } = makeSink();
    const options = {
      registry,
      log,
      maxAttempts: 4,
      backoffBaseMs: 60_000,
      backoffMaxMs: 3_600_000,
    };
    const { job } = await dbh.withTransaction((client) =>
      enqueue(client, { type: 'test.retry', payload: {} })
    );

    // attempt 1 → retry scheduled ~= baseMs out
    let stats = await pollOnce(options);
    expect(stats).toMatchObject({ claimed: 1, retried: 1 });
    let row = await getJob(job.id);
    expect(row).toMatchObject({
      status: 'pending',
      attempt_count: 1,
      last_error: 'simulated failure',
    });
    const delay1 = await backoffDelayMs(job.id);
    expect(delay1).toBeGreaterThan(55_000);
    expect(delay1).toBeLessThan(65_000);

    // before the backoff elapses the job is NOT claimable
    stats = await pollOnce(options);
    expect(stats.claimed).toBe(0);

    // attempt 2 → delay doubles (exponential)
    await fastForward(job.id);
    stats = await pollOnce(options);
    expect(stats.retried).toBe(1);
    const delay2 = await backoffDelayMs(job.id);
    expect(delay2).toBeGreaterThan(115_000);
    expect(delay2).toBeLessThan(125_000);

    // attempt 3 retries, attempt 4 (= maxAttempts) dead-letters
    await fastForward(job.id);
    stats = await pollOnce(options);
    expect(stats.retried).toBe(1);
    await fastForward(job.id);
    stats = await pollOnce(options);
    expect(stats).toMatchObject({ claimed: 1, deadLettered: 1 });

    row = await getJob(job.id);
    expect(row.status).toBe('dead');
    expect(row.attempt_count).toBe(4);
    expect(row.last_error).toBe('simulated failure'); // reason recorded, still queryable

    // dead jobs are never claimed again…
    stats = await pollOnce(options);
    expect(stats.claimed).toBe(0);

    // …but stay visible in the dead-letter listing (NFR-09 visibility)
    const dead = await listDeadLetters();
    expect(dead.map((d) => d.id)).toContain(job.id);

    // and an operator can requeue once the fault is fixed
    fail = false;
    const requeued = await requeueDeadLetter(job.id);
    expect(requeued).toMatchObject({ status: 'pending', attempt_count: 0 });
    stats = await pollOnce(options);
    expect(stats.delivered).toBe(1);
    expect((await getJob(job.id)).status).toBe('delivered');
  });

  test('the retry budget defaults to config.outbox.maxAttempts', async () => {
    const registry = createRegistry([
      {
        type: 'test.maxattempts',
        handle: async () => {
          throw new Error('always failing');
        },
      },
    ]);
    const { log } = makeSink();
    const { job } = await dbh.withTransaction((client) =>
      enqueue(client, { type: 'test.maxattempts', payload: {} })
    );
    const max = config.outbox.maxAttempts;
    expect(max).toBeGreaterThanOrEqual(2);
    for (let attempt = 1; attempt < max; attempt += 1) {
      const stats = await pollOnce({ registry, log }); // no overrides: config defaults apply
      expect(stats).toMatchObject({ claimed: 1, retried: 1 });
      expect((await getJob(job.id)).attempt_count).toBe(attempt);
      await fastForward(job.id);
    }
    const finalStats = await pollOnce({ registry, log });
    expect(finalStats).toMatchObject({ claimed: 1, deadLettered: 1 });
    const row = await getJob(job.id);
    expect(row.status).toBe('dead');
    expect(row.attempt_count).toBe(max);
  });

  test('a job with no registered handler retries and then dead-letters', async () => {
    const registry = createRegistry([]); // nothing registered
    const { log } = makeSink();
    const { job } = await dbh.withTransaction((client) =>
      enqueue(client, { type: 'test.unregistered', payload: {} })
    );
    const options = { registry, log, maxAttempts: 2, backoffBaseMs: 1, backoffMaxMs: 10 };
    let stats = await pollOnce(options);
    expect(stats.retried).toBe(1);
    await fastForward(job.id);
    stats = await pollOnce(options);
    expect(stats.deadLettered).toBe(1);
    const row = await getJob(job.id);
    expect(row.status).toBe('dead');
    expect(row.last_error).toMatch(/no outbox handler registered/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('worker — concurrent claims and crash recovery (RT-02)', () => {
  test('two workers draining concurrently never double-process a job', async () => {
    const jobIds = [];
    await dbh.withTransaction(async (client) => {
      for (let i = 0; i < 6; i += 1) {
        const { job } = await enqueue(client, {
          type: 'test.concurrent',
          payload: { index: i },
        });
        jobIds.push(job.id);
      }
    });

    const invocations = new Map(); // jobId → count
    const registry = createRegistry([
      {
        type: 'test.concurrent',
        handle: async (payload, ctx) => {
          await sleep(30); // hold the claim long enough for the drains to overlap
          invocations.set(ctx.jobId, (invocations.get(ctx.jobId) || 0) + 1);
        },
      },
    ]);
    const { log } = makeSink();

    async function drain() {
      let delivered = 0;
      for (;;) {
        const stats = await pollOnce({ registry, log, batchSize: 2 });
        if (stats.claimed === 0) break;
        delivered += stats.delivered;
      }
      return delivered;
    }
    const [a, b] = await Promise.all([drain(), drain()]);

    expect(a + b).toBe(6); // every job delivered exactly once across both workers
    expect(invocations.size).toBe(6);
    for (const id of jobIds) {
      expect(invocations.get(String(id))).toBe(1); // asserted: never double-processed
    }
    const { rows } = await dbh.query(
      `SELECT count(*)::int AS n FROM outbox_jobs WHERE type = 'test.concurrent' AND status = 'delivered' AND attempt_count = 1`
    );
    expect(rows[0].n).toBe(6);
  });

  test('a crashed claim is re-claimed and delivered exactly once per idempotency key', async () => {
    const user = await dbh.makeUser();
    const dedupeKey = `rt02-${crypto.randomUUID()}`;
    const handlerCalls = [];
    const handler = {
      type: 'test.rt02',
      // The real RT-02 mechanism: the side effect is keyed on ctx.idempotencyKey, so a
      // redelivered job is a no-op (ADR-011: tests assert on persisted attempt rows).
      handle: async (payload, ctx) => {
        handlerCalls.push(ctx.attempt);
        await dbh.query(
          `INSERT INTO notification_attempts
             (recipient_user_id, channel, template, params, status, attempt_count, idempotency_key, sent_at)
           VALUES ($1, 'email', 'test_rt02', $2::jsonb, 'sent', 1, $3, now())
           ON CONFLICT (idempotency_key) DO NOTHING`,
          [payload.recipientUserId, JSON.stringify({ jobId: ctx.jobId }), ctx.idempotencyKey]
        );
      },
    };
    const registry = createRegistry([handler]);
    const { log } = makeSink();

    const { job } = await dbh.withTransaction((client) =>
      enqueue(client, { type: 'test.rt02', payload: { recipientUserId: user.id }, dedupeKey })
    );

    // Worker A claims the job and "crashes" mid-job, after its side effect landed but
    // before its claim transaction could commit.
    const clientA = await dbh.getClient();
    clientA.on('error', () => {}); // the killed backend emits an error on this client
    try {
      const pidRow = await clientA.query('SELECT pg_backend_pid() AS pid');
      const workerAPid = pidRow.rows[0].pid;
      await clientA.query('BEGIN');
      const claimed = await claimBatch(clientA, { batchSize: 1 });
      expect(claimed).toHaveLength(1);
      expect(claimed[0].id).toBe(job.id);

      // While worker A holds the claim, worker B skips the row (FOR UPDATE SKIP LOCKED).
      const skipStats = await pollOnce({ registry, log });
      expect(skipStats.claimed).toBe(0);
      expect(handlerCalls).toHaveLength(0);

      // Worker A's handler runs its side effect (own pool connection — commits at once)…
      await handler.handle(claimed[0].payload, {
        jobId: String(claimed[0].id),
        type: claimed[0].type,
        attempt: claimed[0].attempt_count + 1,
        correlationId: claimed[0].correlation_id,
        idempotencyKey: claimed[0].dedupe_key,
        log,
      });
      expect(handlerCalls).toHaveLength(1);

      // …and then the worker dies before COMMIT: kill its backend. The row lock releases,
      // the claim transaction rolls back, and the job is 'pending' again.
      await dbh.query('SELECT pg_terminate_backend($1)', [workerAPid]);
    } finally {
      clientA.release(true); // discard the destroyed connection
    }

    // Worker B re-claims and redelivers; the idempotency key makes it exactly-once.
    const redelivery = await waitFor(
      async () => {
        const stats = await pollOnce({ registry, log });
        return stats.delivered === 1 ? stats : null;
      },
      { label: 'crashed job to be re-claimed and delivered' }
    );
    expect(redelivery.delivered).toBe(1);
    expect(handlerCalls).toHaveLength(2); // handled twice (at-least-once execution)…

    const attempts = await dbh.query(
      'SELECT * FROM notification_attempts WHERE idempotency_key = $1',
      [dedupeKey]
    );
    expect(attempts.rowCount).toBe(1); // …but exactly ONE delivery per idempotency key
    expect((await getJob(job.id)).status).toBe('delivered');
  });
});

// ---------------------------------------------------------------------------------------------
describe('worker — polling loop and standalone process (FR-13, NFR-08)', () => {
  test('startWorker polls until stopped; stop() halts claiming', async () => {
    const delivered = [];
    const registry = createRegistry([
      {
        type: 'test.loop',
        handle: async (payload) => {
          delivered.push(payload.n);
        },
      },
    ]);
    const { log } = makeSink();
    const worker = startWorker({ registry, log, pollIntervalMs: 25 });
    try {
      await dbh.withTransaction((client) =>
        enqueue(client, { type: 'test.loop', payload: { n: 1 } })
      );
      await waitFor(() => delivered.length === 1, { label: 'loop delivery', timeoutMs: 5000 });
    } finally {
      await worker.stop();
    }

    // After stop(), new jobs are no longer claimed by this worker.
    const { job } = await dbh.withTransaction((client) =>
      enqueue(client, { type: 'test.loop', payload: { n: 2 } })
    );
    await sleep(200);
    expect(delivered).toEqual([1]);
    expect((await getJob(job.id)).status).toBe('pending');
  });

  test('scripts/worker.js runs standalone: delivers jobs, logs the correlation ID, exits cleanly', async () => {
    // Hermetic handler set: the spawned worker discovers handlers from a directory this
    // test controls (--handlers-dir), independent of sibling units' handler files.
    const dir = makeTempDir('hp-outbox-standalone-');
    fs.writeFileSync(
      path.join(dir, 'standalone.js'),
      `'use strict';\nmodule.exports = { type: 'test.standalone', handle: async () => {} };\n`
    );

    const child = spawn(
      process.execPath,
      [path.join(ROOT, 'scripts', 'worker.js'), '--handlers-dir', dir],
      {
        cwd: ROOT,
        env: { ...process.env, LOG_LEVEL: 'info', OUTBOX_POLL_INTERVAL_MS: '100' },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
    });

    try {
      const correlationId = `corr-standalone-${crypto.randomUUID()}`;
      const { job } = await requestContext.run({ correlationId }, () =>
        dbh.withTransaction((client) =>
          enqueue(client, { type: 'test.standalone', payload: { bookingId: crypto.randomUUID() } })
        )
      );

      await waitFor(async () => (await getJob(job.id)).status === 'delivered', {
        label: `standalone worker to deliver job ${job.id} (stderr: ${stderr})`,
        timeoutMs: 20_000,
      });

      child.kill('SIGTERM');
      const { code } = await exited;
      expect(code).toBe(0); // graceful shutdown

      const lines = stdout
        .split('\n')
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line)];
          } catch {
            return [];
          }
        });
      expect(lines.some((l) => l.event === 'outbox_worker_started')).toBe(true);
      const deliveredLine = lines.find(
        (l) => l.event === 'outbox_job_delivered' && l.jobId === String(job.id)
      );
      expect(deliveredLine).toBeDefined();
      // NFR-08: the request-side correlation ID appears in the worker process's log line.
      expect(deliveredLine.correlationId).toBe(correlationId);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });
});
