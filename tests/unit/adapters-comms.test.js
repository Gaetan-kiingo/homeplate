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

  // Deliberate cover for scrubErrorMessage's code branch. It used to be reached only by
  // ACCIDENT — a residue test's unscoped drain delivered a foreign row whose error happened to
  // carry a code — so the 2026-08-21 consolidation dropped it. It is asserted on purpose here
  // because last_error is an operator's only clue about a failed send, and it must be BOTH
  // useful (the provider's code survives) and safe (NFR-13: no address is written to a column
  // that operators read casually).
  test('last_error keeps the provider error code and scrubs an email-shaped address (NFR-13)', async () => {
    const providerError = new Error('rejected recipient guest.private@leak.invalid unknown');
    providerError.code = 'PROVIDER_550';
    mock.injectFailures(3, undefined, providerError);

    const result = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'booking-cancelled',
    });
    expect(result.status).toBe('failed');

    const row = await repo.findById(result.attemptId);
    expect(row.last_error).toMatch(/^PROVIDER_550: /); // the code is prefixed, not dropped
    expect(row.last_error).toMatch(/rejected recipient/); // the diagnosis survives
    expect(row.last_error).toContain('[REDACTED]'); // …but the address does not
    expect(row.last_error).not.toContain('guest.private@leak.invalid');
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

  // Finding RTLT-05: this test used to assert `known.text` contained 'tokenId: tok-1' — i.e. it
  // PINNED the wholesale `Object.entries(params)` echo that shipped userId and the FR-10 token's
  // SHA-256 digest into real mailboxes. The contract is now an explicit per-template allow-list
  // (DEFAULT DENY), so the assertions below pin the new rule instead: the verification body is a
  // sentence and a link, the booking/safety bodies carry their one quotable handle, and NO body
  // ever contains a credential digest.
  test('renderEmail produces a subject and an allow-listed body for known and unknown templates', () => {
    const known = sendgrid.renderEmail(
      'email-verification',
      { userId: 'u-1', tokenHash: 'a'.repeat(64) },
      { verificationUrl: 'https://homeplate.test/api/auth/verify-email?token=raw-token-value' }
    );
    expect(known.subject).toBe('Verify your Homeplate email address');
    // What the recipient acts on is there…
    expect(known.text).toContain(
      'https://homeplate.test/api/auth/verify-email?token=raw-token-value'
    );
    // …and the internal ids are not: no Reference block at all for FR-10.
    expect(known.text).not.toContain('Reference:');
    expect(known.text).not.toContain('u-1');
    expect(known.text).not.toContain('tokenHash');
    expect(sendgrid.referenceFieldsFor('email-verification')).toEqual([]);
    expect(sendgrid.referenceFieldsFor('email.verification')).toEqual([]);

    // Templates that DO publish a handle still render it, and only it: `event` is not allow-listed.
    const booking = sendgrid.renderEmail('booking.created', {
      bookingId: 'bk-7',
      event: 'created',
    });
    expect(booking.text).toContain('bookingId: bk-7');
    expect(booking.text).not.toContain('event:');

    // An unregistered template publishes nothing — a new flow cannot leak a payload by omission.
    const unknown = sendgrid.renderEmail('some-future-template', { internalRef: 'leak-me' });
    expect(unknown.subject).toContain('some-future-template');
    expect(unknown.text).toContain('Notification type: some-future-template');
    expect(unknown.text).not.toContain('leak-me');
  });

  test('RTLT-05: no rendered body ever contains a 64-hex credential digest', () => {
    const digest = 'd05563a52f524bb51fd81e3d87aa48649a180f7c7cb9a12cc8939b45d24fecea';
    const sha256Anywhere = /[0-9a-f]{64}/i;
    const templates = [
      ...Object.values(sendgrid.TEMPLATE_IDS),
      ...sendgrid.BOOKING_EVENTS.map(sendgrid.templateForBookingEvent),
      ...Object.keys(sendgrid.EMAIL_SUBJECTS),
      'some-future-template',
    ];
    for (const template of [...new Set(templates)]) {
      // Every allow-listed key is deliberately fed a digest, plus the real FR-10 payload shape.
      const params = { userId: 'u-1', tokenHash: digest, bookingId: digest, alertId: digest };
      const { text } = sendgrid.renderEmail(template, params, {
        verificationUrl: 'https://homeplate.test/api/auth/verify-email?token=raw-token-value',
        expiresAt: '2026-01-01T00:00:00.000Z',
      });
      expect(text).not.toMatch(sha256Anywhere);
      expect(text).not.toContain(digest);
    }
  });

  // Finding COV-08: isVerificationTemplate / subjectFor / VERIFICATION_TEMPLATE_IDS are part of
  // this module's published surface (they were exported so the FR-10 and TCB-W3-04 rules could
  // be asserted from outside), so they get pinned here — an export with no consumer and no test
  // is an unenforced contract.
  test('the exported template vocabulary is a pinned contract (FR-10, TCB-W3-04)', () => {
    // FR-10: BOTH spellings name the one template whose body must carry the single-use link —
    // the dotted job type the outbox handler emits and the legacy hyphenated one.
    expect(sendgrid.VERIFICATION_TEMPLATE_IDS).toEqual([
      'email.verification',
      'email-verification',
    ]);
    expect(Object.isFrozen(sendgrid.VERIFICATION_TEMPLATE_IDS)).toBe(true);
    expect(sendgrid.isVerificationTemplate('email.verification')).toBe(true);
    expect(sendgrid.isVerificationTemplate('email-verification')).toBe(true);
    // and nothing else is: a booking mail must not be forced to carry a credential.
    expect(sendgrid.isVerificationTemplate(sendgrid.TEMPLATE_IDS.bookingCreated)).toBe(false);
    expect(sendgrid.isVerificationTemplate('some-future-template')).toBe(false);

    // TCB-W3-04: every id the v1.0 flows actually emit resolves to a real subject, never the
    // neutral "Homeplate notification (…)" fallback that shipped to guests before the repair.
    for (const id of Object.values(sendgrid.TEMPLATE_IDS)) {
      expect(sendgrid.subjectFor(id)).toBe(sendgrid.EMAIL_SUBJECTS[id]);
      expect(sendgrid.subjectFor(id)).not.toMatch(/^Homeplate notification \(/);
    }
    for (const event of sendgrid.BOOKING_EVENTS) {
      const id = sendgrid.templateForBookingEvent(event);
      expect(sendgrid.hasSubject(id)).toBe(true);
      expect(sendgrid.subjectFor(id)).not.toMatch(/^Homeplate notification \(/);
    }
    // An unregistered id still renders rather than crashing delivery.
    expect(sendgrid.subjectFor('some-future-template')).toBe(
      'Homeplate notification (some-future-template)'
    );

    // RTLT-05 (same COV-08 rule, applied to the reference registry): every emitted id carries an
    // EXPLICIT reference decision — default-deny, so a future flow cannot inherit "print whatever
    // the payload holds" — and the FR-10 verification templates publish nothing at all, because
    // their params are a user id and the token DIGEST the recipient cannot act on.
    for (const id of Object.values(sendgrid.TEMPLATE_IDS)) {
      expect(Object.prototype.hasOwnProperty.call(sendgrid.REFERENCE_FIELDS, id)).toBe(true);
      expect(sendgrid.referenceFieldsFor(id)).toBe(sendgrid.REFERENCE_FIELDS[id]);
    }
    for (const id of sendgrid.VERIFICATION_TEMPLATE_IDS) {
      expect(sendgrid.referenceFieldsFor(id)).toEqual([]);
    }
    // Unregistered templates render no reference block at all (default deny).
    expect(sendgrid.referenceFieldsFor('some-future-template')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Finding COV-06 residual: liveProviderRefusedInTest() — the ADR-011/ADR-007 fail-closed guard
// that stands between `npm test` and a third-party API call — had never executed in any run, in
// EITHER comms adapter. These tests execute it directly, with no network of any kind: the
// provider SDK is replaced inside an isolated jest registry, once WITHOUT the harness
// substitution marker (what the real module looks like to the adapter, so the guard must fire)
// and once WITH it (positive control, so the guard cannot be a blanket refusal that would pass
// the first assertion while breaking production).

/** Provider SDK names doMock'ed by loadAdapterWithSdk and released after each test. */
const pendingIsolatedMocks = new Set();

function releaseIsolatedMocks() {
  for (const name of pendingIsolatedMocks) jest.dontMock(name);
  pendingIsolatedMocks.clear();
  // dontMock drops the FACTORY but leaves the built double in the registry cache; reset the
  // registry so the next load cannot silently reuse the previous test's SDK. Every module this
  // file uses is already held by reference at the top, so nothing here is re-required.
  jest.resetModules();
}

/**
 * Loads one adapter in an isolated jest registry with `env` applied and its provider SDK
 * replaced by `sdkFactory`, then restores the ambient environment. The doMock must be
 * registered BEFORE isolateModules opens the fresh registry, and must stay registered until
 * the test has awaited deliver() — both adapters require their SDK lazily, at send time.
 * The returned module keeps working after isolateModules returns; releaseIsolatedMocks() in
 * afterEach tears the substitution down.
 */
function loadAdapterWithSdk({ env = {}, sdkName, sdkFactory, modulePath }) {
  releaseIsolatedMocks(); // never inherit a previous load's cached double
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  jest.doMock(sdkName, sdkFactory);
  pendingIsolatedMocks.add(sdkName);
  let loaded;
  try {
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      loaded = require(modulePath);
    });
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  return loaded;
}

describe('ADR-011 fail-closed guard — a non-substituted provider SDK is refused under NODE_ENV=test', () => {
  afterEach(() => releaseIsolatedMocks());

  test('SendGrid: an UNMARKED @sendgrid/mail is refused permanently and never receives the key', async () => {
    const calls = { setApiKey: 0, send: 0 };
    const sg = loadAdapterWithSdk({
      env: {
        // Exactly the accident the guard exists for: a stray key left in the environment.
        SENDGRID_API_KEY: 'SG.stray-key-left-in-the-environment',
        SENDGRID_FROM_EMAIL: 'no-reply@homeplate.test',
      },
      sdkName: '@sendgrid/mail',
      sdkFactory: () => ({
        setApiKey: () => {
          calls.setApiKey += 1;
        },
        send: async () => {
          calls.send += 1;
          return [{ headers: { 'x-message-id': 'must-never-happen' } }];
        },
      }),
      modulePath: '../../src/adapters/sendgrid',
    });

    const err = await sg.adapter
      .deliver({
        userId: '00000000-0000-4000-8000-000000000001',
        recipientEmail: 'guest@example.test',
        template: 'safety-alert-emergency',
        params: { alertId: 'alert-cov06r' },
      })
      .catch((e) => e);

    expect(err.code).toBe('LIVE_PROVIDER_REFUSED_IN_TEST');
    expect(err.retryable).toBe(false); // configuration fault — retrying cannot help (NFR-09)
    expect(err.message).toMatch(/NODE_ENV=test/);
    // The refusal happens BEFORE the SDK is configured or called: no key handed over, no send.
    expect(calls).toEqual({ setApiKey: 0, send: 0 });
    expect(err.message).not.toContain('guest@example.test'); // NFR-08 PII register
    expect(err.message).not.toContain('SG.stray-key-left-in-the-environment');
  });

  test('SendGrid positive control: the same load with a MARKED double delivers normally', async () => {
    const sent = [];
    const sg = loadAdapterWithSdk({
      env: {
        SENDGRID_API_KEY: 'SG.test-injected',
        SENDGRID_FROM_EMAIL: 'no-reply@homeplate.test',
      },
      sdkName: '@sendgrid/mail',
      sdkFactory: () => ({
        __fake: true, // the harness substitution marker the real module never carries
        setApiKey: () => {},
        send: async (msg) => {
          sent.push(msg);
          return [{ headers: { 'x-message-id': 'msg-cov06r-1' } }];
        },
      }),
      modulePath: '../../src/adapters/sendgrid',
    });

    const result = await sg.adapter.deliver({
      userId: '00000000-0000-4000-8000-000000000001',
      recipientEmail: 'guest@example.test',
      template: sendgrid.TEMPLATE_IDS.bookingCreated,
      params: { bookingId: 'b-cov06r' },
    });
    expect(result).toEqual({ providerMessageId: 'msg-cov06r-1' });
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(sendgrid.EMAIL_SUBJECTS[sendgrid.TEMPLATE_IDS.bookingCreated]);
    // ADR-011: the ambient suite process is untouched — still on the mock transport, no key.
    expect(config.notifications.transport).toBe('mock');
    expect(config.notifications.sendgridApiKey).toBeUndefined();
  });

  test('FCM: an UNMARKED firebase-admin is refused even with the push gate open and credentials present', async () => {
    const calls = { initializeApp: 0, send: 0 };
    const fcmIsolated = loadAdapterWithSdk({
      env: {
        NOTIFICATIONS_PUSH_ENABLED: 'true',
        FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"homeplate-test"}',
      },
      sdkName: 'firebase-admin',
      sdkFactory: () => ({
        credential: { cert: () => ({}) },
        initializeApp: () => {
          calls.initializeApp += 1;
          return {};
        },
        messaging: () => ({
          send: async () => {
            calls.send += 1;
            return 'must-never-happen';
          },
        }),
      }),
      modulePath: '../../src/adapters/fcm',
    });

    const err = await fcmIsolated.adapter
      .deliver({
        userId: '00000000-0000-4000-8000-0000000000ab',
        template: sendgrid.TEMPLATE_IDS.bookingCreated,
        params: { bookingId: 'b-cov06r' },
      })
      .catch((e) => e);

    expect(err.code).toBe('LIVE_PROVIDER_REFUSED_IN_TEST');
    expect(err.retryable).toBe(false);
    expect(err.message).toMatch(/NODE_ENV=test/);
    // Refused before any credential was parsed, any app initialised or any message sent.
    expect(calls).toEqual({ initializeApp: 0, send: 0 });
    // ADR-011: the ambient process still has push OFF — the gate was opened only in isolation.
    expect(config.notifications.push.enabled).toBe(false);
    expect(process.env.NOTIFICATIONS_PUSH_ENABLED).toBe('false');
  });

  test('FCM positive control: the same load with a MARKED double reaches the per-user topic', async () => {
    const sends = [];
    const fcmIsolated = loadAdapterWithSdk({
      env: {
        NOTIFICATIONS_PUSH_ENABLED: 'true',
        FCM_SERVICE_ACCOUNT_JSON: '{"project_id":"homeplate-test"}',
      },
      sdkName: 'firebase-admin',
      sdkFactory: () => ({
        __fake: true,
        credential: { cert: () => ({}) },
        initializeApp: () => ({}),
        messaging: () => ({
          send: async (message) => {
            sends.push(message);
            return 'projects/homeplate-test/messages/cov06r';
          },
        }),
      }),
      modulePath: '../../src/adapters/fcm',
    });

    const userId = '00000000-0000-4000-8000-0000000000ab';
    const result = await fcmIsolated.adapter.deliver({
      userId,
      template: sendgrid.TEMPLATE_IDS.bookingCreated,
      params: { bookingId: 'b-cov06r' },
    });
    expect(result.providerMessageId).toBe('projects/homeplate-test/messages/cov06r');
    expect(sends[0].topic).toBe(`user-${userId}`); // IDs only (§3.4 PII register, ADR-003)
    expect(config.notifications.push.enabled).toBe(false);
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
