// tests/adr-conformance/verify-adr-wave0-3.test.js — INDEPENDENT re-verification of the
// binding ADR-001..011 invariants over the waves 0-3 surface (verifier-owned lane).
//
// This file deliberately does NOT reuse the assertions in adr-invariants.test.js /
// adr-wave3-invariants.test.js: it re-derives each invariant from the ADR text with its own
// probes, and widens coverage where the existing lane leaves a gap (notably: the FULL mounted
// route surface for the ADR-001 adapter-purity rule, xmin-level proof of the single-transaction
// outbox write, and a from-scratch ADR-009 LA-boundary probe driven from a non-LA client).
//
// ORDERING: every require.cache purity assertion lives in the FIRST describe block; tests that
// legitimately load adapters (worker drain, object-storage round trip) run afterwards.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');

const dbh = require('../helpers/db');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const STREET_SECRET = 'Verifier Hidden Kitchen Lane';
const PRECISE_LAT = 32.912345;
const PRECISE_LNG = -117.212345;

let app;
let config;
let sessions;

function loadedAdapters() {
  return Object.keys(require.cache)
    .filter((p) => p.includes(`${path.sep}src${path.sep}adapters${path.sep}`))
    .map((p) => path.basename(p))
    .sort();
}

function listJsFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(p));
    else if (entry.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

async function cookieFor(user) {
  const { token } = await sessions.createSession({ id: user.id, roles: user.roles });
  return `${config.auth.sessionCookieName}=${token}`;
}

async function makeEligibleHost(overrides = {}) {
  const host = await dbh.makeUser({
    can_publish_listing: true,
    phone_enc: 'enc:v1:verifier-fixture',
    ...overrides,
  });
  await dbh.makeHostProfile({ user_id: host.id });
  return host;
}

async function makeEligibleGuest(overrides = {}) {
  return dbh.makeUser({ phone_enc: 'enc:v1:verifier-fixture', ...overrides });
}

let daySeq = 0;
function uniqueFutureStart() {
  daySeq += 1;
  // 2031 keeps these clear of every other lane's fixture days.
  return new Date(Date.UTC(2031, 4, 1 + daySeq, 19, 0, 0)).toISOString();
}

function listingBody(overrides = {}) {
  return {
    title: 'Verifier tasting menu',
    description: 'ADR re-verification fixture meal.',
    ingredients: ['rice', 'beans'],
    allergens: ['none'],
    cuisine: 'verifierlane',
    scheduledStart: uniqueFutureStart(),
    durationMinutes: 90,
    seatCapacity: 4,
    addressLine1: `901 ${STREET_SECRET}`,
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
// (a) ADR-001/003 — NO external adapter on ANY mounted request path
// ============================================================================================
describe('(a) ADR-001/003 — adapter purity across the FULL mounted route surface', () => {
  test('app boot loads zero adapter modules', () => {
    expect(loadedAdapters()).toEqual([]);
  });

  test('every mounted route is exercised and only the ADR-005 Maps read adapter may load', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const guest = await makeEligibleGuest();
    const guestCookie = await cookieFor(guest);

    const perRoute = [];
    const check = async (label, fn) => {
      const before = loadedAdapters();
      const res = await fn();
      const after = loadedAdapters();
      const newly = after.filter((a) => !before.includes(a));
      perRoute.push({ label, status: res && res.status, newly });
      return res;
    };

    // --- auth / users (waves 0-2) ---
    await check('POST /api/auth/register', () =>
      request(app)
        .post('/api/auth/register')
        .send({
          email: `verifier.${crypto.randomUUID()}@adrlane.invalid`,
          password: 'Sufficiently-Long-Passphrase-9',
          fullName: 'Verifier Registrant',
        })
    );
    await check('GET /api/users/me', () =>
      request(app).get('/api/users/me').set('Cookie', hostCookie)
    );

    // --- listings (wave 3A) ---
    const created = await check('POST /api/listings', () =>
      request(app).post('/api/listings').set('Cookie', hostCookie).send(listingBody())
    );
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;

    await check('PATCH /api/listings/:id', () =>
      request(app)
        .patch(`/api/listings/${listingId}`)
        .set('Cookie', hostCookie)
        .send({ description: 'Edited by the verifier lane.' })
    );
    await approve(listingId);
    await check('GET /api/listings/:id', () =>
      request(app).get(`/api/listings/${listingId}`).set('Cookie', guestCookie)
    );

    // --- search (wave 3B), non-location ---
    await check('GET /api/listings/search (no location)', () =>
      request(app).get('/api/listings/search').query({ hostId: host.id }).set('Cookie', guestCookie)
    );

    // --- hosts (wave 3B) ---
    await check('GET /api/hosts/:id', () =>
      request(app).get(`/api/hosts/${host.id}`).set('Cookie', guestCookie)
    );
    await check('GET /api/hosts/:id/reviews', () =>
      request(app).get(`/api/hosts/${host.id}/reviews`).set('Cookie', guestCookie)
    );

    // --- bookings (wave 3A) ---
    const booked = await check('POST /api/bookings', () =>
      request(app).post('/api/bookings').set('Cookie', guestCookie).send({ listingId })
    );
    expect(booked.status).toBe(201);
    const bookingId = booked.body.booking.id;
    await check('GET /api/bookings', () =>
      request(app).get('/api/bookings').set('Cookie', guestCookie)
    );
    await check('GET /api/bookings/:id', () =>
      request(app).get(`/api/bookings/${bookingId}`).set('Cookie', guestCookie)
    );
    await check('POST /api/bookings/:id/cancel', () =>
      request(app).post(`/api/bookings/${bookingId}/cancel`).set('Cookie', guestCookie).send({})
    );

    // --- media (wave 3B) — the three routes, INCLUDING the attach path ---
    const target = await check('POST /api/media/uploads', () =>
      request(app)
        .post('/api/media/uploads')
        .set('Cookie', hostCookie)
        .send({ kind: 'listing', contentType: 'image/jpeg', sizeBytes: 2048 })
    );
    expect(target.status).toBe(200);

    const attached = await check('POST /api/media (attach)', () =>
      request(app).post('/api/media').set('Cookie', hostCookie).send({
        storageKey: target.body.storageKey,
        kind: 'listing',
        entityId: listingId,
        contentType: 'image/jpeg',
        sizeBytes: 2048,
      })
    );
    expect(attached.status).toBe(201);

    await check('DELETE /api/media/:id', () =>
      request(app).delete(`/api/media/${attached.body.media.id}`).set('Cookie', hostCookie)
    );

    // THE INVARIANT (ADR-001): a request handler may never reach an external adapter.
    const offenders = perRoute.filter((r) => r.newly.length > 0);
    expect({
      offenders,
      all: perRoute.map((r) => `${r.label} -> ${r.newly.join(',') || 'none'}`),
    }).toMatchObject({ offenders: [] });
  });

  test('a LOCATION search loads maps.js ONLY (documented ADR-005 read-path exception)', async () => {
    const guest = await makeEligibleGuest();
    const before = loadedAdapters();
    const res = await request(app)
      .get('/api/listings/search')
      .query({ location: 'San Diego, CA', radiusKm: 10 })
      .set('Cookie', await cookieFor(guest));
    expect(res.status).toBe(200);
    // Delta only: an earlier test in this file may already have loaded an adapter (see the
    // POST /api/media finding above); this assertion is about what THIS request pulls in.
    const newly = loadedAdapters().filter((a) => !before.includes(a));
    expect(newly.filter((a) => a !== 'maps.js')).toEqual([]);
  });

  test('static: no module-scope adapter require outside src/outbox and src/modules/notifications', () => {
    const allowed = [
      path.join('outbox', 'handlers'),
      path.join('modules', 'notifications', 'transport.js'),
    ];
    const offenders = [];
    for (const file of listJsFiles(SRC)) {
      const rel = path.relative(SRC, file);
      if (rel.startsWith('adapters')) continue;
      const text = fs.readFileSync(file, 'utf8');
      let depth = 0;
      for (const rawLine of text.split('\n')) {
        const line = rawLine.replace(/\/\/.*$/, '');
        if (depth === 0 && /require\(['"][^'"]*adapters\//.test(line)) {
          if (!allowed.some((a) => rel.includes(a))) offenders.push(`${rel}: ${line.trim()}`);
        }
        for (const ch of line) {
          if (ch === '{' || ch === '(') depth += 1;
          else if (ch === '}' || ch === ')') depth = Math.max(0, depth - 1);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ============================================================================================
// (b) ADR-001/003 — business row and outbox row commit in ONE transaction (no dual write)
// ============================================================================================
describe('(b) ADR-001/003 — one transaction, proven at the row level', () => {
  test('listing row and BOTH its outbox rows carry the SAME xmin (one inserting transaction)', async () => {
    const host = await makeEligibleHost();
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    expect(res.status).toBe(201);
    const listingId = res.body.listing.id;

    const { rows: listingRows } = await dbh.query(
      `SELECT xmin::text AS xid FROM listings WHERE id = $1`,
      [listingId]
    );
    const { rows: jobRows } = await dbh.query(
      `SELECT type, xmin::text AS xid FROM outbox_jobs
        WHERE payload->>'listingId' = $1 OR payload->>'contentId' = $1
        ORDER BY type`,
      [listingId]
    );
    expect(jobRows.map((r) => r.type)).toEqual(['listing.geocode', 'moderation.scan']);
    const distinct = new Set([listingRows[0].xid, ...jobRows.map((r) => r.xid)]);
    expect([...distinct]).toHaveLength(1);
  });

  test('booking row, both notify.booking rows and booking.promote share ONE xmin', async () => {
    const host = await makeEligibleHost();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    const listingId = created.body.listing.id;
    await approve(listingId);

    const guest = await makeEligibleGuest();
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId });
    expect(booked.status).toBe(201);
    const bookingId = booked.body.booking.id;

    const { rows: bRows } = await dbh.query(
      `SELECT xmin::text AS xid FROM bookings WHERE id = $1`,
      [bookingId]
    );
    const { rows: jRows } = await dbh.query(
      `SELECT type, xmin::text AS xid FROM outbox_jobs WHERE payload->>'bookingId' = $1`,
      [bookingId]
    );
    expect(jRows).toHaveLength(3); // 2 × notify.booking + 1 × booking.promote
    const distinct = new Set([bRows[0].xid, ...jRows.map((r) => r.xid)]);
    expect([...distinct]).toHaveLength(1);
  });

  test('outbox.enqueue REFUSES the pool (a dual write cannot even be expressed)', async () => {
    const outbox = require('../../src/outbox/outbox');
    const pool = require('../../src/db/pool');
    await expect(
      outbox.enqueue(pool, { type: 'verifier.probe', payload: { id: crypto.randomUUID() } })
    ).rejects.toThrow(/TRANSACTION client|checked-out pg client/);
    await expect(
      outbox.enqueue(pool.pool, { type: 'verifier.probe', payload: { id: crypto.randomUUID() } })
    ).rejects.toThrow(/TRANSACTION client|checked-out pg client/);
  });

  test('injected enqueue failure rolls the BOOKING row and the seat back (no dual write)', async () => {
    const host = await makeEligibleHost();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    const listingId = created.body.listing.id;
    await approve(listingId);

    const before = await dbh.query(`SELECT seats_remaining FROM listings WHERE id = $1`, [
      listingId,
    ]);
    const outbox = require('../../src/outbox/outbox');
    const spy = jest.spyOn(outbox, 'enqueue').mockRejectedValue(new Error('verifier: outbox down'));
    try {
      const guest = await makeEligibleGuest();
      const res = await request(app)
        .post('/api/bookings')
        .set('Cookie', await cookieFor(guest))
        .send({ listingId });
      expect(res.status).toBeGreaterThanOrEqual(500);
      const bookings = await dbh.query(
        `SELECT count(*)::int AS n FROM bookings WHERE listing_id=$1`,
        [listingId]
      );
      expect(bookings.rows[0].n).toBe(0);
      const after = await dbh.query(`SELECT seats_remaining FROM listings WHERE id = $1`, [
        listingId,
      ]);
      expect(after.rows[0].seats_remaining).toBe(before.rows[0].seats_remaining);
    } finally {
      spy.mockRestore();
    }
  });
});

// ============================================================================================
// (c) ADR-003 — outbox payloads carry IDs only
// ============================================================================================
describe('(c) ADR-003 — persisted outbox payloads are IDs only', () => {
  test('every payload key/value in the whole outbox table is an id, enum or digest', async () => {
    const { rows } = await dbh.query('SELECT id, type, payload, dedupe_key FROM outbox_jobs');
    expect(rows.length).toBeGreaterThan(0);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const SHA256 = /^[0-9a-f]{64}$/i;
    const ENUMISH = /^[a-z][a-z0-9_.]{0,60}$/;
    const offenders = [];
    for (const row of rows) {
      const text = JSON.stringify(row.payload);
      if (EMAIL_SHAPE.test(text)) offenders.push(`${row.type}#${row.id}: email-shaped value`);
      if (text.includes(STREET_SECRET)) offenders.push(`${row.type}#${row.id}: street address`);
      for (const [k, v] of Object.entries(row.payload || {})) {
        if (typeof v !== 'string') {
          offenders.push(`${row.type}#${row.id}: ${k} is not a string id (${typeof v})`);
          continue;
        }
        if (!UUID.test(v) && !SHA256.test(v) && !ENUMISH.test(v)) {
          offenders.push(`${row.type}#${row.id}: ${k}="${v}" is neither id, digest nor enum`);
        }
      }
      if (row.dedupe_key && EMAIL_SHAPE.test(row.dedupe_key)) {
        offenders.push(`${row.type}#${row.id}: dedupe_key is email-shaped`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test('enqueue rejects PII-shaped keys AND values (defence in depth)', async () => {
    const outbox = require('../../src/outbox/outbox');
    expect(() => outbox.assertIdOnlyPayload({ email: 'a@b.co' })).toThrow(/IDs only/);
    expect(() => outbox.assertIdOnlyPayload({ note: 'reach me at a@b.co' })).toThrow(/IDs only/);
    expect(() => outbox.assertIdOnlyPayload({ contact: '+1 415 555 0134' })).toThrow(/IDs only/);
    expect(() => outbox.assertIdOnlyPayload({ fullName: 'Ada Lovelace' })).toThrow(/IDs only/);
    // A legitimate IDs-only payload still passes.
    expect(
      outbox.assertIdOnlyPayload({ bookingId: crypto.randomUUID(), event: 'created' })
    ).toEqual(expect.objectContaining({ event: 'created' }));
  });
});

// ============================================================================================
// (d) ADR-002 — moderation direction: public content cannot publish unreviewed
// ============================================================================================
describe('(d) ADR-002 — pending-until-approved holds; the two-stage pipeline is wave 4', () => {
  test('no moderation module exists yet: the pre-filter/LLM pipeline is NOT implemented', () => {
    expect(fs.existsSync(path.join(SRC, 'modules', 'moderation'))).toBe(false);
    const handlerTypes = fs
      .readdirSync(path.join(SRC, 'outbox', 'handlers'))
      .filter((f) => f.endsWith('.js'))
      .map((f) => require(path.join(SRC, 'outbox', 'handlers', f)).type)
      .sort();
    expect(handlerTypes).not.toContain('moderation.scan');
  });

  test('a new listing is born pending, invisible to strangers, absent from search, unbookable', async () => {
    const host = await makeEligibleHost();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody({ cuisine: 'verifierpending' }));
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;
    expect(created.body.listing.moderationStatus).toBe('pending');

    const guest = await makeEligibleGuest();
    const guestCookie = await cookieFor(guest);
    const detail = await request(app).get(`/api/listings/${listingId}`).set('Cookie', guestCookie);
    expect(detail.status).toBe(404);

    const search = await request(app)
      .get('/api/listings/search')
      .query({ cuisine: 'verifierpending' })
      .set('Cookie', guestCookie);
    expect(search.body.results.map((r) => r.id)).not.toContain(listingId);

    const booking = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .send({ listingId });
    expect(booking.status).toBe(404);

    const hostPage = await request(app).get(`/api/hosts/${host.id}`).set('Cookie', guestCookie);
    expect(hostPage.body.host.exampleDishes.map((d) => d.id)).not.toContain(listingId);
  });

  test('a moderation-provider outage (no handler at all) leaves the listing PENDING, never published', async () => {
    const host = await makeEligibleHost();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    const listingId = created.body.listing.id;

    // Drain with the REAL handler registry: moderation.scan has no handler, so it retries
    // and dead-letters. Content must stay pending throughout (FR-08 failure direction).
    const worker = require('../../src/outbox/worker');
    const dispatch = require('../../src/outbox/dispatch');
    const registry = dispatch.loadHandlers();
    const quiet = {
      info: () => {},
      warn: () => {},
      error: () => {},
      child: () => quiet,
    };
    for (let i = 0; i < config.outbox.maxAttempts + 2; i += 1) {
      await dbh.query(
        `UPDATE outbox_jobs SET available_at = now() - interval '1 hour'
          WHERE type = 'moderation.scan' AND payload->>'contentId' = $1 AND status = 'pending'`,
        [listingId]
      );
      await worker.pollOnce({ registry, log: quiet, batchSize: 50 });
    }
    const { rows } = await dbh.query(
      `SELECT status, last_error FROM outbox_jobs
        WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
      [listingId]
    );
    expect(rows[0].status).toBe('dead');
    expect(rows[0].last_error).toMatch(/no outbox handler registered/);

    const listing = await dbh.query(`SELECT moderation_status FROM listings WHERE id = $1`, [
      listingId,
    ]);
    expect(listing.rows[0].moderation_status).toBe('pending');
  });
});

// ============================================================================================
// (f) ADR-006 — exactly one eligibility policy interface
// ============================================================================================
describe('(f) ADR-006 — a single eligibility policy interface', () => {
  test('canReserveSeat / canPublishListing are DEFINED only in eligibility/policy.js', () => {
    const definition = /(function|const|let)\s+(canReserveSeat|canPublishListing)\s*[=(]/;
    const offenders = [];
    for (const file of listJsFiles(SRC)) {
      if (file.endsWith(path.join('eligibility', 'policy.js'))) continue;
      if (definition.test(fs.readFileSync(file, 'utf8'))) offenders.push(path.relative(SRC, file));
    }
    expect(offenders).toEqual([]);
  });

  test('every restricted route consults requireEligibility from the ONE middleware module', () => {
    const gated = [];
    for (const file of listJsFiles(path.join(SRC, 'modules'))) {
      if (!file.endsWith('routes.js')) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (text.includes('requireEligibility')) {
        expect(text).toMatch(/require\(['"][^'"]*eligibility\/middleware['"]\)/);
        gated.push(path.relative(SRC, file));
      }
    }
    expect(gated.sort()).toEqual([
      path.join('modules', 'bookings', 'routes.js'),
      path.join('modules', 'listings', 'routes.js'),
    ]);
  });

  test('an ineligible actor is 403 with reason codes and writes NO business row', async () => {
    const host = await dbh.makeUser({ can_publish_listing: false, email_verified: false });
    const before = await dbh.countRows('listings');
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('NOT_ELIGIBLE');
    expect(res.body.error.details.reasons).toEqual(expect.arrayContaining(['EMAIL_UNVERIFIED']));
    expect(await dbh.countRows('listings')).toBe(before);
  });
});

// ============================================================================================
// (i) ADR-009 — MEHKO caps from config, ONE enforcement point, America/Los_Angeles boundaries
// ============================================================================================
describe('(i) ADR-009 — caps are configuration and boundaries are LA-local', () => {
  test('the numbers live in src/config only and equal the ADR-009 California table', () => {
    const locale = require('../../src/config/locale');
    expect(locale.timezone).toBe('America/Los_Angeles');
    expect(locale.mehko).toEqual({
      maxListingsPerHostPerDay: 1,
      maxMealsPerHostPerDay: 30,
      maxMealsPerHostPerWeek: 60,
    });
    expect(config.mehko).toMatchObject({
      listingsPerHostPerDay: 1,
      maxMealsPerDay: 30,
      maxMealsPerWeek: 60,
      timezone: 'America/Los_Angeles',
    });
  });

  test('exactly ONE server-side enforcement point exists and every mutation path calls it', () => {
    const enforcement = [];
    for (const file of listJsFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      if (/function\s+assertWithinCaps/.test(text)) enforcement.push(path.relative(SRC, file));
    }
    expect(enforcement).toEqual([path.join('modules', 'listings', 'mehko.js')]);

    const service = fs.readFileSync(path.join(SRC, 'modules', 'listings', 'service.js'), 'utf8');
    // create + update both consult it; cancel needs no cap check (it frees capacity).
    expect(service.match(/mehko\.assertWithinCaps\(/g)).toHaveLength(2);
  });

  test('no cap-valued literal (1/30/60 as a policy number) appears in the enforcement module', () => {
    const text = fs.readFileSync(path.join(SRC, 'modules', 'listings', 'mehko.js'), 'utf8');
    const code = text
      .split('\n')
      .filter((l) => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    expect(code).not.toMatch(/\b30\b/);
    expect(code).not.toMatch(/\b60\b/);
  });

  test('LA-DAY BOUNDARY: a second listing just after LA midnight, submitted by a Tokyo client, is REFUSED', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    // 2031-06-10 23:30 PDT  == 2031-06-11 15:30 +09:00 (Tokyo wall clock, same LA day)
    // 2031-06-11 00:30 PDT  == 2031-06-11 16:30 +09:00 (Tokyo wall clock, NEXT LA day)
    // Both instants share the SAME UTC day (2031-06-11), so a UTC- or caller-timezone-based
    // implementation would either allow both or refuse both — LA-local is the only reading
    // that refuses the first pair and allows the second.
    const tokyoLateNight = '2031-06-11T15:30:00+09:00'; // LA 2031-06-10 23:30
    const tokyoJustAfterMidnight = '2031-06-11T16:30:00+09:00'; // LA 2031-06-11 00:30

    const mehko = require('../../src/modules/listings/mehko');
    expect(mehko.localDateFor(tokyoLateNight)).toBe('2031-06-10');
    expect(mehko.localDateFor(tokyoJustAfterMidnight)).toBe('2031-06-11');
    expect(new Date(tokyoLateNight).toISOString().slice(0, 10)).toBe(
      new Date(tokyoJustAfterMidnight).toISOString().slice(0, 10)
    );

    const first = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody({ scheduledStart: tokyoLateNight }));
    expect(first.status).toBe(201);
    expect(first.body.listing.localDate).toBe('2031-06-10');

    // Same LA day again (23:45 PDT) → refused.
    const sameLaDay = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody({ scheduledStart: '2031-06-11T15:45:00+09:00' }));
    expect(sameLaDay.status).toBe(409);
    expect(sameLaDay.body.error.code).toBe('MEHKO_DAILY_LISTING_LIMIT');

    // 00:30 PDT the NEXT LA day (same UTC day) → allowed.
    const nextLaDay = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody({ scheduledStart: tokyoJustAfterMidnight }));
    expect(nextLaDay.status).toBe(201);
    expect(nextLaDay.body.listing.localDate).toBe('2031-06-11');
  });

  test('localDate is a plain YYYY-MM-DD date on EVERY read path (no timezone-bearing timestamp)', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(listingBody({ cuisine: 'verifierdate' }));
    const listingId = created.body.listing.id;
    await approve(listingId);

    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    expect(created.body.listing.localDate).toMatch(DATE_ONLY);

    const detail = await request(app).get(`/api/listings/${listingId}`).set('Cookie', cookie);
    expect(detail.body.listing.localDate).toMatch(DATE_ONLY);

    const search = await request(app)
      .get('/api/listings/search')
      .query({ cuisine: 'verifierdate' })
      .set('Cookie', cookie);
    for (const r of search.body.results) expect(r.localDate).toMatch(DATE_ONLY);

    const hostPage = await request(app).get(`/api/hosts/${host.id}`).set('Cookie', cookie);
    for (const d of hostPage.body.host.exampleDishes) expect(d.localDate).toMatch(DATE_ONLY);

    // And the value equals the stored SQL DATE, not an off-by-one projection of it.
    const { rows } = await dbh.query(`SELECT local_date::text AS d FROM listings WHERE id = $1`, [
      listingId,
    ]);
    expect(detail.body.listing.localDate).toBe(rows[0].d);
  });

  test('daily and weekly meal caps come from config (boundary values, not hardcoded)', async () => {
    const overCap = await makeEligibleHost();
    const overRes = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(overCap))
      .send(listingBody({ seatCapacity: config.mehko.maxMealsPerDay + 1 }));
    expect(overRes.status).toBe(422);
    expect(overRes.body.error.code).toBe('MEHKO_DAILY_MEAL_LIMIT');

    // Weekly: fill the Monday-anchored LA week to the cap, then one more seat must fail.
    const weekly = await makeEligibleHost();
    const cookie = await cookieFor(weekly);
    const perDay = config.mehko.maxMealsPerDay;
    const days = Math.floor(config.mehko.maxMealsPerWeek / perDay);
    // 2031-06-09 is a Monday.
    for (let i = 0; i < days; i += 1) {
      const res = await request(app)
        .post('/api/listings')
        .set('Cookie', cookie)
        .send(
          listingBody({
            scheduledStart: `2031-06-${String(9 + i).padStart(2, '0')}T19:00:00Z`,
            seatCapacity: perDay,
          })
        );
      expect(res.status).toBe(201);
    }
    const overflow = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send(
        listingBody({
          scheduledStart: `2031-06-${String(9 + days).padStart(2, '0')}T19:00:00Z`,
          seatCapacity: 1,
        })
      );
    expect(overflow.status).toBe(422);
    expect(overflow.body.error.code).toBe('MEHKO_WEEKLY_MEAL_LIMIT');
  });
});

// ============================================================================================
// (j) ADR-010 — the PUBLIC serializer is the default on every listing/host read path
// ============================================================================================
describe('(j) ADR-010 — progressive address disclosure across every read surface', () => {
  const PRIVILEGED = ['addressLine1', 'addressLine2', 'postalCode', 'lat', 'lng'];
  let host;
  let hostCookie;
  let listingId;
  let coarse;

  beforeAll(async () => {
    host = await makeEligibleHost();
    hostCookie = await cookieFor(host);
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(listingBody({ cuisine: 'verifiergeo' }));
    listingId = created.body.listing.id;
    await approve(listingId);
    const { coarsen } = require('../../src/lib/geoPrecision');
    coarse = coarsen(PRECISE_LAT, PRECISE_LNG);
    await dbh.query(
      `UPDATE listings SET lat=$2, lng=$3, coarse_lat=$4, coarse_lng=$5, area_label='North Park'
        WHERE id = $1`,
      [listingId, PRECISE_LAT, PRECISE_LNG, coarse.lat, coarse.lng]
    );
  });

  const assertPublicOnly = (payload, label) => {
    const text = JSON.stringify(payload);
    expect({ label, hasStreet: text.includes(STREET_SECRET) }).toEqual({
      label,
      hasStreet: false,
    });
    expect({ label, hasPreciseLat: text.includes(String(PRECISE_LAT)) }).toEqual({
      label,
      hasPreciseLat: false,
    });
    expect({ label, hasPreciseLng: text.includes(String(PRECISE_LNG)) }).toEqual({
      label,
      hasPreciseLng: false,
    });
  };

  test('LISTING DETAIL for a stranger: exactly the public allowlist', async () => {
    const stranger = await makeEligibleGuest();
    const res = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', await cookieFor(stranger));
    expect(res.status).toBe(200);
    for (const k of PRIVILEGED) expect(res.body.listing).not.toHaveProperty(k);
    expect(res.body.listing.coarseLat).toBeCloseTo(coarse.lat, 6);
    assertPublicOnly(res.body, 'listing detail (stranger)');
  });

  test('SEARCH results and the Redis-CACHED page hold public precision only', async () => {
    const stranger = await makeEligibleGuest();
    const cookie = await cookieFor(stranger);
    const first = await request(app)
      .get('/api/listings/search')
      .query({ cuisine: 'verifiergeo' })
      .set('Cookie', cookie);
    expect(first.status).toBe(200);
    const hit = first.body.results.find((r) => r.id === listingId);
    expect(hit).toBeDefined();
    for (const k of PRIVILEGED) expect(hit).not.toHaveProperty(k);
    assertPublicOnly(first.body, 'search results');

    const { redis } = require('../../src/db/redis');
    const keys = await redis.keys('hp:cache:search:page:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) {
      const raw = await redis.get(k);
      expect(k).not.toMatch(/\d{2,}\.\d{4,}/); // no coordinates in key names
      assertPublicOnly(raw ? JSON.parse(raw) : {}, `redis ${k}`);
    }
  });

  test('HOST PAGE and HOST REVIEWS carry no address, coordinate or contact field', async () => {
    const stranger = await makeEligibleGuest();
    const cookie = await cookieFor(stranger);
    const page = await request(app).get(`/api/hosts/${host.id}`).set('Cookie', cookie);
    expect(page.status).toBe(200);
    expect(Object.keys(page.body.host).sort()).toEqual(
      [
        'averageRating',
        'displayName',
        'exampleDishes',
        'id',
        'images',
        'memberSince',
        'reviewCount',
        'reviews',
        'selfIntroduction',
      ].sort()
    );
    for (const dish of page.body.host.exampleDishes) {
      for (const k of PRIVILEGED) expect(dish).not.toHaveProperty(k);
    }
    assertPublicOnly(page.body, 'host page');

    const reviews = await request(app).get(`/api/hosts/${host.id}/reviews`).set('Cookie', cookie);
    assertPublicOnly(reviews.body, 'host reviews');
  });

  test('DISCLOSURE WINDOW: in_progress guest sees exact; completed guest reverts to public', async () => {
    const guest = await makeEligibleGuest();
    const cookie = await cookieFor(guest);
    const booking = await dbh.makeBooking({ listing_id: listingId, guest_id: guest.id });

    await dbh.query(`UPDATE bookings SET status = 'in_progress' WHERE id = $1`, [booking.id]);
    const during = await request(app).get(`/api/listings/${listingId}`).set('Cookie', cookie);
    expect(during.body.listing.addressLine1).toBe(`901 ${STREET_SECRET}`);
    expect(Number(during.body.listing.lat)).toBeCloseTo(PRECISE_LAT, 6);

    await dbh.query(
      `UPDATE bookings SET status='completed', guest_confirmed_completion=true,
              host_confirmed_completion=true, completed_at=now() WHERE id = $1`,
      [booking.id]
    );
    const after = await request(app).get(`/api/listings/${listingId}`).set('Cookie', cookie);
    for (const k of PRIVILEGED) expect(after.body.listing).not.toHaveProperty(k);
    assertPublicOnly(after.body, 'listing detail (completed guest)');

    await dbh.query(`DELETE FROM bookings WHERE id = $1`, [booking.id]);
  });

  test('BOOKING payloads embed only the public listing reference', async () => {
    const guest = await makeEligibleGuest();
    const cookie = await cookieFor(guest);
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', cookie)
      .send({ listingId });
    expect(booked.status).toBe(201);
    assertPublicOnly(booked.body, 'booking create');
    const detail = await request(app)
      .get(`/api/bookings/${booked.body.booking.id}`)
      .set('Cookie', cookie);
    assertPublicOnly(detail.body, 'booking detail');
    const list = await request(app).get('/api/bookings').set('Cookie', cookie);
    assertPublicOnly(list.body, 'booking list');

    // ...but the SAME guest, holding a pending booking, DOES get the exact address on detail.
    const privileged = await request(app).get(`/api/listings/${listingId}`).set('Cookie', cookie);
    expect(privileged.status).toBe(200);
    expect(privileged.body.listing.addressLine1).toBe(`901 ${STREET_SECRET}`);
    expect(Number(privileged.body.listing.lat)).toBeCloseTo(PRECISE_LAT, 6);

    // Cancelling reverts the guest to the public projection (disclosure WINDOW, not a grant).
    await request(app)
      .post(`/api/bookings/${booked.body.booking.id}/cancel`)
      .set('Cookie', cookie)
      .send({});
    const reverted = await request(app).get(`/api/listings/${listingId}`).set('Cookie', cookie);
    for (const k of PRIVILEGED) expect(reverted.body.listing).not.toHaveProperty(k);
  });

  test('MODERATOR sees public WITHOUT an FR-07 alert; WITH one sees precise AND is access-logged', async () => {
    const moderator = await dbh.makeUser({ roles: ['moderator'], phone_enc: 'enc:v1:mod' });
    const cookie = await cookieFor(moderator);

    const before = await request(app).get(`/api/listings/${listingId}`).set('Cookie', cookie);
    for (const k of PRIVILEGED) expect(before.body.listing).not.toHaveProperty(k);

    const guest = await makeEligibleGuest();
    const booking = await dbh.makeBooking({ listing_id: listingId, guest_id: guest.id });
    await dbh.insertRow('safety_alerts', {
      booking_id: booking.id,
      raised_by: guest.id,
    });

    const logsBefore = await dbh.countRows('access_log');
    const after = await request(app).get(`/api/listings/${listingId}`).set('Cookie', cookie);
    expect(after.body.listing.addressLine1).toBe(`901 ${STREET_SECRET}`);
    expect(await dbh.countRows('access_log')).toBe(logsBefore + 1);
    const { rows } = await dbh.query(
      `SELECT actor_user_id, subject_user_id, purpose, resource FROM access_log
        ORDER BY created_at DESC LIMIT 1`
    );
    expect(rows[0]).toMatchObject({
      actor_user_id: moderator.id,
      subject_user_id: host.id,
      purpose: 'fr07_safety_alert',
      resource: `listing:${listingId}`,
    });
  });

  test('WAVE-4 SURFACES (messaging / moderation views) are not mounted — nothing to leak yet', async () => {
    const guest = await makeEligibleGuest();
    const cookie = await cookieFor(guest);
    for (const p of [
      '/api/messaging',
      '/api/moderation',
      '/api/reviews',
      '/api/safety',
      '/api/privacy',
    ]) {
      const res = await request(app).get(p).set('Cookie', cookie);
      expect(res.status).toBe(404);
    }
  });
});

// ============================================================================================
// (g) Redis role — sessions, rate-limit counters and read cache ONLY
// ============================================================================================
describe('(g) Redis holds sessions / rate limits / cache only', () => {
  test('the whole test keyspace is inside hp:{session,ratelimit,cache}: and holds no business state', async () => {
    const { redis } = require('../../src/db/redis');
    const keys = await redis.keys('*');
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.filter((k) => !/^hp:(session|ratelimit|cache):/.test(k))).toEqual([]);
    expect(keys.filter((k) => /booking|outbox|listing:|user:/.test(k))).toEqual([]);
  });

  test('static: no module writes a business row to Redis (only session/cache/ratelimit modules use it)', () => {
    const users = [];
    for (const file of listJsFiles(SRC)) {
      const rel = path.relative(SRC, file);
      const text = fs.readFileSync(file, 'utf8');
      if (/require\(['"][^'"]*db\/redis['"]\)/.test(text)) users.push(rel);
    }
    expect(users.sort()).toEqual(
      [
        path.join('adapters', 'maps.js'),
        path.join('lib', 'cache.js'),
        path.join('modules', 'auth', 'rateLimit.js'),
        path.join('modules', 'auth', 'sessions.js'),
        path.join('modules', 'search', 'service.js'),
      ].sort()
    );
  });
});

// ============================================================================================
// (h) ADR-007 — no hardcoded provider / model id / API key; the suite uses the mock
// ============================================================================================
describe('(h) ADR-007 — provider-agnostic moderation adapter', () => {
  test('NODE_ENV=test must REFUSE a live moderation/maps adapter, as it already refuses a live transport', () => {
    const { validateEnv } = require('../../src/config/schema');
    const base = { ...process.env, NODE_ENV: 'test' };

    // The ADR-011 rule IS hard-enforced by config (baseline for comparison).
    expect(() => validateEnv({ ...base, NOTIFICATIONS_TRANSPORT: 'sendgrid' })).toThrow(
      /NOTIFICATIONS_TRANSPORT must be mock when NODE_ENV=test/
    );

    // ADR-007: "CI and the automated suite use a deterministic MOCK adapter; only the IT-03
    // measurement run may call the live API." The equivalent guard must exist for the LLM…
    expect(() =>
      validateEnv({
        ...base,
        LLM_MODERATION_MODE: 'live',
        LLM_MODERATION_BASE_URL: 'https://example.invalid/v1',
        LLM_MODERATION_API_KEY: 'not-a-real-key',
        MODERATION_MODEL: 'some-model-id',
      })
    ).toThrow(/NODE_ENV=test/);

    // …and for the ADR-005 Maps adapter (free-tier quota + no third-party calls from CI).
    expect(() =>
      validateEnv({ ...base, MAPS_MODE: 'live', MAPS_API_KEY: 'not-a-real-maps-key' })
    ).toThrow(/NODE_ENV=test/);
  });

  test('no provider hostname, model id or key literal anywhere in src/ or scripts/', () => {
    const patterns = [
      /generativelanguage\.googleapis/i,
      /\bgemini-[a-z0-9.-]+/i,
      /\bgpt-[0-9]/i,
      /AIza[0-9A-Za-z_-]{10}/,
      /SG\.[A-Za-z0-9_-]{16}/,
      /sk-[A-Za-z0-9]{20}/,
    ];
    const offenders = [];
    for (const file of [...listJsFiles(SRC), ...listJsFiles(path.join(ROOT, 'scripts'))]) {
      const text = fs.readFileSync(file, 'utf8');
      for (const p of patterns)
        if (p.test(text)) offenders.push(`${path.relative(ROOT, file)}: ${p}`);
    }
    expect(offenders).toEqual([]);
  });

  test('base URL, key and model id are all environment-driven and documented in .env.example', () => {
    const schema = fs.readFileSync(path.join(SRC, 'config', 'schema.js'), 'utf8');
    for (const v of ['LLM_MODERATION_BASE_URL', 'LLM_MODERATION_API_KEY', 'MODERATION_MODEL']) {
      expect(schema).toContain(v);
      expect(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')).toContain(v);
    }
    expect(config.moderation.mode).toBe('mock');
  });

  test('under NODE_ENV=test the adapter resolves to the deterministic MOCK (no network)', async () => {
    const llm = require('../../src/adapters/llmModeration');
    expect(llm.mode).toBe('mock');
    const a = await llm.classify('buy cheap watches now click here');
    const b = await llm.classify('buy cheap watches now click here');
    expect(a).toEqual(b);
    expect(a).toEqual(
      expect.objectContaining({ category: expect.any(String), confidence: expect.any(Number) })
    );
  });
});

// ============================================================================================
// (e) ADR-004 — media by key, per-object deletion; account-deletion wiring
// ============================================================================================
describe('(e) ADR-004 — media referenced by key with per-object deletion', () => {
  test('media_objects stores a storage KEY (never bytes) and the URL is derived locally', async () => {
    const { rows } = await dbh.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_name = 'media_objects' ORDER BY column_name`
    );
    const names = rows.map((r) => r.column_name);
    expect(names).toContain('storage_key');
    // No bytes column: size_bytes is metadata, not payload — the object itself lives in
    // object storage and PostgreSQL holds only its key (ADR-004).
    expect(names.filter((n) => /blob|bytea|payload|^data$|file_content/.test(n))).toEqual([]);
    expect(rows.find((r) => r.column_name === 'storage_key').data_type).toBe('text');
  });

  test('deleteForUser deletes ONE object per owned key and the objects then 404', async () => {
    const storage = require('../../src/adapters/objectStorage');
    const mediaService = require('../../src/modules/media/service');
    const owner = await dbh.makeUser();
    const keys = [];
    for (let i = 0; i < 3; i += 1) {
      const key = `listing/${owner.id.toLowerCase()}/${crypto.randomUUID()}.jpg`;
      await storage.put(key, Buffer.from(`verifier-object-${i}`), { contentType: 'image/jpeg' });
      await mediaService.attach(owner.id, key, 'listing');
      keys.push(key);
    }
    const spy = jest.spyOn(storage, 'deleteByKey');
    const result = await mediaService.deleteForUser(owner.id);
    expect(result).toEqual({ deletedObjects: 3, deletedRows: 3, total: 3 });
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual([...keys].sort());
    spy.mockRestore();
    for (const key of keys) {
      await expect(storage.get(key)).rejects.toMatchObject({ status: 404 });
    }
    const { rows } = await dbh.query(
      `SELECT count(*)::int AS n FROM media_objects WHERE owner_user_id=$1`,
      [owner.id]
    );
    expect(rows[0].n).toBe(0);
  });

  test('WIRING GAP: nothing in src/ calls deleteForUser — the NFR-12 erasure job is wave 4', () => {
    const callers = [];
    for (const file of listJsFiles(SRC)) {
      const rel = path.relative(SRC, file);
      if (rel === path.join('modules', 'media', 'service.js')) continue;
      const code = fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter((l) => !l.trim().startsWith('//'))
        .join('\n');
      if (/deleteForUser\s*\(/.test(code)) callers.push(rel);
    }
    // Documented wave-4 scope: the primitive exists, the account-deletion caller does not.
    expect(callers).toEqual([]);
    expect(fs.existsSync(path.join(SRC, 'modules', 'privacy'))).toBe(false);
  });
});

// ============================================================================================
// (j2) ADR-005/010 — the Maps Redis cache can never hold an exact location
// ============================================================================================
describe('(j2) ADR-005/010 — geocode cache stores public precision only', () => {
  test('an EXACT-precision geocode returns precise coordinates to the worker but writes nothing precise to Redis', async () => {
    const maps = require('../../src/adapters/maps');
    const { redis } = require('../../src/db/redis');
    const address = `77 ${STREET_SECRET}, San Diego, CA 92104`;

    const exact = await maps.geocode(address, { precision: 'exact' });
    expect(exact.precise).toEqual(
      expect.objectContaining({ lat: expect.any(Number), lng: expect.any(Number) })
    );
    // The public projection is coarser than the precise pair (ADR-010 coarsening).
    expect(exact.lat).not.toBe(exact.precise.lat);

    const keys = await redis.keys('*');
    const preciseLat = String(exact.precise.lat);
    const preciseLng = String(exact.precise.lng);
    const leaks = [];
    for (const k of keys) {
      if (k.includes(STREET_SECRET)) leaks.push(`key ${k} carries the street`);
      const type = await redis.type(k);
      if (type !== 'string') continue;
      const value = await redis.get(k);
      if (!value) continue;
      if (value.includes(preciseLat) || value.includes(preciseLng)) {
        leaks.push(`value at ${k} carries precise coordinates`);
      }
      if (value.includes(STREET_SECRET)) leaks.push(`value at ${k} carries the street`);
    }
    expect(leaks).toEqual([]);
  });

  test('a repeat NON-exact geocode is served from the cache and is coarse', async () => {
    const maps = require('../../src/adapters/maps');
    const address = 'Balboa Park, San Diego, CA';
    const first = await maps.geocode(address);
    const second = await maps.geocode(address);
    expect(second).toMatchObject({ lat: first.lat, lng: first.lng });
    expect(second.precise).toBeUndefined();
  });
});

// ============================================================================================
// (k) ADR-011 — email is the v1.0 channel; push gated default-false; every attempt persisted
// ============================================================================================
describe('(k) ADR-011 — notification channel policy', () => {
  test('notifications.push.enabled is FALSE with no env override (default-off gate)', () => {
    const { validateEnv } = require('../../src/config/schema');
    const env = { ...process.env };
    delete env.NOTIFICATIONS_PUSH_ENABLED;
    delete env.NOTIFICATIONS_TRANSPORT;
    const fresh = validateEnv(env);
    expect(fresh.notifications.push.enabled).toBe(false);
    expect(config.notifications.push.enabled).toBe(false);
  });

  test('the suite runs the MOCK transport — no live provider is reachable from a test', () => {
    const transport = require('../../src/modules/notifications/transport');
    expect(config.notifications.transport).toBe('mock');
    expect(transport.resolveAdapter('email').name).toMatch(/mock/i);
    expect(transport.resolveAdapter('push')).toBeNull(); // gate off → refused before any adapter
  });

  test('booking create → worker drain → one persisted NOTIFICATION_ATTEMPT per participant', async () => {
    const host = await makeEligibleHost();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    const listingId = created.body.listing.id;
    await approve(listingId);
    const guest = await makeEligibleGuest();
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId });
    const bookingId = booked.body.booking.id;

    // Nothing sent yet — delivery is worker work, not request work (ADR-001).
    const preDrain = await dbh.query(
      `SELECT count(*)::int AS n FROM notification_attempts WHERE params->>'bookingId' = $1`,
      [bookingId]
    );
    expect(preDrain.rows[0].n).toBe(0);

    const worker = require('../../src/outbox/worker');
    const dispatch = require('../../src/outbox/dispatch');
    const registry = dispatch.loadHandlers();
    const quiet = { info: () => {}, warn: () => {}, error: () => {}, child: () => quiet };
    for (let i = 0; i < 5; i += 1) await worker.pollOnce({ registry, log: quiet, batchSize: 50 });

    const { rows } = await dbh.query(
      `SELECT recipient_user_id, channel, status FROM notification_attempts
        WHERE params->>'bookingId' = $1 ORDER BY recipient_user_id`,
      [bookingId]
    );
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.channel).toBe('email');
      expect(r.status).toBe('sent');
    }
    expect(rows.map((r) => r.recipient_user_id).sort()).toEqual([guest.id, host.id].sort());
  });

  test('a push send is REFUSED under the default-false gate and recorded as a failed row', async () => {
    const transport = require('../../src/modules/notifications/transport');
    const user = await dbh.makeUser();
    const result = await transport.send({
      userId: user.id,
      channel: 'push',
      template: 'verifier.push.probe',
      params: { userId: user.id },
      idempotencyKey: `verifier-push-${crypto.randomUUID()}`,
    });
    expect(result).toMatchObject({ status: 'failed', reason: 'push_disabled' });
    const { rows } = await dbh.query(
      `SELECT status, last_error FROM notification_attempts WHERE id = $1`,
      [result.attemptId]
    );
    expect(rows[0].status).toBe('failed');
    expect(rows[0].last_error).toMatch(/push channel refused/);
  });

  test('notification_attempts rows carry IDs only — no email address, no address text', async () => {
    const { rows } = await dbh.query('SELECT id, params, last_error FROM notification_attempts');
    const offenders = rows.filter((r) => {
      const text = `${JSON.stringify(r.params)} ${r.last_error || ''}`;
      return EMAIL_SHAPE.test(text) || text.includes(STREET_SECRET);
    });
    expect(offenders).toEqual([]);
  });
});

// ============================================================================================
// IT3-F1 residual — booking.promote must never lose a promotion to its own dedupe key
// ============================================================================================
describe('IT3-F1 — early booking.promote delivery keeps a live promote row', () => {
  test('delivering the promote job while scheduled_start is still in the future leaves a LIVE pending promote row', async () => {
    const host = await makeEligibleHost();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send(listingBody());
    const listingId = created.body.listing.id;
    await approve(listingId);
    const guest = await makeEligibleGuest();
    const booked = await request(app)
      .post('/api/bookings')
      .set('Cookie', await cookieFor(guest))
      .send({ listingId });
    const bookingId = booked.body.booking.id;

    const before = await dbh.query(
      `SELECT id, dedupe_key, status FROM outbox_jobs
        WHERE type='booking.promote' AND payload->>'bookingId' = $1`,
      [bookingId]
    );
    expect(before.rows).toHaveLength(1);
    const originalJobId = before.rows[0].id;

    // Simulate the reproducible production trigger: the row becomes due EARLY (DB clock ahead
    // of the Node clock / operator requeue) while scheduled_start is unchanged.
    await dbh.query(
      `UPDATE outbox_jobs SET available_at = now() - interval '1 minute' WHERE id=$1`,
      [originalJobId]
    );

    const worker = require('../../src/outbox/worker');
    const dispatch = require('../../src/outbox/dispatch');
    const registry = dispatch.loadHandlers();
    const quiet = { info: () => {}, warn: () => {}, error: () => {}, child: () => quiet };
    await worker.pollOnce({ registry, log: quiet, batchSize: 50 });

    const after = await dbh.query(
      `SELECT id, status, dedupe_key FROM outbox_jobs
        WHERE type='booking.promote' AND payload->>'bookingId' = $1 ORDER BY created_at`,
      [bookingId]
    );
    const live = after.rows.filter((r) => r.status === 'pending');
    // THE INVARIANT: after an early delivery the booking must still have a scheduled promotion.
    expect({
      rows: after.rows.map((r) => `${r.status}:${r.dedupe_key}`),
      livePendingCount: live.length,
    }).toMatchObject({ livePendingCount: 1 });

    // ...and the booking is still promotable (not stranded 'pending' forever).
    const booking = await dbh.query(`SELECT status FROM bookings WHERE id=$1`, [bookingId]);
    expect(booking.rows[0].status).toBe('pending');
  });
});
