// tests/adr-conformance/reverify-round2-adr.test.js — INDEPENDENT RE-VERIFICATION (round 2) of
// the binding ADR invariants over the surfaces that repair round 1 added or changed, plus a
// from-scratch re-execution of the original failure scenarios behind W3-ADR-01 and W3-ADR-02.
//
// Why this file exists next to verify-adr-wave0-3.test.js: that file was written against commit
// 3136b91. Repair round 1 (f7f954c) LANDED A NEW MOUNTED MODULE — src/modules/safety/routes.js,
// which adds POST /api/bookings/:id/safety-alerts and GET /api/moderation/alerts — and neither
// route is exercised by any adapter-purity audit. GET /api/moderation/alerts is in addition the
// first MODERATION VIEW in the tree, so ADR-010 (j) "moderation views" was previously
// not_implemented and is now testable. Four other request paths were never exercised by the
// (a) audit either (auth login/logout/verify-email, PATCH /api/users/me, listing cancel,
// booking confirm-completion).
//
// Requirement / decision traceability (SRS Appendix B):
//   ADR-001/003 (a) — no external adapter may be reached, or even module-loaded, on ANY
//                     request path. Only worker code may.
//   ADR-001/003 (b) — the business row and its outbox row commit in ONE transaction.
//   ADR-003 (c)     — outbox payloads carry IDs only.
//   ADR-005/007/011 (h/k) — NODE_ENV=test must REFUSE a live adapter, not merely default away
//                     from one (the W3-ADR-02 failure scenario, re-executed in a child process).
//   ADR-010 (j)     — the PUBLIC serializer is the default on every read path, INCLUDING the
//                     FR-07 moderator queue.
//   ADR-011 (k)     — every delivery attempt writes a NOTIFICATION_ATTEMPT row; no live send.
//   FR-07           — safety alerts.
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');

const dbh = require('../helpers/db');

const ROOT = path.join(__dirname, '..', '..');

const STREET_SECRET = 'Reverify Hidden Kitchen Lane';
const PRECISE_LAT = 32.987654;
const PRECISE_LNG = -117.187654;

let app;
let config;
let sessions;

function loadedAdapters() {
  return Object.keys(require.cache)
    .filter((p) => p.includes(`${path.sep}src${path.sep}adapters${path.sep}`))
    .map((p) => path.basename(p))
    .sort();
}

async function cookieFor(user) {
  const { token } = await sessions.createSession({ id: user.id, roles: user.roles });
  return `${config.auth.sessionCookieName}=${token}`;
}

async function makeEligibleHost(overrides = {}) {
  const host = await dbh.makeUser({
    can_publish_listing: true,
    phone_enc: 'enc:v1:reverify-fixture',
    ...overrides,
  });
  await dbh.makeHostProfile({ user_id: host.id });
  return host;
}

async function makeEligibleGuest(overrides = {}) {
  return dbh.makeUser({ phone_enc: 'enc:v1:reverify-fixture', ...overrides });
}

let daySeq = 0;
function uniqueFutureStart() {
  daySeq += 1;
  // 2033 keeps these fixture days clear of every other lane's.
  return new Date(Date.UTC(2033, 3, 1 + daySeq, 19, 0, 0)).toISOString();
}

function listingBody(overrides = {}) {
  return {
    title: 'Round-two verifier menu',
    description: 'ADR re-verification (round 2) fixture meal.',
    ingredients: ['rice', 'beans'],
    allergens: ['none'],
    cuisine: 'reverifylane',
    scheduledStart: uniqueFutureStart(),
    durationMinutes: 90,
    seatCapacity: 4,
    addressLine1: `77 ${STREET_SECRET}`,
    city: 'San Diego',
    region: 'CA',
    postalCode: '92104',
    ...overrides,
  };
}

async function approve(listingId) {
  await dbh.query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [listingId]);
}

beforeAll(() => {
  const { createApp } = require('../../src/app');
  app = createApp();
  config = require('../../src/config');
  sessions = require('../../src/modules/auth/sessions');
});

afterAll(async () => {
  const { closeRedis } = require('../../src/db/redis');
  await dbh.closeDb();
  await closeRedis();
});

