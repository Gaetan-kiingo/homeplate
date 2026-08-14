// tests/unit/observability.test.js — U1-OBS unit suite (build-plan wave 1).
//
// Verifies:
//   NFR-08 (MT-01) — structured JSON logging (level/time/msg), correlation ID assignment,
//                    propagation (child bindings, response header, AsyncLocalStorage),
//                    PII redaction of log objects/bindings/messages, audit record shape,
//                    AppError taxonomy (status + code), errorHandler JSON envelopes with
//                    message+stack+correlationId in logs but never in responses.
//   NFR-09 (RT-01) — withResilience timeout (fake timers), bounded retries with
//                    exponential backoff, fallback after exhaustion, AbortSignal
//                    cancellation; httpClient applies the same policy to outbound HTTPS
//                    and refuses plain-HTTP targets.
'use strict';

const express = require('express');
const supertest = require('supertest');

const {
  logger: defaultLogger,
  createLogger,
  audit,
  redactPii,
  isPiiKey,
  REDACTED,
} = require('../../src/lib/logger');
const errors = require('../../src/lib/errors');
const {
  withResilience,
  computeBackoffDelay,
  DEFAULT_TIMEOUT_MS,
} = require('../../src/lib/resilience');
const httpClient = require('../../src/lib/httpClient');
const requestContext = require('../../src/middleware/requestContext');
const errorHandler = require('../../src/middleware/errorHandler');

/** In-memory pino sink so tests can assert on emitted JSON lines. */
function sinkLogger(level = 'info') {
  const lines = [];
  const stream = { write: (line) => lines.push(line) };
  const log = createLogger({ level, stream });
  return { log, lines, records: () => lines.map((l) => JSON.parse(l)) };
}

const silentLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

describe('logger (NFR-08 — structured JSON with correlation via child)', () => {
  test('emits structured JSON with level label, ISO timestamp, msg and correlationId', () => {
    const { log, records } = sinkLogger();
    const child = log.child({ correlationId: 'corr-123' });
    child.info({ userId: 'u-42' }, 'booking_created');

    const rec = records()[0];
    expect(rec.level).toBe('info');
    expect(typeof rec.time).toBe('string');
    expect(new Date(rec.time).toString()).not.toBe('Invalid Date');
    expect(rec.correlationId).toBe('corr-123');
    expect(rec.msg).toBe('booking_created');
    expect(rec.userId).toBe('u-42');
    expect(rec.service).toBe('homeplate');
  });

  test('.warn and .error carry their level labels', () => {
    const { log, records } = sinkLogger('warn');
    log.warn('w');
    log.error('e');
    expect(records().map((r) => r.level)).toEqual(['warn', 'error']);
  });

  test('grandchild loggers keep parent bindings', () => {
    const { log, records } = sinkLogger();
    log.child({ correlationId: 'corr-1' }).child({ jobId: 'job-9' }).info('tick');
    const rec = records()[0];
    expect(rec.correlationId).toBe('corr-1');
    expect(rec.jobId).toBe('job-9');
  });

  test('default logger is silent under NODE_ENV=test and exposes child()', () => {
    expect(defaultLogger.level).toBe('silent');
    const child = defaultLogger.child({ correlationId: 'x' });
    expect(typeof child.info).toBe('function');
    expect(typeof child.warn).toBe('function');
    expect(typeof child.error).toBe('function');
  });
});

