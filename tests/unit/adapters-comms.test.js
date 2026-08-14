// tests/unit/adapters-comms.test.js — U2-ADAPTERS-COMMS acceptance tests (ADR-011).
//
// Requirement traceability (SRS Appendix B):
//   FR-13 / FR-14 / FR-07 — transport.send() records one §3.4 NOTIFICATION_ATTEMPT row per
//         delivery (recipient user ID, channel email/push, status sent/failed/retrying);
//         retries increment attempt_count; every assertion here is on PERSISTED ROWS,
//         never on a third party's behaviour (ADR-011)
//   NFR-09 (RT-01) — per-attempt timeout from config.adapters.timeoutMs (default 3000 ms),
//         bounded retries with exponential backoff; an injected provider failure resolves
//         to { status: 'failed' } without throwing through the worker
//   NFR-08 (MT-01) — structured notification events carry user IDs only; captured log
//         output contains no email address
//   ADR-001/003 — src/adapters/* is worker-only: no routes.js/service.js imports it (static)
//   ADR-011 — mock in dev/test, SendGrid live only when configured, FCM gated off by
//         default; secrets come from env and never appear in source (static grep)
'use strict';

// Faster resilience knobs for this file ONLY (restored in afterAll — Jest runs files
// sequentially in one worker process, so leaked env would bleed into sibling files).
// tests/helpers/env.js has already forced NODE_ENV=test + mock transports.
process.env.ADAPTER_TIMEOUT_MS = '250';
process.env.ADAPTER_RETRY_MAX = '2';
process.env.ADAPTER_BACKOFF_BASE_MS = '25';

const fs = require('fs');
const path = require('path');

const config = require('../../src/config');
const { validateEnv } = require('../../src/config/schema');
const { createLogger } = require('../../src/lib/logger');
const { ValidationError } = require('../../src/lib/errors');
const transport = require('../../src/modules/notifications/transport');
const repo = require('../../src/modules/notifications/repo');
const mock = require('../../src/adapters/mockTransport');
const sendgrid = require('../../src/adapters/sendgrid');
const fcm = require('../../src/adapters/fcm');
const dbh = require('../helpers/db');

const SRC_ROOT = path.join(__dirname, '..', '..', 'src');

let user;

beforeAll(async () => {
  user = await dbh.makeUser();
});

beforeEach(() => {
  mock.reset();
});

afterAll(async () => {
  delete process.env.ADAPTER_TIMEOUT_MS;
  delete process.env.ADAPTER_RETRY_MAX;
  delete process.env.ADAPTER_BACKOFF_BASE_MS;
  // Helper users are namespaced; the FK cascades their notification_attempts rows.
  await dbh.query(`DELETE FROM users WHERE email LIKE '%@dbunit.homeplate.invalid'`);
  await dbh.closeDb();
});

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
describe('configuration wiring (ADR-011 defaults)', () => {
  test('the automated suite runs on the mock transport with push gated off', () => {
    // ADR-011: dev and the WHOLE test suite use the mock; push default false.
    expect(config.isTest).toBe(true);
    expect(config.notifications.transport).toBe('mock');
    expect(config.notifications.push.enabled).toBe(false);
  });

  test('schema defaults: adapters.timeoutMs=3000, push disabled, mock outside production', () => {
    const minimal = validateEnv({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://example/db',
      REDIS_URL: 'redis://example',
      FIELD_ENCRYPTION_KEY: 'ab'.repeat(32),
      OBJECT_STORAGE_ENDPOINT: 'http://example:9000',
      OBJECT_STORAGE_BUCKET: 'bucket',
      OBJECT_STORAGE_ACCESS_KEY: 'k',
      OBJECT_STORAGE_SECRET_KEY: 's',
    });
    expect(minimal.adapters.timeoutMs).toBe(3000); // NFR-09 default budget
    expect(minimal.notifications.push.enabled).toBe(false); // ADR-011 default-false gate
    expect(minimal.notifications.transport).toBe('mock');
  });

  test('this test file runs with the faster (still config-driven) resilience knobs', () => {
    expect(config.adapters.timeoutMs).toBe(250);
    expect(config.adapters.retryMax).toBe(2);
    expect(config.adapters.backoffBaseMs).toBe(25);
  });
});