// ============================================================================================
// (a) ADR-001 — the request paths repair round 1 added, and the ones the round-1 audit missed
// NOTE: this describe MUST stay first in the file; later blocks legitimately load adapters.
// ============================================================================================
describe('(a) ADR-001/003 — adapter purity on the route surface added/missed in round 1', () => {
  test('app boot loads zero adapter modules', () => {
    expect(loadedAdapters()).toEqual([]);
  });

  test('safety, auth, users, listing-cancel and completion routes load NO adapter', async () => {
    const password = 'Sufficiently-Long-Passphrase-9';
    const email = `reverify.${crypto.randomUUID()}@adrlane.invalid`;

    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const guest = await makeEligibleGuest();
    const guestCookie = await cookieFor(guest);

    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(listingBody());
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;
    await approve(listingId);
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .send({ listingId });
    expect(booked.status).toBe(201);
    const bookingId = booked.body.booking.id;

    // A second listing that we will cancel, so the cancel path is exercised on its own row.
    const toCancel = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(listingBody());
    expect(toCancel.status).toBe(201);

    const moderator = await dbh.makeUser({ roles: ['moderator'] });
    const moderatorCookie = await cookieFor(moderator);

    const perRoute = [];
    const check = async (label, fn) => {
      const before = loadedAdapters();
      const res = await fn();
      const newly = loadedAdapters().filter((a) => !before.includes(a));
      perRoute.push({ label, status: res && res.status, newly });
      return res;
    };

    // --- auth (wave 0-1) paths the round-1 audit never exercised ---
    await check('POST /api/auth/register (login fixture)', () =>
      request(app)
        .post('/api/auth/register')
        .send({ email, password, fullName: 'Reverify Registrant' })
    );
    const login = await check('POST /api/auth/login', () =>
      request(app).post('/api/auth/login').send({ email, password })
    );
    expect(login.status).toBe(200);
    const loginCookie = login.headers['set-cookie'][0].split(';')[0];
    await check('POST /api/auth/verify-email (bad token)', () =>
      request(app)
        .post('/api/auth/verify-email')
        .send({ token: crypto.randomBytes(32).toString('hex') })
    );
    await check('GET /api/auth/verify-email (bad token)', () =>
      request(app)
        .get('/api/auth/verify-email')
        .query({ token: crypto.randomBytes(32).toString('hex') })
    );
    await check('POST /api/auth/logout', () =>
      request(app).post('/api/auth/logout').set('Cookie', loginCookie)
    );

    // --- users ---
    await check('PATCH /api/users/me', () =>
      request(app)
        .patch('/api/users/me')
        .set('Cookie', hostCookie)
        .send({ fullName: 'Reverify Renamed' })
    );

    // --- FR-07 safety (landed in repair round 1 — never audited) ---
    const alert = await check('POST /api/bookings/:id/safety-alerts', () =>
      request(app)
        .post(`/api/bookings/${bookingId}/safety-alerts`)
        .set('Cookie', guestCookie)
        .send()
    );
    expect(alert.status).toBe(201);
    await check('GET /api/moderation/alerts', () =>
      request(app).get('/api/moderation/alerts').set('Cookie', moderatorCookie)
    );

    // --- completion + cancel ---
    await check('POST /api/bookings/:id/confirm-completion', () =>
      request(app)
        .post(`/api/bookings/${bookingId}/confirm-completion`)
        .set('Cookie', guestCookie)
        .send({})
    );
    await check('POST /api/listings/:id/cancel', () =>
      request(app)
        .post(`/api/listings/${toCancel.body.listing.id}/cancel`)
        .set('Cookie', hostCookie)
        .send({})
    );

    const offenders = perRoute.filter((r) => r.newly.length > 0);
    expect({
      offenders,
      all: perRoute.map((r) => `${r.label} [${r.status}] -> ${r.newly.join(',') || 'none'}`),
    }).toMatchObject({ offenders: [] });
  });
});