describe('logger PII redaction (NFR-08 / SRS §3.4 — user IDs only, never PII)', () => {
  test('redacts password, email, phone and name fields in log objects', () => {
    const { log, lines, records } = sinkLogger();
    log.info(
      {
        userId: 'u-1',
        password: 'hunter2-secret',
        email: 'ada@example.com',
        phone: '+1 555 010 9999',
        name: 'Ada Lovelace',
      },
      'user_registered'
    );
    const rec = records()[0];
    expect(rec.password).toBe(REDACTED);
    expect(rec.email).toBe(REDACTED);
    expect(rec.phone).toBe(REDACTED);
    expect(rec.name).toBe(REDACTED);
    expect(rec.userId).toBe('u-1');
    const raw = lines.join('');
    for (const leak of ['hunter2-secret', 'ada@example.com', '555 010 9999', 'Ada Lovelace']) {
      expect(raw).not.toContain(leak);
    }
  });

  test('redacts nested objects, arrays and composed key variants', () => {
    const { log, lines, records } = sinkLogger();
    log.info(
      {
        user: { firstName: 'Grace', contact_phone: '619-555-0000', emailAddress: 'g@x.org' },
        guests: [{ guestEmail: 'guest@x.org', guestName: 'Guest One' }],
        emergencyContact: { name: 'Max', phone: '111' },
        currentPassword: 'oldpw',
        apiKey: 'sk-not-a-real-key',
      },
      'profile_updated'
    );
    const rec = records()[0];
    expect(rec.user.firstName).toBe(REDACTED);
    expect(rec.user.contact_phone).toBe(REDACTED);
    expect(rec.user.emailAddress).toBe(REDACTED);
    expect(rec.guests[0].guestEmail).toBe(REDACTED);
    expect(rec.guests[0].guestName).toBe(REDACTED);
    expect(rec.emergencyContact).toBe(REDACTED);
    expect(rec.currentPassword).toBe(REDACTED);
    expect(rec.apiKey).toBe(REDACTED);
    const raw = lines.join('');
    for (const leak of [
      'Grace',
      '619-555',
      'g@x.org',
      'guest@x.org',
      'oldpw',
      'sk-not-a-real-key',
    ]) {
      expect(raw).not.toContain(leak);
    }
  });

  test('does not over-redact operational keys (eventName, fileName, tableName)', () => {
    const { log, records } = sinkLogger();
    log.info({ eventName: 'booking_created', fileName: 'photo.png', tableName: 'bookings' }, 'x');
    const rec = records()[0];
    expect(rec.eventName).toBe('booking_created');
    expect(rec.fileName).toBe('photo.png');
    expect(rec.tableName).toBe('bookings');
  });

  test('redacts child logger bindings too', () => {
    const { log, lines, records } = sinkLogger();
    log.child({ correlationId: 'corr-9', email: 'leaky@example.com' }).info('hello');
    const rec = records()[0];
    expect(rec.correlationId).toBe('corr-9');
    expect(rec.email).toBe(REDACTED);
    expect(lines.join('')).not.toContain('leaky@example.com');
  });

  test('scrubs email addresses out of message strings', () => {
    const { log, lines, records } = sinkLogger();
    log.info('welcome mail queued for someone@example.com today');
    expect(records()[0].msg).toContain(REDACTED);
    expect(lines.join('')).not.toContain('someone@example.com');
  });

  test('scrubs email addresses out of Error messages and stacks', () => {
    const { log, lines } = sinkLogger();
    log.error({ err: new Error('duplicate account for dupe@example.com') }, 'register failed');
    const raw = lines.join('');
    expect(raw).not.toContain('dupe@example.com');
    expect(raw).toContain('stack');
  });

  test('redactPii handles circular structures and returns new objects', () => {
    const input = { userId: 'u-1', email: 'c@d.io' };
    input.self = input;
    const out = redactPii(input);
    expect(out.email).toBe(REDACTED);
    expect(out.self).toBe('[CIRCULAR]');
    expect(input.email).toBe('c@d.io'); // caller's object untouched
  });

  test('isPiiKey normalizes separators and case', () => {
    expect(isPiiKey('Email')).toBe(true);
    expect(isPiiKey('user_email')).toBe(true);
    expect(isPiiKey('user-phone')).toBe(true);
    expect(isPiiKey('hostName')).toBe(true); // hosts are people in this domain (ADR-010)
    expect(isPiiKey('userId')).toBe(false);
    expect(isPiiKey('durationMs')).toBe(false);
  });
});

describe('audit records (NFR-08 / MT-01 shape)', () => {
  test('emits event, actor, entity, outcome, timestamp and correlationId', () => {
    const { log, records } = sinkLogger();
    const child = log.child({ correlationId: 'corr-audit' });
    audit(child, {
      event: 'booking_cancelled',
      actorUserId: 'u-7',
      entityType: 'booking',
      entityId: 'b-31',
      outcome: 'success',
    });
    const rec = records()[0];
    expect(rec.audit).toBe(true);
    expect(rec.event).toBe('booking_cancelled');
    expect(rec.actorUserId).toBe('u-7');
    expect(rec.entityType).toBe('booking');
    expect(rec.entityId).toBe('b-31');
    expect(rec.outcome).toBe('success');
    expect(rec.correlationId).toBe('corr-audit');
    expect(typeof rec.time).toBe('string');
    expect(rec.msg).toBe('booking_cancelled');
  });

  test('rejects records missing event or outcome', () => {
    const { log } = sinkLogger();
    expect(() => audit(log, { outcome: 'success' })).toThrow(TypeError);
    expect(() => audit(log, { event: 'x' })).toThrow(TypeError);
    expect(() => audit(null, { event: 'x', outcome: 'y' })).toThrow(TypeError);
  });
});

