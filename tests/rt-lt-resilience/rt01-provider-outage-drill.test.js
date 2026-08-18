// tests/rt-lt-resilience/rt01-provider-outage-drill.test.js — RT-01 closure of the last NFR-09
// clause my lane previously had to mark "untestable": the SendGrid and FCM adapters drilled AS
// THEMSELVES (SRS §4.4; NFR-09; FR-13; ADR-011).
//
// Why this file exists. rt01-notification-contract.test.js drills the SHARED contract in
// src/modules/notifications/transport.js through the ADR-011 mock transport, and asserts the
// policy constants — but it never executes the live delivery bodies in src/adapters/sendgrid.js
// and src/adapters/fcm.js, so the NFR-09 clauses that are IMPLEMENTED IN THOSE BODIES (the
// transient/permanent retryability split, the bounded-retry budget, the per-attempt timeout and
// recovery) were taken on faith. They are executed here.
//
// No live provider is contacted. Both adapters resolve their SDK lazily and refuse any SDK that
// is not a harness double under NODE_ENV=test (`__fake === true` — ADR-011, finding IT-F4); every
// load below goes through a fresh isolated module registry with that double already registered,
// and the final test proves the refusal itself, so a missing double can never become a live call.
//
// Traceability: NFR-09 (RT-01 outage/recovery for every external adapter), ADR-011 (email is the
// v1.0 channel, push gated off by default, suite never asserts on a third party), ADR-001/003
// (adapters run worker-side only; nothing here goes through a request handler).
'use strict';

const { TimeoutError } = require('../../src/lib/errors');
const { withResilience } = require('../../src/lib/resilience');
const { quietLogger } = require('./helpers');

const quiet = quietLogger();

const SENDGRID_ENV = Object.freeze({
  SENDGRID_API_KEY: 'SG.rt01-drill-not-a-real-key',
  SENDGRID_FROM_EMAIL: 'no-reply@homeplate.invalid',
});

const FCM_ENV = Object.freeze({
  NOTIFICATIONS_PUSH_ENABLED: 'true',
  FCM_SERVICE_ACCOUNT_JSON: JSON.stringify({
    project_id: 'homeplate-rt01-drill',
    client_email: 'drill@homeplate.invalid',
    private_key: 'not-a-real-key',
  }),
});

const mockedModules = new Set();

/**
 * Load an adapter in a fresh module registry with its provider SDK substituted by a double.
 * Mirrors tests/it-adapters/it01c-adapter-depth.test.js loadIsolated: the doMock must be
 * registered BEFORE isolateModules opens the registry, and the double is verified in place
 * before the adapter is required, so an un-substituted SDK aborts instead of reaching the wire.
 * @param {{env?: object, mocks: object, modulePath: string}} spec
 * @returns {object} the freshly loaded module
 */