// ============================================================================================
// (b)+(c) ADR-001/003 — the FR-07 alert row and its outbox row are ONE transaction, IDs only
// ============================================================================================
describe('(b/c) ADR-003 — FR-07 safety alert: one transaction, IDs-only payload', () => {
  test('safety_alerts row and its safety.alert outbox row share one xmin', async () => {
    const host = await makeEligibleHost();
    const guest = await makeEligibleGuest();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    const listingId = created.body.listing.id;
    await approve(listingId);
    const guestCookie = await cookieFor(guest);
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .send({ listingId });
    const bookingId = booked.body.booking.id;

    const res = await request(app)
      .post(`/api/bookings/${bookingId}/safety-alerts`)
      .set('Cookie', guestCookie)
      .send();
    expect(res.status).toBe(201);
    const alertId = res.body.alert.id;

    const { rows: alertRows } = await dbh.query(
      `SELECT xmin::text AS xid FROM safety_alerts WHERE id = $1`,
      [alertId]
    );
    const { rows: jobRows } = await dbh.query(
      `SELECT type, payload, xmin::text AS xid FROM outbox_jobs WHERE payload->>'alertId' = $1`,
      [alertId]
    );
    expect(jobRows.map((r) => r.type)).toEqual(['safety.alert']);
    expect(new Set([alertRows[0].xid, ...jobRows.map((r) => r.xid)]).size).toBe(1);

    // IDs only — no email, no street text, every value a UUID.
    const payload = jobRows[0].payload;
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    for (const [k, v] of Object.entries(payload)) {
      expect({ k, ok: typeof v === 'string' && UUID.test(v) }).toEqual({ k, ok: true });
    }
    expect(JSON.stringify(payload)).not.toContain(STREET_SECRET);
    expect(JSON.stringify(payload)).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });
});

// ============================================================================================
// (j) ADR-010 — the FR-07 MODERATION VIEW must default to the public projection
// ============================================================================================
describe('(j) ADR-010 — the moderator alert queue discloses no address or coordinate', () => {
  test('GET /api/moderation/alerts carries IDs only, never the exact address', async () => {
    const host = await makeEligibleHost();
    const guest = await makeEligibleGuest();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    const listingId = created.body.listing.id;
    await approve(listingId);
    const { coarsen } = require('../../src/lib/geoPrecision');
    const coarse = coarsen(PRECISE_LAT, PRECISE_LNG);
    await dbh.query(
      `UPDATE listings SET lat=$2, lng=$3, coarse_lat=$4, coarse_lng=$5, area_label='North Park'
        WHERE id = $1`,
      [listingId, PRECISE_LAT, PRECISE_LNG, coarse.lat, coarse.lng]
    );
    const guestCookie = await cookieFor(guest);
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .send({ listingId });
    const bookingId = booked.body.booking.id;
    await request(app)
      .post(`/api/bookings/${bookingId}/safety-alerts`)
      .set('Cookie', guestCookie)
      .send();

    const moderator = await dbh.makeUser({ roles: ['moderator'] });
    const queue = await request(app)
      .get('/api/moderation/alerts')
      .set('Cookie', await cookieFor(moderator));
    expect(queue.status).toBe(200);
    const text = JSON.stringify(queue.body);
    expect(text).not.toContain(STREET_SECRET);
    expect(text).not.toContain(String(PRECISE_LAT));
    expect(text).not.toContain(String(PRECISE_LNG));
    const entry = queue.body.alerts.find((a) => a.bookingId === bookingId);
    expect(entry).toBeDefined();
    expect(Object.keys(entry).sort()).toEqual([
      'bookingId',
      'bookingStatus',
      'createdAt',
      'deliveredAt',
      'deliveryStatus',
      'hostId',
      'id',
      'listingId',
      'raisedByUserId',
      'updatedAt',
    ]);
  });

  test('a non-moderator is refused the queue (role gate, not obscurity)', async () => {
    const nobody = await makeEligibleGuest();
    const res = await request(app)
      .get('/api/moderation/alerts')
      .set('Cookie', await cookieFor(nobody));
    expect(res.status).toBe(403);
  });
});