describe('error taxonomy (NFR-08 — status + machine-readable code)', () => {
  test.each([
    ['ValidationError', errors.ValidationError, 422, 'VALIDATION_FAILED'],
    ['AuthenticationError', errors.AuthenticationError, 401, 'AUTHENTICATION_REQUIRED'],
    ['ForbiddenError', errors.ForbiddenError, 403, 'FORBIDDEN'],
    ['NotFoundError', errors.NotFoundError, 404, 'NOT_FOUND'],
    ['ConflictError', errors.ConflictError, 409, 'CONFLICT'],
    ['RateLimitError', errors.RateLimitError, 429, 'RATE_LIMITED'],
    ['ServiceUnavailableError', errors.ServiceUnavailableError, 503, 'SERVICE_UNAVAILABLE'],
    ['TimeoutError', errors.TimeoutError, 504, 'UPSTREAM_TIMEOUT'],
    ['UpstreamServiceError', errors.UpstreamServiceError, 502, 'UPSTREAM_ERROR'],
    ['InternalError', errors.InternalError, 500, 'INTERNAL_ERROR'],
  ])('%s carries its status and code', (_name, Ctor, status, code) => {
    const err = new Ctor();
    expect(err).toBeInstanceOf(errors.AppError);
    expect(err).toBeInstanceOf(Error);
    expect(err.status).toBe(status);
    expect(err.code).toBe(code);
    expect(errors.isAppError(err)).toBe(true);
  });

  test('toJSON exposes code/message/details but never the stack', () => {
    const err = new errors.ValidationError('Validation failed', {
      details: [{ field: 'email', message: 'invalid' }],
    });
    const wire = err.toJSON();
    expect(wire).toEqual({
      code: 'VALIDATION_FAILED',
      message: 'Validation failed',
      details: [{ field: 'email', message: 'invalid' }],
    });
    expect(JSON.stringify(wire)).not.toContain('at ');
  });

  test('retryability markers drive the NFR-09 predicate', () => {
    expect(new errors.TimeoutError().retryable).toBe(true);
    expect(new errors.ServiceUnavailableError().retryable).toBe(true);
    expect(new errors.ValidationError().retryable).toBe(false);
    expect(new errors.UpstreamServiceError('x', { upstreamStatus: 503 }).retryable).toBe(true);
    expect(new errors.UpstreamServiceError('x', { upstreamStatus: 429 }).retryable).toBe(true);
    expect(new errors.UpstreamServiceError('x', { upstreamStatus: 404 }).retryable).toBe(false);
    expect(new errors.UpstreamServiceError('x').retryable).toBe(true); // network-level
  });

  test('cause is preserved for logging', () => {
    const cause = new Error('socket hang up');
    const err = new errors.UpstreamServiceError('network failure', { cause });
    expect(err.cause).toBe(cause);
  });
});