// ---------------------------------------------------------------------------------------------
describe('adapter resolution (ADR-011)', () => {
  test('dev/test resolves the mock adapter for email', () => {
    expect(transport.resolveAdapter('email')).toBe(mock.adapter);
  });

  test('push resolves to NOTHING while notifications.push.enabled=false (config default)', () => {
    expect(transport.resolveAdapter('push')).toBeNull();
  });

  test('live transport resolves SendGrid for email and FCM for enabled push', () => {
    const live = { transport: 'sendgrid', push: { enabled: false } };
    expect(transport.resolveAdapter('email', live)).toBe(sendgrid.adapter);
    expect(transport.resolveAdapter('push', live)).toBeNull(); // gate still wins
    const livePush = { transport: 'sendgrid', push: { enabled: true } };
    expect(transport.resolveAdapter('push', livePush)).toBe(fcm.adapter);
  });
});

// ---------------------------------------------------------------------------------------------
describe('transport.send — every attempt writes a NOTIFICATION_ATTEMPT row (ADR-011)', () => {
  test('a mock email send persists a sent row and returns { status: "sent" }', async () => {
    const result = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'booking-created',
      params: { bookingId: '2b1d29ab-0000-4000-8000-000000000001' },
    });
    expect(result.status).toBe('sent');

    const row = await repo.findById(result.attemptId);
    expect(row).not.toBeNull();
    expect(row.recipient_user_id).toBe(user.id); // recipient USER ID, never an address
    expect(row.channel).toBe('email');
    expect(row.status).toBe('sent');
    expect(row.attempt_count).toBe(1);
    expect(row.template).toBe('booking-created');
    expect(row.params).toEqual({ bookingId: '2b1d29ab-0000-4000-8000-000000000001' });
    expect(row.sent_at).not.toBeNull();

    // The mock recorded the delivery in-process; nothing left the machine.
    expect(mock.deliveries()).toHaveLength(1);
    expect(mock.deliveries()[0].userId).toBe(user.id);
  });

  test('rows never carry contact PII: params with an email-shaped value are rejected', async () => {
    await expect(
      transport.send({
        userId: user.id,
        channel: 'email',
        template: 'booking-created',
        params: { contact: 'someone@example.com' },
      })
    ).rejects.toThrow(ValidationError);
    await expect(
      transport.send({
        userId: user.id,
        channel: 'email',
        template: 'booking-created',
        params: { email: 'x' },
      })
    ).rejects.toThrow(ValidationError);
    expect(mock.deliveries()).toHaveLength(0);
  });

  test('malformed input is rejected before any row is written', async () => {
    const before = await repo.listForUser(user.id);
    await expect(transport.send({ channel: 'email', template: 't' })).rejects.toThrow(
      ValidationError
    );
    await expect(
      transport.send({ userId: user.id, channel: 'sms', template: 't' })
    ).rejects.toThrow(ValidationError);
    const after = await repo.listForUser(user.id);
    expect(after).toHaveLength(before.length);
  });

  test('an unknown recipient user id raises ValidationError (FK), not a silent row', async () => {
    await expect(
      transport.send({
        userId: '00000000-0000-4000-8000-00000000dead',
        channel: 'email',
        template: 'booking-created',
      })
    ).rejects.toThrow(ValidationError);
  });
});

// ---------------------------------------------------------------------------------------------
describe('idempotency — duplicate key does not double-send (row-level, ADR-011)', () => {
  test('a second send with the same idempotencyKey reuses the row and skips delivery', async () => {
    const key = `it-dup-${Date.now()}`;
    const first = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'booking-confirmed',
      params: {},
      idempotencyKey: key,
    });
    const second = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'booking-confirmed',
      params: {},
      idempotencyKey: key,
    });

    expect(first.status).toBe('sent');
    expect(second.status).toBe('sent');
    expect(second.deduped).toBe(true);
    expect(second.attemptId).toBe(first.attemptId);

    // Row-level: exactly ONE row for the key, exactly ONE mock delivery.
    const { rows } = await dbh.query(
      `SELECT count(*)::int AS count FROM notification_attempts WHERE idempotency_key = $1`,
      [key]
    );
    expect(rows[0].count).toBe(1);
    expect(mock.deliveries()).toHaveLength(1);

    const row = await repo.findByIdempotencyKey(key);
    expect(row.status).toBe('sent');
    expect(row.attempt_count).toBe(1); // the dedupe did not even try again
  });
});

