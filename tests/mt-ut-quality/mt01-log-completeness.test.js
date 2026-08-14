// tests/mt-ut-quality/mt01-log-completeness.test.js — verifier lane "mt-ut-quality".
//
// MT-01 (SRS §4.6) / NFR-08: important actions produce structured JSON audit records
// (event, correlation/request ID, actor user ID, subject entity ID, outcome, timestamp);
// the request's correlation ID propagates into the outbox row AND into the worker's log
// lines for the resulting job (same ID on both sides); errors log message, stack,
// correlation ID and HTTP status; captured log output contains user IDs only — never an
// email address, phone number, name, or password (SRS §3.4 PII register).
//
// Wave-1/2 scope note: of MT-01's four named actions only REGISTRATION exists in this
// build run (waves 0-2). Booking creation, booking cancellation and moderation decisions
// are waves 3-4 and are reported as not_implemented by the lane's structured result —
// this file additionally exercises login/logout (also "important actions" per NFR-08's
// non-exhaustive list) so the audit substrate is proven end to end on what exists.
//
// The whole file drives the REAL app factory (Supertest) with a recording logger sink and
// the REAL outbox worker against the seeded *_test database — no mocks beyond the
// ADR-011 mock notification transport that the canonical test env mandates.
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const { loadHandlers } = require('../../src/outbox/dispatch');
const { pollOnce } = require('../../src/outbox/worker');
const { query, closeDb } = require('../helpers/db');
const { closeRedis } = require('../../src/db/redis');

// ---- recording logger ---------------------------------------------------------------
// Every line the app/worker would write goes into `lines` so the suite can assert on the
// exact bytes that would reach a log aggregator.
const lines = [];
const sink = {
  write(line) {
    lines.push(String(line));
  },
};
const recLogger = createLogger({ level: 'info', stream: sink });

function records() {
  return lines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}
function auditRecords() {
  return records().filter((r) => r.audit === true);
}

// ---- fixture identity (synthetic, PII-shaped on purpose for the leak scan) ----------
const RUN = `${process.pid}${Date.now()}`;
const EMAIL = `mt01.probe.${RUN}@mt01-lane.homeplate.invalid`;
const PASSWORD = 'CorrectHorse!42mt01';
const FULL_NAME = 'Marisol Quetzal-Verifier';
const PHONE = '+14155550142';
const REG_CID = `mt01-reg-${RUN}`;

let app;
let userId;