describe('requestContext + errorHandler (NFR-08 — correlation and safe error envelopes)', () => {
  function buildApp(log) {
    const app = express();
    app.use(requestContext({ logger: log }));
    app.get('/ok', (req, res) => {
      res.json({ correlationId: req.correlationId, fromAls: requestContext.getCorrelationId() });
    });
    app.get('/missing', () => {
      throw new errors.NotFoundError('Listing not found');
    });
    app.get('/invalid', (req, res, next) => {
      next(
        new errors.ValidationError('Validation failed', {
          details: [{ field: 'seatCount', message: 'must be >= 1' }],
        })
      );
    });
    app.get('/crash', () => {
      throw new Error('db creds for svc-account leak@example.com exploded');
    });
    app.use(errorHandler({ logger: log }));
    return app;
  }

  test('honours a well-formed incoming X-Correlation-Id and propagates it everywhere', async () => {
    const { log, records } = sinkLogger();
    const res = await supertest(buildApp(log))
      .get('/ok')
      .set('X-Correlation-Id', 'corr-abc.123')
      .expect(200);
    await new Promise((resolve) => setImmediate(resolve));

    expect(res.headers['x-correlation-id']).toBe('corr-abc.123');
    expect(res.body.correlationId).toBe('corr-abc.123');
    expect(res.body.fromAls).toBe('corr-abc.123'); // AsyncLocalStorage propagation
    const completion = records().find((r) => r.event === 'http_request');
    expect(completion).toBeDefined();
    expect(completion.correlationId).toBe('corr-abc.123');
    expect(completion.method).toBe('GET');
    expect(completion.path).toBe('/ok');
    expect(completion.status).toBe(200);
    expect(typeof completion.durationMs).toBe('number');
  });

  test('generates a UUID when the header is absent or malformed', async () => {
    const { log } = sinkLogger();
    const app = buildApp(log);
    const fresh = await supertest(app).get('/ok').expect(200);
    expect(fresh.headers['x-correlation-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    const malformed = await supertest(app)
      .get('/ok')
      .set('X-Correlation-Id', 'not valid !! way too weird')
      .expect(200);
    expect(malformed.headers['x-correlation-id']).not.toBe('not valid !! way too weird');
  });

  test('AppError → JSON envelope with status/code/details, logged with correlationId', async () => {
    const { log, records } = sinkLogger();
    const app = buildApp(log);

    const notFound = await supertest(app)
      .get('/missing')
      .set('X-Correlation-Id', 'corr-nf')
      .expect(404);
    expect(notFound.body.error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'Listing not found',
      correlationId: 'corr-nf',
    });

    const invalid = await supertest(app).get('/invalid').expect(422);
    expect(invalid.body.error.code).toBe('VALIDATION_FAILED');
    expect(invalid.body.error.details).toEqual([{ field: 'seatCount', message: 'must be >= 1' }]);

    const logged = records().find((r) => r.event === 'request_error' && r.code === 'NOT_FOUND');
    expect(logged).toBeDefined();
    expect(logged.level).toBe('warn'); // 4xx logs at warn
    expect(logged.status).toBe(404);
    expect(logged.correlationId).toBe('corr-nf');
    expect(logged.err.stack).toEqual(expect.stringContaining('NotFoundError'));
  });

  test('unexpected errors: generic 500 body without stack or internals; full detail logged', async () => {
    const { log, lines, records } = sinkLogger();
    const res = await supertest(buildApp(log))
      .get('/crash')
      .set('X-Correlation-Id', 'corr-crash')
      .expect(500);

    // Response: nothing internal leaks (NFR-08 — no stack traces in responses).
    expect(res.body.error).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'Internal server error',
      correlationId: 'corr-crash',
    });
    const rawBody = JSON.stringify(res.body);
    expect(rawBody).not.toContain('db creds');
    expect(rawBody).not.toContain('at '); // no stack frames
    expect(rawBody).not.toContain('leak@example.com');

    // Logs: message + stack + correlationId + status (NFR-08), email scrubbed (§3.4).
    const logged = records().find((r) => r.event === 'request_error' && r.status === 500);
    expect(logged.level).toBe('error');
    expect(logged.correlationId).toBe('corr-crash');
    expect(logged.err.message).toContain('db creds');
    expect(typeof logged.err.stack).toBe('string');
    expect(logged.err.stack).toContain('Error');
    expect(lines.join('')).not.toContain('leak@example.com');
  });

  test('dual-mode: bare app.use(requestContext) and app.use(errorHandler) work', async () => {
    const app = express();
    app.use(requestContext);
    app.get('/direct', (req, res) => res.json({ id: req.correlationId }));
    app.get('/direct-error', () => {
      throw new errors.ForbiddenError();
    });
    app.use(errorHandler);
    const ok = await supertest(app).get('/direct').expect(200);
    expect(ok.headers['x-correlation-id']).toBeTruthy();
    expect(ok.body.id).toBe(ok.headers['x-correlation-id']);
    const forbidden = await supertest(app).get('/direct-error').expect(403);
    expect(forbidden.body.error.code).toBe('FORBIDDEN');
  });

  test('requestContext.run scopes worker jobs (ADR-003 correlation into worker logs)', () => {
    const result = requestContext.run({ correlationId: 'job-corr-1' }, () => ({
      id: requestContext.getCorrelationId(),
      log: requestContext.getLogger(),
    }));
    expect(result.id).toBe('job-corr-1');
    expect(typeof result.log.info).toBe('function');
    expect(requestContext.getCorrelationId()).toBeUndefined(); // nothing leaks outside
  });
});