// ============================================================================================
// (k) ADR-011 — draining the FR-07 alert writes NOTIFICATION_ATTEMPT rows, sends nothing live
// ============================================================================================
describe('(k) ADR-011 — safety.alert delivery is worker-only and fully recorded', () => {
  test('the alert delivery attempt is persisted, and the transport is the mock', async () => {
    const host = await makeEligibleHost();
    const guest = await makeEligibleGuest();
    await dbh.makeUser({ roles: ['moderator'] });
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    const listingId = created.body.listing.id;
    await approve(listingId);
    const guestCookie = await cookieFor(guest);
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .send({ listingId });
    const raised = await request(app)
      .post(`/api/bookings/${booked.body.booking.id}/safety-alerts`)
      .set('Cookie', guestCookie)
      .send();
    expect(raised.status).toBe(201);

    // Nothing has been delivered yet: delivery is the worker's job, never the request's.
    const beforeRows = await dbh.query(
      `SELECT count(*)::int AS n FROM notification_attempts WHERE idempotency_key LIKE $1`,
      [`%${raised.body.alert.id}%`]
    );
    expect(beforeRows.rows[0].n).toBe(0);

    const worker = require('../../src/outbox/worker');
    const dispatch = require('../../src/outbox/dispatch');
    const quiet = { info() {}, warn() {}, error() {}, debug() {}, child: () => quiet };
    const registry = dispatch.loadHandlers({ log: quiet });
    for (let i = 0; i < 5; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const stats = await worker.pollOnce({ registry, log: quiet, batchSize: 50 });
      if (stats && stats.claimed === 0) break;
    }

    const after = await dbh.query(
      `SELECT channel, status, template, params, idempotency_key
         FROM notification_attempts WHERE idempotency_key LIKE $1`,
      [`%${raised.body.alert.id}%`]
    );
    expect(after.rows.length).toBeGreaterThan(0);
    for (const row of after.rows) {
      expect(row.channel).toBe('email');
      expect(JSON.stringify(row)).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
    }
    expect(config.notifications.transport).toBe('mock');
    expect(config.notifications.push.enabled).toBe(false);
  });
});

// ============================================================================================
// W3-ADR-02 re-verification — the ORIGINAL failure scenario, re-executed in a child process
// ============================================================================================
describe('W3-ADR-02 re-verification — NODE_ENV=test refuses a live adapter', () => {
  const probe = (extraEnv) => {
    const script =
      "require('./tests/helpers/env');" +
      "const c=require('./src/config');" +
      'console.log(JSON.stringify({moderation:c.moderation.mode,maps:c.maps.mode,transport:c.notifications.transport}));';
    try {
      const out = execFileSync(process.execPath, ['-e', script], {
        cwd: ROOT,
        env: { ...process.env, ...extraEnv },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, out: out.trim() };
    } catch (err) {
      return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}` };
    }
  };

  test('a leftover LLM_MODERATION_MODE=live shell cannot flip the suite onto the live provider', () => {
    const res = probe({
      LLM_MODERATION_MODE: 'live',
      LLM_MODERATION_BASE_URL: 'https://example.invalid/v1',
      LLM_MODERATION_API_KEY: 'not-a-real-key',
      MODERATION_MODEL: 'some-model-id',
      ALLOW_LIVE_ADAPTERS_IN_TESTS: '',
    });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.out).moderation).toBe('mock');
  });

  test('a leftover MAPS_MODE=live shell cannot flip the suite onto the live provider', () => {
    const res = probe({
      MAPS_MODE: 'live',
      MAPS_API_KEY: 'not-a-real-key',
      ALLOW_LIVE_ADAPTERS_IN_TESTS: '',
    });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.out).maps).toBe('mock');
  });

  test('NOTIFICATIONS_TRANSPORT=sendgrid is still refused outright under NODE_ENV=test', () => {
    const res = probe({
      NOTIFICATIONS_TRANSPORT: 'sendgrid',
      SENDGRID_API_KEY: 'SG.not-real',
      SENDGRID_FROM_EMAIL: 'no@example.invalid',
    });
    // env.js pins the transport to mock, so the value never reaches config; either outcome is
    // conformant as long as no live transport is selected.
    if (res.ok) expect(JSON.parse(res.out).transport).toBe('mock');
    else expect(res.out).toMatch(/NOTIFICATIONS_TRANSPORT must be mock/);
  });

  test('the config layer itself refuses a live adapter under NODE_ENV=test (defence in depth)', () => {
    const script =
      "process.env.NODE_ENV='test';" +
      'delete process.env.ALLOW_LIVE_ADAPTERS_IN_TESTS;' +
      "process.env.LLM_MODERATION_MODE='live';" +
      "process.env.LLM_MODERATION_BASE_URL='https://example.invalid/v1';" +
      "process.env.LLM_MODERATION_API_KEY='k';" +
      "process.env.MODERATION_MODEL='m';" +
      "const {validateEnv}=require('./src/config/schema');" +
      "try{validateEnv(process.env);console.log('ACCEPTED');}catch(e){console.log('REFUSED: '+e.message);}";
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL,
      },
      encoding: 'utf8',
    });
    expect(out).toMatch(/REFUSED/);
    expect(out).toMatch(/ALLOW_LIVE_ADAPTERS_IN_TESTS/);
  });
});