// ---------------------------------------------------------------------------------------------
describe('resilience — NFR-09 bounded retries, backoff, failed result without throw', () => {
  test('a transient provider failure is retried and the row ends sent with attempt_count 2', async () => {
    mock.injectFailures(1);
    const result = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'booking-status-changed',
    });
    expect(result.status).toBe('sent');

    const row = await repo.findById(result.attemptId);
    expect(row.status).toBe('sent');
    expect(row.attempt_count).toBe(2); // try 1 failed, try 2 delivered
    expect(mock.deliveries()).toHaveLength(1);
  });

  test('a persistent provider outage resolves { status: "failed" } — it never throws', async () => {
    // retryMax=2 → 3 total tries; fail them all (injected outage).
    mock.injectFailures(3);
    const result = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'booking-cancelled',
    });
    expect(result.status).toBe('failed'); // resolved, not rejected (NFR-09)

    const row = await repo.findById(result.attemptId);
    expect(row.status).toBe('failed');
    expect(row.attempt_count).toBe(3); // bounded: exactly retries+1 tries
    expect(row.last_error).toMatch(/injected provider failure/);
    expect(row.sent_at).toBeNull();
    expect(mock.deliveries()).toHaveLength(0);
  });

  test('a redelivery with the same key after failure reuses the row and can succeed', async () => {
    const key = `it-redeliver-${Date.now()}`;
    mock.injectFailures(3);
    const failed = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'safety-alert-emergency',
      idempotencyKey: key,
    });
    expect(failed.status).toBe('failed');

    mock.reset(); // provider "recovered"
    const retried = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'safety-alert-emergency',
      idempotencyKey: key,
    });
    expect(retried.status).toBe('sent');
    expect(retried.attemptId).toBe(failed.attemptId); // same row, resumed (FR-07 audit)

    const row = await repo.findById(retried.attemptId);
    expect(row.status).toBe('sent');
    expect(row.attempt_count).toBe(4); // 3 failed tries + 1 successful redelivery
    expect(row.last_error).toBeNull();
  });

  test('a hung provider is cut off by the config timeout and the row ends failed', async () => {
    mock.injectHangs(3); // every try hangs; timeoutMs=250 must fire each time
    const started = Date.now();
    const result = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'booking-created',
    });
    const elapsed = Date.now() - started;

    expect(result.status).toBe('failed');
    const row = await repo.findById(result.attemptId);
    expect(row.status).toBe('failed');
    expect(row.attempt_count).toBe(3);
    expect(row.last_error).toMatch(/timed out after 250 ms/); // config.adapters.timeoutMs
    // 3 × 250 ms budgets + 25/50 ms backoff — nowhere near a hang.
    expect(elapsed).toBeLessThan(5000);
  });
});