describe('withResilience (NFR-09 — timeout, bounded retry, backoff, fallback)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  test('default timeout budget is 3000 ms (requirements inventory NFR-09)', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(3000);
  });

  test('enforces the timeout and aborts the attempt signal', async () => {
    const signals = [];
    const hang = ({ signal }) => {
      signals.push(signal);
      return new Promise(() => {});
    };
    const promise = withResilience(hang, { timeoutMs: 1000, retries: 0, log: silentLog });
    const assertion = expect(promise).rejects.toMatchObject({
      code: 'UPSTREAM_TIMEOUT',
      status: 504,
    });
    await jest.advanceTimersByTimeAsync(999);
    expect(signals[0].aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await assertion;
    expect(signals[0].aborted).toBe(true);
    expect(signals[0].reason).toBeInstanceOf(errors.TimeoutError);
  });

  test('retries with exponential backoff and resolves once fn succeeds', async () => {
    let calls = 0;
    const delays = [];
    const fn = jest.fn(async () => {
      calls += 1;
      if (calls < 3) throw new Error('transient');
      return 'ok';
    });
    const promise = withResilience(fn, {
      timeoutMs: 0,
      retries: 3,
      backoff: { baseMs: 100, factor: 2 },
      onRetry: ({ delayMs }) => delays.push(delayMs),
      log: silentLog,
    });

    await jest.advanceTimersByTimeAsync(0);
    expect(fn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(99); // backoff #1 not elapsed yet
    expect(fn).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1); // t=100 → attempt 2
    expect(fn).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(200); // t=300 → attempt 3
    expect(fn).toHaveBeenCalledTimes(3);

    await expect(promise).resolves.toBe('ok');
    expect(delays).toEqual([100, 200]); // exponential: base*2^0, base*2^1
  });

  test('invokes the fallback after exhausting all attempts', async () => {
    const fn = jest.fn(async () => {
      throw new errors.ServiceUnavailableError('maps down');
    });
    const onFallback = jest.fn((err) => ({ degraded: true, cause: err.code }));
    const promise = withResilience(fn, {
      timeoutMs: 0,
      retries: 2,
      backoff: { baseMs: 10, factor: 2 },
      onFallback,
      log: silentLog,
    });
    await jest.advanceTimersByTimeAsync(30); // 10 + 20
    await expect(promise).resolves.toEqual({ degraded: true, cause: 'SERVICE_UNAVAILABLE' });
    expect(fn).toHaveBeenCalledTimes(3); // retries + 1, bounded
    expect(onFallback).toHaveBeenCalledTimes(1);
    expect(onFallback.mock.calls[0][0]).toBeInstanceOf(errors.ServiceUnavailableError);
  });

  test('timeouts are retryable and fall back after exhaustion', async () => {
    const fn = jest.fn(() => new Promise(() => {}));
    const onFallback = jest.fn(() => 'cached-results');
    const promise = withResilience(fn, {
      timeoutMs: 50,
      retries: 1,
      backoff: { baseMs: 10 },
      onFallback,
      log: silentLog,
    });
    await jest.advanceTimersByTimeAsync(50 + 10 + 50);
    await expect(promise).resolves.toBe('cached-results');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(onFallback.mock.calls[0][0]).toBeInstanceOf(errors.TimeoutError);
  });

  test('non-retryable errors stop immediately', async () => {
    const fn = jest.fn(async () => {
      throw new errors.ValidationError('bad input'); // retryable: false
    });
    const promise = withResilience(fn, { timeoutMs: 0, retries: 5, log: silentLog });
    const assertion = expect(promise).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await jest.advanceTimersByTimeAsync(0);
    await assertion;
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('backoff delays are capped at maxMs', () => {
    expect(computeBackoffDelay(1, { baseMs: 200, factor: 2, maxMs: 500 })).toBe(200);
    expect(computeBackoffDelay(2, { baseMs: 200, factor: 2, maxMs: 500 })).toBe(400);
    expect(computeBackoffDelay(3, { baseMs: 200, factor: 2, maxMs: 500 })).toBe(500);
  });

  test('rejects invalid arguments', async () => {
    await expect(withResilience(null)).rejects.toThrow(TypeError);
    await expect(withResilience(() => 1, { retries: -1 })).rejects.toThrow(TypeError);
  });

  test('logs retry and fallback transitions as structured events', async () => {
    const { log, records } = sinkLogger('warn');
    const fn = async () => {
      throw new Error('flaky');
    };
    const promise = withResilience(fn, {
      name: 'maps.geocode',
      timeoutMs: 0,
      retries: 1,
      backoff: { baseMs: 5 },
      onFallback: () => 'fallback',
      log,
    });
    await jest.advanceTimersByTimeAsync(5);
    await expect(promise).resolves.toBe('fallback');
    const events = records().map((r) => r.event);
    expect(events).toContain('resilience_retry');
    expect(events).toContain('resilience_fallback');
    const retry = records().find((r) => r.event === 'resilience_retry');
    expect(retry.operation).toBe('maps.geocode');
    expect(retry.delayMs).toBe(5);
  });
});

describe('httpClient (NFR-09 — resilient outbound HTTPS)', () => {
  const jsonResponse = (status, bodyObj) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => (k === 'content-type' ? 'application/json' : null) },
    text: async () => JSON.stringify(bodyObj),
  });

  test('returns status and parsed JSON on success', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, { ok: true, items: [1, 2] }));
    const res = await httpClient.request({
      url: 'https://api.example.com/v1/things?key=k',
      fetchImpl,
      log: silentLog,
    });
    expect(res.status).toBe(200);
    expect(res.json).toEqual({ ok: true, items: [1, 2] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchImpl.mock.calls[0];
    expect(calledUrl).toBe('https://api.example.com/v1/things?key=k');
    expect(init.signal).toBeDefined();
  });

  test('serializes json bodies and sets content-type', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(201, { id: 'n-1' }));
    await httpClient.request({
      url: 'https://api.example.com/v1/notify',
      method: 'POST',
      json: { userId: 'u-1', template: 'booking_confirmed' },
      fetchImpl,
      log: silentLog,
    });
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.method).toBe('POST');
    expect(init.headers['content-type']).toBe('application/json');
    expect(JSON.parse(init.body)).toEqual({ userId: 'u-1', template: 'booking_confirmed' });
  });

  test('refuses plain-HTTP targets (fails closed; NFR-03/ADR-006)', async () => {
    const fetchImpl = jest.fn();
    await expect(
      httpClient.request({ url: 'http://api.example.com/x', fetchImpl, log: silentLog })
    ).rejects.toMatchObject({ code: 'INSECURE_OUTBOUND_URL' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('allows http only with explicit allowHttp outside production (local mocks)', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(200, {}));
    await httpClient.request({
      url: 'http://localhost:9000/health',
      allowHttp: true,
      fetchImpl,
      log: silentLog,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('retries transient 5xx with backoff and succeeds', async () => {
    const fetchImpl = jest
      .fn()
      .mockResolvedValueOnce(jsonResponse(503, { error: 'busy' }))
      .mockResolvedValueOnce(jsonResponse(200, { ok: true }));
    const res = await httpClient.request({
      url: 'https://api.example.com/x',
      retries: 2,
      backoff: { baseMs: 1 },
      fetchImpl,
      log: silentLog,
    });
    expect(res.json).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('does not retry non-transient 4xx and surfaces upstreamStatus', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(404, { error: 'nope' }));
    await expect(
      httpClient.request({
        url: 'https://api.example.com/x',
        retries: 3,
        backoff: { baseMs: 1 },
        fetchImpl,
        log: silentLog,
      })
    ).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
      status: 502,
      upstreamStatus: 404,
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('wraps network failures as retryable UPSTREAM_UNREACHABLE and retries them', async () => {
    const fetchImpl = jest
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(jsonResponse(200, { ok: 1 }));
    const res = await httpClient.request({
      url: 'https://api.example.com/x',
      retries: 1,
      backoff: { baseMs: 1 },
      fetchImpl,
      log: silentLog,
    });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('applies the resilience timeout to outbound calls (fake timers)', async () => {
    jest.useFakeTimers();
    try {
      const fetchImpl = jest.fn(
        (url, init) =>
          new Promise((resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(init.signal.reason));
          })
      );
      const promise = httpClient.request({
        url: 'https://api.example.com/slow',
        timeoutMs: 500,
        retries: 0,
        fetchImpl,
        log: silentLog,
      });
      const assertion = expect(promise).rejects.toMatchObject({ code: 'UPSTREAM_TIMEOUT' });
      await jest.advanceTimersByTimeAsync(500);
      await assertion;
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('falls back to cached data after exhaustion (NFR-09 degraded mode)', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse(500, { error: 'down' }));
    const res = await httpClient.request({
      url: 'https://maps.example.com/geocode',
      retries: 1,
      backoff: { baseMs: 1 },
      onFallback: () => ({ status: 200, json: { cached: true }, degraded: true }),
      fetchImpl,
      log: silentLog,
    });
    expect(res).toEqual({ status: 200, json: { cached: true }, degraded: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  test('requires a url', async () => {
    await expect(httpClient.request({})).rejects.toThrow(TypeError);
  });
});
