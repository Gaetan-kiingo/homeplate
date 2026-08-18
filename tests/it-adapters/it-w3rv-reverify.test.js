// tests/it-adapters/it-w3rv-reverify.test.js — INDEPENDENT re-verification of the it-adapters
// lane's round-1 findings (IT-F1..IT-F4), written for verification round 2.
//
// A fixer's claim plus a green suite is not confirmation: the suite was green before these
// defects were found. Each block below re-executes the ORIGINAL failureScenario recorded in
// docs/_generated/verification-findings-wave3.json and asserts the observed-wrong behaviour no
// longer occurs — using its own probes rather than the assertions the fixer shipped.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-07  (IT-F2, IT-04) — the safety-alert surface exists, persists and defers
//   FR-02 / NFR-12 (IT-F3) — no object-storage adapter is loaded on a request path
//   FR-13 / NFR-09 (IT-F4) — neither comms adapter can reach a live provider from the suite
//   NFR-10 / FR-08 (IT-F1) — the ADR-008 evaluation set's claimability state, honestly reported
'use strict';

const path = require('path');
const request = require('supertest');

const config = require('../../src/config');
const { createApp } = require('../../src/app');
const { encrypt } = require('../../src/db/fieldCrypto');
const sessions = require('../../src/modules/auth/sessions');
const { loadHandlers } = require('../../src/outbox/dispatch');
const { pollOnce } = require('../../src/outbox/worker');
const mockTransport = require('../../src/adapters/mockTransport');
const dbh = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const quietLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  child() {
    return this;
  },
};

let app;
let registry;

beforeAll(async () => {
  expect(config.isTest).toBe(true);
  app = createApp();
  registry = loadHandlers({ log: quietLog });
});

beforeEach(() => {
  mockTransport.reset();
});

afterAll(async () => {
  mockTransport.reset();
  await dbh.closeDb();
  await closeTestRedis();
});

// pollOnce() claims from the WHOLE shared outbox_jobs table, so this drain also delivers
// whatever rows other suites in the run left pending (a full run ends with ~35 delivered
// email.verification + pending notify.booking/safety.alert rows). Those deliveries land in
// THIS file's process-global mockTransport buffer, so no assertion below may read that buffer,
// or any whole-table count, as if it described this test alone — see quiesceQueue() and
// deliveriesFor() (finding TCBV2-02).
//
// Termination is by "nothing left to claim", never by a fixed pass count (which starves a
// queue longer than the count — TCBV2-01), with a wall-clock deadline under the 15 s Jest
// timeout so a genuinely stuck queue fails with a diagnosis instead of hanging.
const DRAIN_DEADLINE_MS = 10_000;

async function drainDue() {
  const deadline = Date.now() + DRAIN_DEADLINE_MS;
  let stats;
  let passes = 0;
  do {
    stats = await pollOnce({ registry, log: quietLog });
    passes += 1;
    if (stats.claimed > 0 && Date.now() > deadline) {
      throw new Error(
        `drainDue: outbox_jobs did not quiesce within ${DRAIN_DEADLINE_MS} ms ` +
          `(${passes} passes, last claimed=${stats.claimed}, delivered=${stats.delivered}, ` +
          `retried=${stats.retried}, deadLettered=${stats.deadLettered})`
      );
    }
  } while (stats.claimed > 0);
}

/**
 * Drain every due job the run has accumulated and then clear the mock transport, so the
 * buffer that follows holds ONLY what the code under test does next. Without the reset the
 * buffer still holds the foreign templates this drain just delivered.
 */
async function quiesceQueue() {
  await drainDue();
  mockTransport.reset();
}

/** The deliveries this alert/booking caused — the queue and the buffer are shared, identity is not. */
function deliveriesFor({ alertId, bookingId }) {
  // An undefined id must never match a delivery whose params simply lack that key, or the
  // filter would silently widen back to "everything the shared queue happened to deliver".
  return mockTransport
    .deliveries()
    .filter(
      (d) =>
        d.params &&
        ((alertId !== undefined && d.params.alertId === alertId) ||
          (bookingId !== undefined && d.params.bookingId === bookingId))
    );
}