// ---------------------------------------------------------------------------------------------
describe('repo — FR-07 no_channel recording (visible for review, never retried)', () => {
  test('an attempt can be marked no_channel when there is no emergency contact', async () => {
    const { attempt } = await repo.createAttempt({
      recipientUserId: user.id,
      channel: 'email',
      template: 'safety-alert-emergency',
    });
    const row = await repo.markNoChannel(attempt.id);
    expect(row.status).toBe('no_channel');
    expect(row.last_error).toMatch(/no emergency contact/);
    expect(row.sent_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
describe('push gate — FCM refused while notifications.push.enabled=false (ADR-011)', () => {
  test('transport.send on the push channel is refused and RECORDED as a failed row', async () => {
    const result = await transport.send({
      userId: user.id,
      channel: 'push',
      template: 'booking-created',
    });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('push_disabled');

    const row = await repo.findById(result.attemptId);
    expect(row.channel).toBe('push');
    expect(row.status).toBe('failed');
    expect(row.last_error).toMatch(/notifications\.push\.enabled=false/);
    expect(mock.deliveries()).toHaveLength(0); // nothing was delivered, even by the mock
  });

  test('the FCM adapter itself refuses under the config default (defence in depth)', async () => {
    expect(config.notifications.push.enabled).toBe(false); // asserted FROM CONFIG DEFAULT
    await expect(
      fcm.adapter.deliver({ userId: user.id, template: 'booking-created', params: {} })
    ).rejects.toMatchObject({ code: 'PUSH_DISABLED', retryable: false });
  });
});

// ---------------------------------------------------------------------------------------------
describe('SendGrid adapter — live only when configured (ADR-011)', () => {
  test('without SENDGRID_API_KEY the adapter refuses with a non-retryable config error', async () => {
    expect(config.notifications.sendgridApiKey).toBeUndefined(); // test env has no key
    await expect(
      sendgrid.adapter.deliver({
        recipientEmail: 'nobody@example.invalid',
        template: 'booking-created',
        params: {},
      })
    ).rejects.toMatchObject({ code: 'SENDGRID_NOT_CONFIGURED', retryable: false });
  });

  test('renderEmail produces a subject and an IDs-only body for known and unknown templates', () => {
    const known = sendgrid.renderEmail('email-verification', { tokenId: 'tok-1' });
    expect(known.subject).toBe('Verify your Homeplate email address');
    expect(known.text).toContain('tokenId: tok-1');

    const unknown = sendgrid.renderEmail('some-future-template', {});
    expect(unknown.subject).toContain('some-future-template');
    expect(unknown.text).toContain('Notification type: some-future-template');
  });
});

// ---------------------------------------------------------------------------------------------
describe('NFR-08 — structured events, user IDs only', () => {
  test('send() logs notification_sent/notification_failed with IDs and no email address', async () => {
    const lines = [];
    const sink = { write: (line) => lines.push(line) };
    const log = createLogger({ level: 'info', stream: sink });

    const ok = await transport.send(
      { userId: user.id, channel: 'email', template: 'booking-created' },
      { log }
    );
    mock.injectFailures(3);
    const bad = await transport.send(
      { userId: user.id, channel: 'email', template: 'booking-created' },
      { log }
    );

    const events = lines.map((l) => JSON.parse(l));
    const sent = events.find((e) => e.event === 'notification_sent');
    const failed = events.find((e) => e.event === 'notification_failed');
    expect(sent).toBeDefined();
    expect(sent.recipientUserId).toBe(user.id);
    expect(sent.attemptId).toBe(ok.attemptId);
    expect(failed).toBeDefined();
    expect(failed.attemptId).toBe(bad.attemptId);

    // §3.4 PII register: no email address anywhere in the captured output.
    const blob = lines.join('\n');
    expect(blob).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('static conformance — worker-only adapters, secrets absent from source', () => {
  test('no routes.js/service.js under src/ imports src/adapters/* (ADR-001/003)', () => {
    // The rule (build-plan §5.1): request-reachable modules keep NO adapter binding. A
    // module-scope `require('.../adapters/...')` is a violation; a call-time require inside
    // a documented worker-only function (e.g. mediaService.deleteForUser, driven by the
    // NFR-12 erasure job) is the sanctioned lazy pattern and is checked behaviourally by
    // the adr-conformance lane. Detection: brace/paren-depth scan — depth 0 = module scope.
    const moduleScopeAdapterRequire = (content) => {
      let depth = 0;
      const hits = [];
      for (const rawLine of content.split('\n')) {
        const line = rawLine.replace(/\/\/.*$/, '');
        if (depth === 0 && /require\(\s*['"][^'"]*adapters\//.test(line)) {
          hits.push(line.trim());
        }
        for (const ch of line) {
          if (ch === '{' || ch === '(') depth += 1;
          else if (ch === '}' || ch === ')') depth -= 1;
        }
      }
      return hits;
    };
    const offenders = [];
    for (const file of walk(SRC_ROOT)) {
      const base = path.basename(file);
      if (base !== 'routes.js' && base !== 'service.js') continue;
      const hits = moduleScopeAdapterRequire(fs.readFileSync(file, 'utf8'));
      for (const hit of hits) offenders.push(`${path.relative(SRC_ROOT, file)}: ${hit}`);
    }
    expect(offenders).toEqual([]);
  });

  test('no key material in src/: keys come from env only (SENDGRID_API_KEY, FCM creds)', () => {
    const keyPatterns = [
      /SG\.[A-Za-z0-9_.-]{20,}/, // SendGrid API key shape
      /AIza[0-9A-Za-z_-]{30,}/, // Google API key shape
      /-----BEGIN (RSA )?PRIVATE KEY-----/, // service-account private key
    ];
    const offenders = [];
    for (const file of walk(SRC_ROOT)) {
      const content = fs.readFileSync(file, 'utf8');
      for (const pattern of keyPatterns) {
        if (pattern.test(content)) offenders.push(`${path.relative(SRC_ROOT, file)}: ${pattern}`);
      }
      // Secrets are read from the process environment ONLY by src/config (schema/loader);
      // adapters must go through the frozen config object, never process.env.
      if (
        /process\.env\.(SENDGRID_API_KEY|SENDGRID_FROM_EMAIL|FCM_SERVICE_ACCOUNT_JSON)/.test(
          content
        ) &&
        !file.startsWith(path.join(SRC_ROOT, 'config'))
      ) {
        offenders.push(`${path.relative(SRC_ROOT, file)}: reads notification secrets directly`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('adapters expose no Express surface: no file under src/adapters registers routes', () => {
    for (const file of walk(path.join(SRC_ROOT, 'adapters'))) {
      const content = fs.readFileSync(file, 'utf8');
      expect(content).not.toMatch(/require\(\s*['"]express['"]/);
      expect(content).not.toMatch(/\.Router\(/);
    }
  });
});