beforeAll(() => {
  app = createApp({ logger: recLogger });
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

describe('MT-01 / NFR-08 — registration audit record', () => {
  test('POST /api/auth/register (201) emits one complete structured audit record', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('X-Correlation-Id', REG_CID)
      .send({ email: EMAIL, password: PASSWORD, fullName: FULL_NAME, phone: PHONE });

    expect(res.status).toBe(201);
    expect(res.headers['x-correlation-id']).toBe(REG_CID);
    userId = res.body.user.id;
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);

    const audits = auditRecords().filter(
      (r) => r.event === 'user.registered' && r.correlationId === REG_CID
    );
    expect(audits).toHaveLength(1);
    const rec = audits[0];
    // MT-01 acceptance: event name, correlation ID, actor user ID, subject entity ID,
    // outcome, timestamp — all in ONE structured JSON record.
    expect(rec.outcome).toBe('success');
    expect(rec.actorUserId).toBe(userId);
    expect(rec.entityType).toBe('user');
    expect(rec.entityId).toBe(userId);
    expect(typeof rec.time).toBe('string');
    expect(Number.isNaN(Date.parse(rec.time))).toBe(false);
    expect(rec.level).toBe('info');
  });

  test('the USER row exists and the outbox row is stamped with the SAME correlation ID', async () => {
    const users = await query('SELECT id, email_verified FROM users WHERE id = $1', [userId]);
    expect(users.rows).toHaveLength(1);
    expect(users.rows[0].email_verified).toBe(false);

    const jobs = await query(
      `SELECT id, type, payload, correlation_id, status FROM outbox_jobs
       WHERE type = 'email.verification' AND payload->>'userId' = $1`,
      [userId]
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].correlation_id).toBe(REG_CID); // NFR-08 propagation, request side
    // ADR-003: IDs/digests only in the payload — never the address or the raw token.
    const payloadText = JSON.stringify(jobs.rows[0].payload);
    expect(payloadText).not.toContain(EMAIL);
    expect(payloadText).not.toContain('@');
  });

  test('the worker log lines for the resulting job carry the SAME correlation ID (both sides)', async () => {
    const before = lines.length;
    const registry = loadHandlers({ log: recLogger });
    // Drain rather than poll once: sibling suites (e.g. tests/unit/bookings.test.js) may
    // leave their own due jobs in the shared test outbox, and pollOnce claims oldest-first
    // with a bounded batch — so poll until THIS user's email.verification job has left
    // 'pending' (bounded so a regression cannot loop forever).
    let totalClaimed = 0;
    for (let i = 0; i < 25; i += 1) {
      const stats = await pollOnce({ registry, log: recLogger });
      totalClaimed += stats.claimed;
      const { rows } = await query(
        `SELECT status FROM outbox_jobs
         WHERE type = 'email.verification' AND payload->>'userId' = $1`,
        [userId]
      );
      if (rows.length === 1 && rows[0].status !== 'pending') break;
      if (stats.claimed === 0) break; // queue drained without reaching the job — fail below
    }
    expect(totalClaimed).toBeGreaterThanOrEqual(1);

    const workerLines = records().slice();
    const delivered = workerLines.filter(
      (r) => r.event === 'outbox_job_delivered' && r.correlationId === REG_CID
    );
    expect(delivered).toHaveLength(1);
    expect(delivered[0].jobType).toBe('email.verification');
    expect(String(delivered[0].jobId)).toMatch(/\d+/);
    // No worker line for this job may carry a DIFFERENT correlation id.
    const jobId = delivered[0].jobId;
    for (const r of workerLines.slice(before)) {
      if (r.jobId === jobId) expect(r.correlationId).toBe(REG_CID);
    }

    // The deferred work really happened: mock transport persisted the attempt row
    // (ADR-011 — assert on persisted rows, never on a third party).
    const attempts = await query(
      `SELECT status, channel, params FROM notification_attempts WHERE recipient_user_id = $1`,
      [userId]
    );
    expect(attempts.rows.length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(attempts.rows)).not.toContain(EMAIL);
  });

  test('duplicate registration (AB-07) is refused 409 AND audited without leaking the email', async () => {
    const dupCid = `mt01-dup-${RUN}`;
    const res = await request(app)
      .post('/api/auth/register')
      .set('X-Correlation-Id', dupCid)
      .send({ email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_IN_USE');

    const audits = auditRecords().filter(
      (r) => r.event === 'user.registered' && r.correlationId === dupCid
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('failure');
    expect(audits[0].reason).toBe('duplicate_email');

    const count = await query(
      'SELECT count(*)::int AS n FROM users WHERE lower(email) = lower($1)',
      [EMAIL]
    );
    expect(count.rows[0].n).toBe(1); // no second row
  });
});

describe('MT-01 / NFR-08 — login and logout audit records', () => {
  const loginCid = `mt01-login-${RUN}`;
  let cookie;
  let sessionId;

  test('successful login emits an audit record with actor user ID and correlation ID', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('X-Correlation-Id', loginCid)
      .send({ email: EMAIL, password: PASSWORD });

    expect(res.status).toBe(200);
    cookie = res.headers['set-cookie'].join(';');

    const audits = auditRecords().filter(
      (r) => r.event === 'auth.login' && r.correlationId === loginCid
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('success');
    expect(audits[0].actorUserId).toBe(userId);
    expect(typeof audits[0].sessionId).toBe('string');
    sessionId = audits[0].sessionId;
    // The opaque session TOKEN must never be logged (only the session id).
    const tokenMatch = cookie.match(/=([A-Za-z0-9_-]{40,})/);
    if (tokenMatch) {
      expect(lines.join('\n')).not.toContain(tokenMatch[1]);
    }
  });

  test('logout emits an audit record referencing the session entity', async () => {
    const outCid = `mt01-logout-${RUN}`;
    const res = await request(app)
      .post('/api/auth/logout')
      .set('X-Correlation-Id', outCid)
      .set('Cookie', cookie)
      .send();

    expect(res.status).toBe(204);
    const audits = auditRecords().filter(
      (r) => r.event === 'auth.logout' && r.correlationId === outCid
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].outcome).toBe('success');
    expect(audits[0].actorUserId).toBe(userId);
    expect(audits[0].entityType).toBe('session');
    expect(audits[0].entityId).toBe(sessionId);
  });
});

describe('MT-01 / NFR-08 — every request is traceable', () => {
  test('a request WITHOUT an incoming header gets a generated UUID, echoed and logged', async () => {
    const res = await request(app).get('/api/users/me'); // 401 — still traceable
    const cid = res.headers['x-correlation-id'];
    expect(cid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);

    const completion = records().filter(
      (r) => r.event === 'http_request' && r.correlationId === cid
    );
    expect(completion).toHaveLength(1);
    expect(completion[0].method).toBe('GET');
    expect(completion[0].path).toBe('/api/users/me');
    expect(typeof completion[0].status).toBe('number');
    expect(typeof completion[0].durationMs).toBe('number');
  });

  test('query strings are stripped from the completion line (PII register)', async () => {
    const cid = `mt01-query-${RUN}`;
    await request(app)
      .get('/api/users/me')
      .query({ email: 'probe.querystring@mt01-lane.homeplate.invalid' })
      .set('X-Correlation-Id', cid);
    const completion = records().filter(
      (r) => r.event === 'http_request' && r.correlationId === cid
    );
    expect(completion).toHaveLength(1);
    expect(completion[0].path).toBe('/api/users/me');
    expect(lines.join('\n')).not.toContain('probe.querystring');
  });
});

describe('MT-01 / NFR-08 — error records carry message, stack, correlation ID and status', () => {
  test('operational error (404) logs a structured request_error with status + code + stack', async () => {
    const cid = `mt01-404-${RUN}`;
    const res = await request(app).get('/api/nowhere').set('X-Correlation-Id', cid);
    expect(res.status).toBe(404);

    const errs = records().filter((r) => r.event === 'request_error' && r.correlationId === cid);
    expect(errs).toHaveLength(1);
    const rec = errs[0];
    expect(rec.status).toBe(404);
    expect(typeof rec.code).toBe('string');
    expect(rec.err && typeof rec.err.message).toBe('string');
    expect(rec.err && typeof rec.err.stack).toBe('string');
    expect(rec.err.stack).toContain('Error');
    // The response body never contains the stack (NFR-08 / NFR-11 boundary).
    expect(JSON.stringify(res.body)).not.toContain('at ');
  });

  test('unexpected 500 logs message+stack server-side, returns generic body, scrubs emails', async () => {
    // Minimal app composed of the REAL U1-OBS middlewares (the deployed app has no
    // intentionally-crashing route to hit, so the pipeline is exercised directly).
    const express = require('express');
    const requestContext = require('../../src/middleware/requestContext');
    const errorHandler = require('../../src/middleware/errorHandler');
    const boom = express();
    boom.use(requestContext({ logger: recLogger }));
    boom.get('/explode', (req, res, next) =>
      next(new Error('kaboom while mailing hidden.person@mt01-lane.homeplate.invalid'))
    );
    boom.use(errorHandler({ logger: recLogger }));

    const cid = `mt01-500-${RUN}`;
    const res = await request(boom).get('/explode').set('X-Correlation-Id', cid);
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe('INTERNAL_ERROR');
    expect(res.body.error.message).toBe('Internal server error'); // no internals leaked
    expect(res.body.error.correlationId).toBe(cid);

    const errs = records().filter((r) => r.event === 'request_error' && r.correlationId === cid);
    expect(errs).toHaveLength(1);
    expect(errs[0].level).toBe('error');
    expect(errs[0].status).toBe(500);
    expect(typeof errs[0].err.stack).toBe('string');
    // The email inside the error message was scrubbed before hitting the sink.
    expect(errs[0].err.message).toContain('[REDACTED]');
    expect(errs[0].err.message).not.toContain('hidden.person');
  });
});

describe('MT-01 — SRS §3.4 PII register: captured log output holds user IDs only', () => {
  test('no email address, password, full name, phone number or raw token in ANY captured line', () => {
    const blob = lines.join('\n');
    expect(lines.length).toBeGreaterThan(10); // the scan is over a real corpus
    expect(blob).not.toContain(EMAIL);
    expect(blob).not.toContain('mt01-lane.homeplate.invalid'); // any variant of the address
    expect(blob).not.toContain(PASSWORD);
    expect(blob).not.toContain(FULL_NAME);
    expect(blob).not.toContain('Quetzal');
    expect(blob).not.toContain(PHONE);
    // Generic sweep: nothing email-shaped anywhere in the corpus.
    const emailShaped = blob.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || [];
    expect(emailShaped).toEqual([]);
    // The user ID (the one identifier logs SHOULD carry) is present.
    expect(blob).toContain(userId);
  });
});