function loadIsolated({ env = {}, mocks, modulePath }) {
  releaseMocks(); // never inherit a previous drill's cached double
  const saved = {};
  for (const [key, value] of Object.entries(env)) {
    saved[key] = process.env[key];
    process.env[key] = value;
  }
  for (const [name, factory] of Object.entries(mocks)) {
    jest.doMock(name, factory);
    mockedModules.add(name);
  }
  let loaded;
  try {
    jest.isolateModules(() => {
      for (const name of Object.keys(mocks)) {
        // eslint-disable-next-line global-require
        if (require(name).__fake !== true) {
          throw new Error(`loadIsolated: ${name} is not substituted — refusing a live provider`);
        }
      }
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

/** A @sendgrid/mail double whose send() behaves as the drill dictates. */
function sendgridDouble(send) {
  return () => ({ __fake: true, setApiKey: () => {}, send });
}

/** A firebase-admin double whose messaging().send() behaves as the drill dictates. */
function firebaseDouble(send, onLoad) {
  return () => {
    if (onLoad) onLoad();
    return {
      __fake: true,
      credential: { cert: () => ({}) },
      initializeApp: () => ({}),
      messaging: () => ({ send }),
    };
  };
}

/** Drop every module substitution this file has registered (mock hygiene between drills). */
function releaseMocks() {
  for (const name of mockedModules) jest.unmock(name);
  mockedModules.clear();
  jest.resetModules();
}

/** Drive one adapter delivery through the same resilience policy the transport applies. */
async function drill(deliver, input, { timeoutMs = 200, retries = 2 } = {}) {
  const retryDelays = [];
  const outcome = { error: null, value: null };
  try {
    outcome.value = await withResilience(() => deliver(input), {
      name: 'rt01-drill',
      timeoutMs,
      retries,
      backoff: { baseMs: 5, factor: 2, jitter: false },
      onRetry: ({ delayMs }) => retryDelays.push(delayMs),
      log: quiet,
    });
  } catch (err) {
    outcome.error = err;
  }
  return { ...outcome, retryDelays };
}

afterAll(() => {
  releaseMocks();
});

describe('RT-01 drill 6 — SendGrid adapter cut off (NFR-09, ADR-011)', () => {
  test('total outage (503): bounded retries, exponential backoff, retryable upstream error', async () => {
    let calls = 0;
    const sg = loadIsolated({
      env: SENDGRID_ENV,
      mocks: {
        '@sendgrid/mail': sendgridDouble(async () => {
          calls += 1;
          const err = new Error('service unavailable');
          err.code = 503;
          throw err;
        }),
      },
      modulePath: '../../src/adapters/sendgrid',
    });

    const { error, retryDelays } = await drill(sg.adapter.deliver, {
      recipientEmail: 'guest@homeplate.invalid',
      template: 'booking.created',
      params: {},
    });

    expect(error).toBeTruthy();
    expect(error.name).toBe('UpstreamServiceError');
    expect(error.retryable).toBe(true); // 5xx is transient — the outbox may redeliver
    expect(calls).toBe(3); // retries: 2 → exactly 3 attempts, never unbounded
    expect(retryDelays).toEqual([5, 10]); // exponential, factor 2
    // The recipient address never reaches the error message (PII register, ADR-003).
    expect(error.message).not.toContain('guest@homeplate.invalid');
  });

  test('a permanent provider rejection (401) is NOT retried', async () => {
    let calls = 0;
    const sg = loadIsolated({
      env: SENDGRID_ENV,
      mocks: {
        '@sendgrid/mail': sendgridDouble(async () => {
          calls += 1;
          const err = new Error('Unauthorized');
          err.code = 401;
          throw err;
        }),
      },
      modulePath: '../../src/adapters/sendgrid',
    });

    const { error } = await drill(sg.adapter.deliver, {
      recipientEmail: 'guest@homeplate.invalid',
      template: 'booking.created',
      params: {},
    });

    expect(error.name).toBe('UpstreamServiceError');
    expect(error.retryable).toBe(false);
    expect(calls).toBe(1); // burning the retry budget on a permanent 4xx is waste (NFR-09)
  });

  test('a hung provider is cut off by the per-attempt timeout, not hung forever', async () => {
    const sg = loadIsolated({
      env: SENDGRID_ENV,
      mocks: {
        '@sendgrid/mail': sendgridDouble(
          () => new Promise(() => {}) // never settles: the outage shape a timeout exists for
        ),
      },
      modulePath: '../../src/adapters/sendgrid',
    });

    const startedAt = Date.now();
    const { error } = await drill(
      sg.adapter.deliver,
      { recipientEmail: 'guest@homeplate.invalid', template: 'booking.created', params: {} },
      { timeoutMs: 120, retries: 0 }
    );
    const elapsed = Date.now() - startedAt;

    expect(error).toBeInstanceOf(TimeoutError);
    expect(elapsed).toBeLessThan(3000); // bounded by the timeout, not by the provider
  });

  test('recovery: once the provider returns, the same send delivers and reports its message id', async () => {
    const sent = [];
    const sg = loadIsolated({
      env: SENDGRID_ENV,
      mocks: {
        '@sendgrid/mail': sendgridDouble(async (msg) => {
          sent.push(msg);
          return [{ headers: { 'x-message-id': 'rt01-recovered-1' } }];
        }),
      },
      modulePath: '../../src/adapters/sendgrid',
    });

    const { error, value } = await drill(sg.adapter.deliver, {
      recipientEmail: 'guest@homeplate.invalid',
      template: 'booking.created',
      params: {},
    });

    expect(error).toBeNull();
    expect(value).toEqual({ providerMessageId: 'rt01-recovered-1' });
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('guest@homeplate.invalid');
    expect(sent[0].from).toBe('no-reply@homeplate.invalid');
    expect(sent[0].subject).toBeTruthy(); // TCB-W3-04: a real subject, not the neutral fallback
    expect(sent[0].subject).not.toMatch(/Homeplate notification/i);
  });

  test('FR-10: a verification email with no single-use link is refused before the provider is contacted', async () => {
    let calls = 0;
    const sg = loadIsolated({
      env: SENDGRID_ENV,
      mocks: {
        '@sendgrid/mail': sendgridDouble(async () => {
          calls += 1;
          return [{}];
        }),
      },
      modulePath: '../../src/adapters/sendgrid',
    });

    const { error } = await drill(sg.adapter.deliver, {
      recipientEmail: 'guest@homeplate.invalid',
      template: 'email.verification',
      params: {},
      renderContext: {},
    });

    expect(error).toBeTruthy();
    expect(error.code).toBe('SENDGRID_NO_VERIFICATION_LINK');
    expect(error.retryable).toBe(false);
    expect(calls).toBe(0); // never put a linkless verification email on the wire (TCB-W3-01)
  });
});

describe('RT-01 drill 7 — FCM adapter cut off, and its ADR-011 gate (NFR-09)', () => {
  test('the gate is shut by default: no SDK is loaded and the send is refused permanently', async () => {
    let sendCalls = 0;
    const fcm = loadIsolated({
      // No NOTIFICATIONS_PUSH_ENABLED — the ADR-011 default (false) is what is under test.
      mocks: {
        'firebase-admin': firebaseDouble(async () => {
          sendCalls += 1;
          return 'never';
        }),
      },
      modulePath: '../../src/adapters/fcm',
    });

    const { error } = await drill(fcm.adapter.deliver, {
      userId: '00000000-0000-4000-8000-000000000001',
      template: 'booking.created',
      params: {},
    });

    expect(error).toBeTruthy();
    expect(error.code).toBe('PUSH_DISABLED');
    expect(error.retryable).toBe(false);
    expect(error.status).toBe(403);
    expect(sendCalls).toBe(0); // refused at the gate — nothing was ever handed to a provider
  });

  test('outage with the gate opened: transient FCM codes retry within the budget', async () => {
    let calls = 0;
    const fcm = loadIsolated({
      env: FCM_ENV,
      mocks: {
        'firebase-admin': firebaseDouble(async () => {
          calls += 1;
          const err = new Error('server unavailable');
          err.code = 'messaging/server-unavailable';
          throw err;
        }),
      },
      modulePath: '../../src/adapters/fcm',
    });

    const { error, retryDelays } = await drill(fcm.adapter.deliver, {
      userId: '00000000-0000-4000-8000-000000000002',
      template: 'booking.created',
      params: {},
    });

    expect(error.name).toBe('UpstreamServiceError');
    expect(error.retryable).toBe(true);
    expect(calls).toBe(3);
    expect(retryDelays).toEqual([5, 10]);
  });

  test('a malformed-message error is permanent and burns no retries', async () => {
    let calls = 0;
    const fcm = loadIsolated({
      env: FCM_ENV,
      mocks: {
        'firebase-admin': firebaseDouble(async () => {
          calls += 1;
          const err = new Error('invalid argument');
          err.code = 'messaging/invalid-argument';
          throw err;
        }),
      },
      modulePath: '../../src/adapters/fcm',
    });

    const { error } = await drill(fcm.adapter.deliver, {
      userId: '00000000-0000-4000-8000-000000000003',
      template: 'booking.created',
      params: {},
    });

    expect(error.retryable).toBe(false);
    expect(calls).toBe(1);
  });

  test('recovery: the push carries IDs only (ADR-003) and reports the provider message id', async () => {
    const sends = [];
    const fcm = loadIsolated({
      env: FCM_ENV,
      mocks: {
        'firebase-admin': firebaseDouble(async (message) => {
          sends.push(message);
          return 'projects/homeplate-rt01-drill/messages/9';
        }),
      },
      modulePath: '../../src/adapters/fcm',
    });

    const userId = '00000000-0000-4000-8000-000000000004';
    const { error, value } = await drill(fcm.adapter.deliver, {
      userId,
      template: 'booking.created',
      params: { bookingId: '00000000-0000-4000-8000-0000000000aa' },
    });

    expect(error).toBeNull();
    expect(value).toEqual({ providerMessageId: 'projects/homeplate-rt01-drill/messages/9' });
    expect(sends).toHaveLength(1);
    expect(sends[0].topic).toBe(`user-${userId}`);
    // ADR-003: the payload carries ids only — no address, no name, no message text.
    expect(JSON.parse(sends[0].data.params)).toEqual({
      bookingId: '00000000-0000-4000-8000-0000000000aa',
    });
  });
});

describe('ADR-011 — the suite physically cannot reach a live provider', () => {
  test('an un-substituted SDK is refused by both adapters under NODE_ENV=test', async () => {
    releaseMocks(); // drop every double: the REAL @sendgrid/mail and firebase-admin resolve below
    // Deliberately NO doMock: whatever `require('@sendgrid/mail')` resolves to (the real SDK when
    // installed, a resolution error when not) must never be handed a key while NODE_ENV=test.
    let sendgridRefusal = null;
    await jest.isolateModulesAsync(async () => {
      process.env.SENDGRID_API_KEY = SENDGRID_ENV.SENDGRID_API_KEY;
      process.env.SENDGRID_FROM_EMAIL = SENDGRID_ENV.SENDGRID_FROM_EMAIL;
      // eslint-disable-next-line global-require
      const sg = require('../../src/adapters/sendgrid');
      expect(sg.adapter.name).toBe('sendgrid');
      sendgridRefusal = await sg.adapter
        .deliver({
          recipientEmail: 'guest@homeplate.invalid',
          template: 'booking.created',
          params: {},
        })
        .then(() => null)
        .catch((err) => err);
      delete process.env.SENDGRID_API_KEY;
      delete process.env.SENDGRID_FROM_EMAIL;
    });

    expect(sendgridRefusal).toBeTruthy();
    // Either the ADR-011 guard fired, or the optional SDK is not installed at all — both mean
    // no request left this process. A silent success would mean a live send.
    expect(
      sendgridRefusal.code === 'LIVE_PROVIDER_REFUSED_IN_TEST' ||
        /Cannot find module '@sendgrid\/mail'/.test(sendgridRefusal.message)
    ).toBe(true);

    let fcmRefusal = null;
    await jest.isolateModulesAsync(async () => {
      process.env.NOTIFICATIONS_PUSH_ENABLED = 'true';
      process.env.FCM_SERVICE_ACCOUNT_JSON = FCM_ENV.FCM_SERVICE_ACCOUNT_JSON;
      // eslint-disable-next-line global-require
      const fcm = require('../../src/adapters/fcm');
      fcmRefusal = await fcm.adapter
        .deliver({ userId: '00000000-0000-4000-8000-000000000005', template: 'x', params: {} })
        .then(() => null)
        .catch((err) => err);
      delete process.env.NOTIFICATIONS_PUSH_ENABLED;
      delete process.env.FCM_SERVICE_ACCOUNT_JSON;
    });

    expect(fcmRefusal).toBeTruthy();
    expect(
      fcmRefusal.code === 'LIVE_PROVIDER_REFUSED_IN_TEST' ||
        /Cannot find module 'firebase-admin'/.test(fcmRefusal.message)
    ).toBe(true);
  });
});