async function cookieFor(user) {
  const { token } = await sessions.createSession({ id: user.id, roles: user.roles || ['user'] });
  return `${config.auth.sessionCookieName}=${token}`;
}

// =============================================================================================
describe('IT-F2 re-verification (blocker) · FR-07 safety-alert surface', () => {
  // ORIGINAL failureScenario: "POST /api/bookings/<uuid>/safety-alerts through supertest against
  // createApp() returns 404, and GET /api/moderation/alerts returns 404 … src/routes/index.js's
  // KNOWN_MODULES registry already names 'safety', so the registry advertises a module that
  // cannot be mounted … no SAFETY_ALERT row is ever created by the system."
  test('the two routes that returned 404 are mounted, and a stranger/anonymous caller is refused on merit', async () => {
    const unknownBooking = '00000000-0000-4000-8000-000000000001';

    // Anonymous: 401 (authentication), not 404 (route missing).
    const anon = await request(app).post(`/api/bookings/${unknownBooking}/safety-alerts`).send({});
    expect(anon.status).toBe(401);

    // Authenticated non-participant on a booking that does not exist: 404 for the BOOKING,
    // which is a different 404 — proven by the moderator listing below answering 200/403.
    const stranger = await dbh.makeUser();
    const strangerRes = await request(app)
      .post(`/api/bookings/${unknownBooking}/safety-alerts`)
      .set('Cookie', await cookieFor(stranger))
      .send({});
    expect([403, 404]).toContain(strangerRes.status);

    // GET /api/moderation/alerts: a non-moderator is refused with 403 (mounted + authorised),
    // and a moderator gets a listing.
    const asUser = await request(app)
      .get('/api/moderation/alerts')
      .set('Cookie', await cookieFor(stranger));
    expect(asUser.status).toBe(403);

    const moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
    const asModerator = await request(app)
      .get('/api/moderation/alerts')
      .set('Cookie', await cookieFor(moderator));
    expect(asModerator.status).toBe(200);
    expect(Array.isArray(asModerator.body.alerts)).toBe(true);
  });

  test('a participant raises an alert: 201, row persisted, deferred — nothing delivered inline (ADR-001)', async () => {
    const contact = 'help@contact.example';
    const hostUser = await dbh.makeUser({ can_publish_listing: true });
    const listing = await dbh.makeListing({
      host_id: hostUser.id,
      moderation_status: 'approved',
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const guest = await dbh.makeUser({ emergency_contact_email_enc: encrypt(contact) });
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    // Empty the queue AND the transport buffer: the drain itself delivers other suites' rows
    // (email.verification, notify.booking …) through this file's mock transport, so the
    // "nothing was delivered inline" check below must start from a buffer cleared AFTER it.
    await quiesceQueue();

    const before = (await dbh.query('SELECT count(*)::int AS n FROM notification_attempts')).rows[0]
      .n;
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/safety-alerts`)
      .set('Cookie', await cookieFor(guest))
      .send({});
    expect(res.status).toBe(201);
    const alertId = res.body.alert.id;

    // The alert row and its outbox row committed together; NOTHING was delivered on the
    // request path — the row count is unchanged until the worker runs.
    const alert = (await dbh.query('SELECT * FROM safety_alerts WHERE id = $1', [alertId])).rows[0];
    expect(alert).toBeTruthy();
    expect(alert.booking_id).toBe(booking.id);
    expect(alert.delivery_status).toBe('pending');
    const job = (
      await dbh.query(
        `SELECT * FROM outbox_jobs WHERE type = 'safety.alert' AND payload->>'alertId' = $1`,
        [alertId]
      )
    ).rows[0];
    expect(job).toBeTruthy();
    expect(job.status).toBe('pending');
    // ADR-003: IDs only — no address, name or free text in the payload.
    expect(JSON.stringify(job.payload)).not.toContain(contact);
    expect(
      (await dbh.query('SELECT count(*)::int AS n FROM notification_attempts')).rows[0].n
    ).toBe(before);
    // ADR-001, both ways round: nothing AT ALL reached the transport between the quiesce and
    // now (only this request ran), and in particular nothing for this alert or its booking.
    expect(mockTransport.deliveries()).toHaveLength(0);
    expect(deliveriesFor({ alertId, bookingId: booking.id })).toHaveLength(0);
    expect(
      (
        await dbh.query(
          `SELECT count(*)::int AS n FROM notification_attempts WHERE params->>'alertId' = $1`,
          [alertId]
        )
      ).rows[0].n
    ).toBe(0);

    // The alert is reviewable in the moderator queue BEFORE any delivery succeeds.
    const moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
    const queued = await request(app)
      .get('/api/moderation/alerts')
      .set('Cookie', await cookieFor(moderator));
    expect(queued.status).toBe(200);
    expect(queued.body.alerts.map((a) => a.id)).toContain(alertId);

    // Worker leg: moderator notified AND the emergency contact emailed, alert 'delivered'.
    await drainDue();
    const attempts = (
      await dbh.query(
        `SELECT template, status FROM notification_attempts WHERE params->>'alertId' = $1`,
        [alertId]
      )
    ).rows;
    const byTemplate = Object.fromEntries(attempts.map((a) => [a.template, a.status]));
    expect(byTemplate['safety-alert-moderator']).toBe('sent');
    expect(byTemplate['safety-alert-emergency']).toBe('sent');
    // Matched on THIS alert's id, not on the template alone: this drain also delivers any
    // safety.alert row another suite left pending, and a foreign 'safety-alert-emergency'
    // would otherwise satisfy the check while our own leg silently failed (TCBV2-02).
    const emergencyDelivery = deliveriesFor({ alertId, bookingId: booking.id }).find(
      (d) => d.template === 'safety-alert-emergency'
    );
    expect(emergencyDelivery).toBeTruthy();
    // §3.4 PII register: the persisted params carry IDs only, never the contact address.
    expect(JSON.stringify(emergencyDelivery.params)).not.toContain(contact);
    expect(
      (await dbh.query('SELECT delivery_status FROM safety_alerts WHERE id = $1', [alertId]))
        .rows[0].delivery_status
    ).toBe('delivered');
  });

  test('injected provider outage: alert goes "retrying", stays listed, and completes on recovery (NFR-09)', async () => {
    const hostUser = await dbh.makeUser({ can_publish_listing: true });
    const listing = await dbh.makeListing({
      host_id: hostUser.id,
      moderation_status: 'approved',
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const guest = await dbh.makeUser({
      emergency_contact_email_enc: encrypt('outage-contact@contact.example'),
    });
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
    // Quiesce first so the single pollOnce() below claims THIS alert's job (batch size 10)
    // rather than spending its batch on rows other suites left pending.
    await quiesceQueue();

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/safety-alerts`)
      .set('Cookie', await cookieFor(guest))
      .send({});
    expect(res.status).toBe(201);
    const alertId = res.body.alert.id;

    // Fail ONLY the emergency-contact leg at the adapter boundary — a provider outage.
    const real = mockTransport.adapter.deliver.bind(mockTransport.adapter);
    const spy = jest
      .spyOn(mockTransport.adapter, 'deliver')
      .mockImplementation(async (input) =>
        input.template === 'safety-alert-emergency'
          ? Promise.reject(new Error('injected provider outage'))
          : real(input)
      );
    try {
      await pollOnce({ registry, log: quietLog });
      const during = (
        await dbh.query('SELECT delivery_status FROM safety_alerts WHERE id = $1', [alertId])
      ).rows[0].delivery_status;
      // Never silently 'pending' while the worker is fighting with the provider.
      expect(['retrying', 'failed']).toContain(during);

      // The job is deferred, not dropped: still pending, backed off into the future.
      const job = (
        await dbh.query(
          `SELECT * FROM outbox_jobs WHERE type = 'safety.alert' AND payload->>'alertId' = $1`,
          [alertId]
        )
      ).rows[0];
      expect(['pending', 'dead']).toContain(job.status);
      expect(job.attempt_count).toBeGreaterThanOrEqual(1);

      // And it is STILL visible for review throughout the outage (FR-07).
      const listed = await request(app)
        .get('/api/moderation/alerts')
        .set('Cookie', await cookieFor(moderator));
      expect(listed.status).toBe(200);
      expect(listed.body.alerts.map((a) => a.id)).toContain(alertId);
    } finally {
      spy.mockRestore();
    }

    // Recovery completes the SAME alert.
    await dbh.query(
      `UPDATE outbox_jobs SET status = 'pending', available_at = now()
        WHERE type = 'safety.alert' AND payload->>'alertId' = $1`,
      [alertId]
    );
    await drainDue();
    expect(
      (await dbh.query('SELECT delivery_status FROM safety_alerts WHERE id = $1', [alertId]))
        .rows[0].delivery_status
    ).toBe('delivered');
  });

  test('no emergency contact on file: the moderator is still notified and the alert reads "no_channel"', async () => {
    const hostUser = await dbh.makeUser({ can_publish_listing: true });
    const listing = await dbh.makeListing({
      host_id: hostUser.id,
      moderation_status: 'approved',
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const guest = await dbh.makeUser(); // no emergency_contact_email_enc
    const booking = await dbh.makeBooking({ listing_id: listing.id, guest_id: guest.id });
    await quiesceQueue();

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/safety-alerts`)
      .set('Cookie', await cookieFor(guest))
      .send({});
    expect(res.status).toBe(201);
    const alertId = res.body.alert.id;
    await drainDue();

    const templates = (
      await dbh.query(
        `SELECT template, status FROM notification_attempts WHERE params->>'alertId' = $1`,
        [alertId]
      )
    ).rows;
    expect(
      templates.some((t) => t.template === 'safety-alert-moderator' && t.status === 'sent')
    ).toBe(true);
    expect(
      (await dbh.query('SELECT delivery_status FROM safety_alerts WHERE id = $1', [alertId]))
        .rows[0].delivery_status
    ).toBe('no_channel');
  });
});

// =============================================================================================
describe('IT-F3 / W3-ADR-01 re-verification · no object-storage adapter on the request path', () => {
  // ORIGINAL failureScenario: "POST /api/media → mediaService.attach() → getStorage() at
  // src/modules/media/service.js:45 does require('../../adapters/objectStorage') on the request
  // path. src/adapters/objectStorage.js:220 builds `const defaultAdapter = createObjectStorage()`
  // at module load, so the first media attach in a fresh process constructs an S3Client
  // (endpoint + credentials) inside a request handler."
  test('attach() rejects a bad key WITHOUT loading src/adapters/objectStorage into the registry', async () => {
    const adapterPath = require.resolve('../../src/adapters/objectStorage');
    // Baseline: the adapters THIS test file's own top-level imports already pulled in (the mock
    // transport and, through it, sendgrid/fcm/maps). The claim under test is that loading and
    // calling the media service adds NOTHING to that set — objectStorage above all.
    const adaptersBefore = Object.keys(require.cache)
      .filter((f) => f.includes('/src/adapters/'))
      .sort();
    expect(adaptersBefore).not.toContain(adapterPath);
    let loadedAdapters;
    let attachPromise;
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      const mediaService = require('../../src/modules/media/service');
      // attach() is async, so the rejection is captured, not thrown; the module-loading
      // snapshot below is taken while the isolated registry is still the live one.
      attachPromise = mediaService
        .attach('00000000-0000-4000-8000-000000000001', '../escape', 'listing')
        .then(
          () => null,
          (err) => err
        );
      loadedAdapters = Object.keys(require.cache)
        .filter((f) => f.includes('/src/adapters/'))
        .sort();
      expect(require.cache[adapterPath]).toBeUndefined();
    });
    // The pure validator still enforces the rule — the behaviour was preserved, not deleted.
    const thrown = await attachPromise;
    expect(thrown).toBeTruthy();
    expect(thrown.code || thrown.name).toMatch(/INVALID_STORAGE_KEY|ValidationError/);
    expect(loadedAdapters).toEqual(adaptersBefore);
    expect(loadedAdapters).not.toContain(adapterPath);
    jest.resetModules();
  });
});

// =============================================================================================
describe('IT-F4 re-verification · neither comms adapter can reach a live provider from the suite', () => {
  // ORIGINAL failureScenario (observed live, not hypothesised): "sendgrid.adapter.deliver(...)
  // inside the Jest suite with SENDGRID_API_KEY set in process.env and the provider SDK NOT
  // mocked … the process made an outbound HTTPS request to api.sendgrid.com; jest reported
  // 'UpstreamServiceError: SendGrid send failed … Cause: Unauthorized'."
  const savedKey = process.env.SENDGRID_API_KEY;
  const savedPush = process.env.NOTIFICATIONS_PUSH_ENABLED;
  const savedFcm = process.env.FCM_SERVICE_ACCOUNT_JSON;

  afterEach(() => {
    const restore = (k, v) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    };
    restore('SENDGRID_API_KEY', savedKey);
    restore('NOTIFICATIONS_PUSH_ENABLED', savedPush);
    restore('FCM_SERVICE_ACCOUNT_JSON', savedFcm);
    jest.resetModules();
  });

  test('SendGrid: a stray API key + a direct deliver() is refused permanently, never put on the wire', async () => {
    process.env.SENDGRID_API_KEY = 'SG.stray-key-left-in-the-environment';
    let sg;
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      sg = require('../../src/adapters/sendgrid');
    });
    await expect(
      sg.adapter.deliver({
        userId: '00000000-0000-4000-8000-000000000001',
        recipientEmail: 'guest@example.test',
        template: 'safety-alert-emergency',
        params: { alertId: 'alert-it-f4' },
      })
    ).rejects.toMatchObject({ code: 'LIVE_PROVIDER_REFUSED_IN_TEST', retryable: false });
  });

  test('FCM: the same reciprocal guard, even with push enabled and a service account present', async () => {
    process.env.NOTIFICATIONS_PUSH_ENABLED = 'true';
    process.env.FCM_SERVICE_ACCOUNT_JSON = JSON.stringify({
      project_id: 'p',
      client_email: 'a@b.test',
      private_key: 'k',
    });
    let fcm;
    jest.isolateModules(() => {
      // eslint-disable-next-line global-require
      fcm = require('../../src/adapters/fcm');
    });
    await expect(
      fcm.adapter.deliver({
        userId: '00000000-0000-4000-8000-000000000001',
        channel: 'push',
        template: 'booking.created',
        params: { bookingId: 'b-1' },
      })
    ).rejects.toMatchObject({ retryable: false });
    // The ambient ADR-011 gate never opened.
    expect(config.notifications.push.enabled).toBe(false);
  });
});

// =============================================================================================
describe('IT-F1 re-verification (blocker) · NFR-10 is still unclaimable — set only, no measurement', () => {
  // ORIGINAL failureScenario: no evaluation set (0 of 200 items), no results file, no sign-off,
  // no ADR-002 pipeline. The SET half was closed in repair round 1; the rest was not, and NFR-10
  // remains open. This asserts the honest state rather than inferring a pass from a green suite.
  test('the set conforms to ADR-008 but the claim is refused for want of a pipeline and a sign-off', () => {
    // eslint-disable-next-line global-require
    const evalSet = require('../fixtures/moderation-eval');
    const set = evalSet.loadSet('v1');
    expect(evalSet.validateSet(set)).toEqual([]);
    expect(set.items.length).toBeGreaterThanOrEqual(200);
    expect(set.manifest.labelReview.status).toBe('unreviewed');

    const verdict = evalSet.claimability({
      set,
      modelId: 'models/gemini-2.0-flash',
      promptVersion: 'moderation-prompt-v1',
    });
    expect(verdict.claimable).toBe(false);
    expect(verdict.reasons.join(' ')).toMatch(/sign-off/i);

    // And there is still nothing to score it through: wave 4 owns the ADR-002 pipeline.
    // eslint-disable-next-line global-require
    expect(require('fs').existsSync(path.join(REPO_ROOT, 'src', 'modules', 'moderation'))).toBe(
      false
    );
    expect(registry.has('moderation.scan')).toBe(false);
  });
});
