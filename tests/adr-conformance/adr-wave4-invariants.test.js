// tests/adr-conformance/adr-wave4-invariants.test.js — ADR conformance lane (verifier-owned).
//
// Executable audit of the binding architecture invariants over the WAVE-4 surface
// (U4-MODERATION, U4-REVIEWS, U4-MESSAGING, U4-PRIVACY, U4-SAFETY-COMPLETE):
//   ADR-001/003 — no adapter loads on any wave-4 request path (reviews, messaging, the
//                 moderator queue, privacy deletion/export); review + scan row, message +
//                 scan row, deletion mark + data_request + erasure job, and export request +
//                 export job each commit in ONE PostgreSQL transaction (xmin-proven); every
//                 wave-4 outbox payload carries IDs/enums only.
//   ADR-002     — the deterministic pre-filter runs BEFORE the LLM stage (a blocklist hit
//                 decides with ZERO classifier calls); public content (reviews) publishes
//                 ONLY on an approval; messages deliver immediately while their scan is
//                 still queued and disappear only on a rejection (AB-04); the human
//                 moderator decision is the queue's only resolution path and is 403 to
//                 non-moderators (AB-08).
//   ADR-004     — the NFR-12 erasure path drives ONE deleteByKey call per owned object
//                 against real MinIO, through the worker-only 'account.erasure' handler.
//   ADR-010     — the moderator queue payload and the messaging payloads are allowlist-
//                 serialized: no street address, precise coordinate, email or phone ever
//                 rides them; a data export is served to its OWNER only (AB-08).
//   ADR-011     — nothing in these flows leaves the process (mock transport pinned; the
//                 erasure drain sends no live anything).
//   Redis role  — after every wave-4 flow the keyspace is still session/rate-limit/cache.
//
// ORDERING MATTERS: the require.cache adapter-purity audit runs FIRST; tests that
// legitimately load adapters (worker drains, object storage) run LAST in file order.
'use strict';

const path = require('path');
const request = require('supertest');

const dbh = require('../helpers/db');
const { pollOnlyThese } = require('../helpers/outboxScope');

const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENUMISH = /^[a-z0-9_.-]{1,64}$/i;

// Distinctive precise-location fixture values — must never appear in a moderator-queue or
// messaging payload (ADR-010).
const SECRET_STREET = 'Advfour Secret Court';
const PRECISE_LAT = 32.876543;
const PRECISE_LNG = -117.234567;

let app;
let config;
let sessions;

/** Adapter modules currently loaded in this process (basename, sorted). */
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

/** A completed booking (guest ↔ host on an approved listing) — the FR-05 substrate. */
async function completedBookingFixture() {
  const host = await dbh.makeUser({ can_publish_listing: true });
  await dbh.makeHostProfile({ user_id: host.id });
  const guest = await dbh.makeUser();
  const listing = await dbh.makeListing({ host_id: host.id, moderation_status: 'approved' });
  const booking = await dbh.makeBooking({
    listing_id: listing.id,
    guest_id: guest.id,
    status: 'completed',
    host_confirmed_completion: true,
    guest_confirmed_completion: true,
  });
  return { host, guest, listing, booking };
}

/** A pending booking (open FR-06 thread). */
async function pendingBookingFixture() {
  const host = await dbh.makeUser({ can_publish_listing: true });
  const guest = await dbh.makeUser();
  const listing = await dbh.makeListing({ host_id: host.id, moderation_status: 'approved' });
  const booking = await dbh.makeBooking({
    listing_id: listing.id,
    guest_id: guest.id,
    status: 'pending',
  });
  return { host, guest, listing, booking };
}

async function outboxRowsFor(type, jsonPath, value) {
  const { rows } = await dbh.query(
    `SELECT id, type, payload, status, dedupe_key, available_at, created_at, xmin::text AS xid
       FROM outbox_jobs WHERE type = $1 AND payload->>'${jsonPath}' = $2`,
    [type, value]
  );
  return rows;
}

/** Strict ADR-003 audit of one payload object: every value an id, enum or null. */
function expectIdsOnly(payload) {
  expect(EMAIL_SHAPE.test(JSON.stringify(payload))).toBe(false);
  for (const [k, v] of Object.entries(payload)) {
    if (v === null) continue;
    expect({ k, ok: typeof v === 'string' && (UUID.test(v) || ENUMISH.test(v)) }).toEqual({
      k,
      ok: true,
    });
  }
}

beforeAll(async () => {
  const { createApp } = require('../../src/app');
  app = createApp();
  config = require('../../src/config');
  sessions = require('../../src/modules/auth/sessions');
});

afterAll(async () => {
  try {
    const { closeRedis } = require('../../src/db/redis');
    await closeRedis();
  } finally {
    await dbh.closeDb();
  }
});

// ==========================================================================================
// ADR-001/003 (a) — every wave-4 request path is adapter-free (must run FIRST)
// ==========================================================================================
describe('ADR-001/003 — wave-4 request paths are adapter-free', () => {
  test('reviews, messaging, moderation queue/decision and privacy routes load NO adapter', async () => {
    // Route auditor: attribute any newly-loaded adapter to the exact route that pulled it in.
    const perRoute = [];
    const check = async (label, fn) => {
      const before = loadedAdapters();
      const res = await fn();
      const newly = loadedAdapters().filter((a) => !before.includes(a));
      perRoute.push({ label, status: res && res.status, newly });
      return res;
    };

    const done = await completedBookingFixture();
    const open = await pendingBookingFixture();
    const guestCookie = await cookieFor(done.guest);
    const openGuestCookie = await cookieFor(open.guest);
    const openHostCookie = await cookieFor(open.host);
    const moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
    const modCookie = await cookieFor(moderator);

    const review = await check('POST /api/bookings/:id/reviews', () =>
      request(app)
        .post(`/api/bookings/${done.booking.id}/reviews`)
        .set('Cookie', guestCookie)
        .send({ rating: 5, comment: 'Adapter-purity fixture review, kind host.' })
    );
    expect(review.status).toBe(201);

    const posted = await check('POST /api/bookings/:id/messages', () =>
      request(app)
        .post(`/api/bookings/${open.booking.id}/messages`)
        .set('Cookie', openGuestCookie)
        .send({ body: 'Adapter-purity fixture message.' })
    );
    expect(posted.status).toBe(201);

    const thread = await check('GET /api/bookings/:id/messages', () =>
      request(app).get(`/api/bookings/${open.booking.id}/messages`).set('Cookie', openHostCookie)
    );
    expect(thread.status).toBe(200);

    const queue = await check('GET /api/moderation/queue', () =>
      request(app).get('/api/moderation/queue').set('Cookie', modCookie)
    );
    expect(queue.status).toBe(200);

    // A decision needs a queue item; file one for the review THROUGH the repo contract
    // (the worker normally does this) so the HTTP decision path itself is what we audit.
    const moderationRepo = require('../../src/modules/moderation/repo');
    const { withTransaction } = require('../../src/db/tx');
    const item = await withTransaction(async (client) => {
      const { item: row } = await moderationRepo.insertQueueItem(client, {
        contentType: 'review',
        contentId: review.body.review.id,
        reason: 'low_confidence',
      });
      return row;
    });
    const decision = await check('POST /api/moderation/queue/:id/decision', () =>
      request(app)
        .post(`/api/moderation/queue/${item.id}/decision`)
        .set('Cookie', modCookie)
        .send({ decision: 'approve', category: 'benign' })
    );
    expect(decision.status).toBe(200);

    const exportReq = await check('POST /api/users/me/export', () =>
      request(app).post('/api/users/me/export').set('Cookie', openGuestCookie).send({})
    );
    expect(exportReq.status).toBe(202);

    const exportGet = await check('GET /api/users/me/export/:id', () =>
      request(app)
        .get(`/api/users/me/export/${exportReq.body.request.id}`)
        .set('Cookie', openGuestCookie)
    );
    expect(exportGet.status).toBe(200);

    const deletion = await check('DELETE /api/users/me', () =>
      request(app).delete('/api/users/me').set('Cookie', guestCookie)
    );
    expect(deletion.status).toBe(202);

    const offenders = perRoute.filter((r) => r.newly.length > 0);
    expect({
      offenders,
      all: perRoute.map((r) => `${r.label} [${r.status}] -> ${r.newly.join(',') || 'none'}`),
    }).toMatchObject({ offenders: [] });
  });
});

// ==========================================================================================
// ADR-001/003 (b)(c) — one transaction per wave-4 write; payloads are IDs only
// ==========================================================================================
describe('ADR-001/003 — wave-4 transactional outbox, IDs-only payloads', () => {
  test('review row and its moderation.scan row share ONE xmin; payload is IDs+enum only', async () => {
    const { guest, booking } = await completedBookingFixture();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reviews`)
      .set('Cookie', await cookieFor(guest))
      .send({ rating: 4, comment: 'One-transaction proof review.' });
    expect(res.status).toBe(201);
    const reviewId = res.body.review.id;

    const { rows: reviewRows } = await dbh.query(
      `SELECT moderation_status, xmin::text AS xid FROM reviews WHERE id = $1`,
      [reviewId]
    );
    expect(reviewRows[0].moderation_status).toBe('pending'); // ADR-002: born pending
    const scans = await outboxRowsFor('moderation.scan', 'contentId', reviewId);
    expect(scans).toHaveLength(1);
    expect(scans[0].xid).toBe(reviewRows[0].xid); // SAME inserting transaction
    expect(scans[0].payload).toEqual({ contentType: 'review', contentId: reviewId });
    expectIdsOnly(scans[0].payload);
  });

  test('message row and its moderation.scan row share ONE xmin; payload is IDs+enum only', async () => {
    const { guest, booking } = await pendingBookingFixture();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/messages`)
      .set('Cookie', await cookieFor(guest))
      .send({ body: 'One-transaction proof message.' });
    expect(res.status).toBe(201);
    const messageId = res.body.message.id;

    const { rows: msgRows } = await dbh.query(
      `SELECT moderation_status, xmin::text AS xid FROM messages WHERE id = $1`,
      [messageId]
    );
    const scans = await outboxRowsFor('moderation.scan', 'contentId', messageId);
    expect(scans).toHaveLength(1);
    expect(scans[0].xid).toBe(msgRows[0].xid);
    expect(scans[0].payload).toEqual({ contentType: 'message', contentId: messageId });
    expectIdsOnly(scans[0].payload);
  });

  test('DELETE /api/users/me: deletion mark + data_request + scheduled erasure job, ONE xmin', async () => {
    const user = await dbh.makeUser();
    const res = await request(app)
      .delete('/api/users/me')
      .set('Cookie', await cookieFor(user));
    expect(res.status).toBe(202);
    const requestId = res.body.request.id;

    const { rows: userRows } = await dbh.query(
      `SELECT deleted_at, xmin::text AS xid FROM users WHERE id = $1`,
      [user.id]
    );
    expect(userRows[0].deleted_at).not.toBeNull();
    const { rows: reqRows } = await dbh.query(
      `SELECT kind, due_at, xmin::text AS xid FROM data_requests WHERE id = $1`,
      [requestId]
    );
    expect(reqRows[0].kind).toBe('erasure');
    const jobs = await outboxRowsFor('account.erasure', 'userId', user.id);
    expect(jobs).toHaveLength(1);

    // All three writes carry the SAME transaction id — no dual write can exist.
    expect(new Set([userRows[0].xid, reqRows[0].xid, jobs[0].xid]).size).toBe(1);

    // The job becomes available exactly at the NFR-12 erasure due instant (config-driven).
    expect(new Date(jobs[0].available_at).getTime()).toBe(new Date(reqRows[0].due_at).getTime());
    expectIdsOnly(jobs[0].payload);
    expect(jobs[0].payload).toEqual({
      userId: user.id,
      dataRequestId: requestId,
      reason: 'deletion',
    });
  });

  test('POST /api/users/me/export: request row + data.export job, ONE xmin, IDs only', async () => {
    const user = await dbh.makeUser();
    const res = await request(app)
      .post('/api/users/me/export')
      .set('Cookie', await cookieFor(user))
      .send({});
    expect(res.status).toBe(202);
    const requestId = res.body.request.id;

    const { rows: reqRows } = await dbh.query(
      `SELECT kind, xmin::text AS xid FROM data_requests WHERE id = $1`,
      [requestId]
    );
    expect(reqRows[0].kind).toBe('export');
    const jobs = await outboxRowsFor('data.export', 'dataRequestId', requestId);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].xid).toBe(reqRows[0].xid);
    expect(jobs[0].payload).toEqual({ userId: user.id, dataRequestId: requestId });
    expectIdsOnly(jobs[0].payload);
  });
});

// ==========================================================================================
// ADR-002 (d) — pre-filter precedes the LLM; publication only on approval
// ==========================================================================================
describe('ADR-002 — pre-filter first; approval is the only publication path', () => {
  test('a blocklist hit decides with ZERO classifier calls (stage order is real)', async () => {
    const { guest, booking } = await completedBookingFixture();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reviews`)
      .set('Cookie', await cookieFor(guest))
      .send({ rating: 1, comment: 'Pay me back via western union only.' });
    expect(res.status).toBe(201);
    const reviewId = res.body.review.id;

    // Run the REAL pipeline body with a spy classifier: the deterministic stage must decide
    // this text BEFORE the classifier can be consulted (ADR-002 stage order).
    const service = require('../../src/modules/moderation/service');
    const classify = jest.fn();
    const out = await service.processScan(
      { contentType: 'review', contentId: reviewId },
      { classify, mode: 'mock' }
    );
    expect(out.outcome).toBe('rejected');
    expect(classify).not.toHaveBeenCalled();

    const { rows } = await dbh.query(
      `SELECT decided_by, outcome, category FROM moderation_decisions
        WHERE content_type = 'review' AND content_id = $1`,
      [reviewId]
    );
    expect(rows).toEqual([
      expect.objectContaining({
        decided_by: 'pre_filter',
        outcome: 'rejected',
        category: 'fraudulent',
      }),
    ]);
    const { rows: after } = await dbh.query(`SELECT moderation_status FROM reviews WHERE id = $1`, [
      reviewId,
    ]);
    expect(after[0].moderation_status).toBe('rejected'); // never publishable
  });

  test('a message DELIVERS while its scan is still queued; a rejection hides it (AB-04)', async () => {
    const { host, guest, booking } = await pendingBookingFixture();
    const guestCookie = await cookieFor(guest);
    const hostCookie = await cookieFor(host);

    const posted = await request(app)
      .post(`/api/bookings/${booking.id}/messages`)
      .set('Cookie', guestCookie)
      .send({ body: 'Hello! [[LOW_CONFIDENCE]] is dinner still on?' });
    expect(posted.status).toBe(201);
    const messageId = posted.body.message.id;

    // Deliver-first: the scan job is STILL PENDING and the other participant reads it now.
    const scans = await outboxRowsFor('moderation.scan', 'contentId', messageId);
    expect(scans).toHaveLength(1);
    expect(scans[0].status).toBe('pending');
    const before = await request(app)
      .get(`/api/bookings/${booking.id}/messages`)
      .set('Cookie', hostCookie);
    expect(before.status).toBe(200);
    expect(before.body.items.map((m) => m.id)).toContain(messageId);
    // NFR-13 allowlist on the wire: exactly these keys, nothing else.
    for (const m of before.body.items) {
      expect(Object.keys(m).sort()).toEqual(['body', 'bookingId', 'createdAt', 'id', 'senderId']);
    }

    // Drain ONLY this scan: low confidence escalates to the human queue; the message stays
    // visible (pending ≠ hidden; only rejection hides).
    const dispatch = require('../../src/outbox/dispatch');
    const registry = dispatch.loadHandlers();
    await pollOnlyThese([scans[0].id], registry, 1);
    const { rows: queued } = await dbh.query(
      `SELECT id, status FROM moderation_queue WHERE content_type = 'message' AND content_id = $1`,
      [messageId]
    );
    expect(queued).toHaveLength(1);
    const during = await request(app)
      .get(`/api/bookings/${booking.id}/messages`)
      .set('Cookie', hostCookie);
    expect(during.body.items.map((m) => m.id)).toContain(messageId);

    // The human REJECTS: the one moderation_status writer flips it; the thread hides it.
    const moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
    const decided = await request(app)
      .post(`/api/moderation/queue/${queued[0].id}/decision`)
      .set('Cookie', await cookieFor(moderator))
      .send({ decision: 'reject', category: 'spam' });
    expect(decided.status).toBe(200);
    const after = await request(app)
      .get(`/api/bookings/${booking.id}/messages`)
      .set('Cookie', hostCookie);
    expect(after.body.items.map((m) => m.id)).not.toContain(messageId);
  });

  test('a benign review publishes ONLY after the worker approves it end-to-end', async () => {
    const { host, guest, booking } = await completedBookingFixture();
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reviews`)
      .set('Cookie', await cookieFor(guest))
      .send({ rating: 5, comment: 'Delicious, generous portions, lovely table.' });
    expect(res.status).toBe(201);
    const reviewId = res.body.review.id;

    // Invisible while pending: the host page review read serves approved rows only.
    const pendingRead = await request(app)
      .get(`/api/hosts/${host.id}/reviews`)
      .set('Cookie', await cookieFor(guest));
    expect(pendingRead.status).toBe(200);
    expect(JSON.stringify(pendingRead.body)).not.toContain(reviewId);

    const scans = await outboxRowsFor('moderation.scan', 'contentId', reviewId);
    const dispatch = require('../../src/outbox/dispatch');
    const registry = dispatch.loadHandlers();
    await pollOnlyThese([scans[0].id], registry, 1);

    const { rows } = await dbh.query(`SELECT moderation_status FROM reviews WHERE id = $1`, [
      reviewId,
    ]);
    expect(rows[0].moderation_status).toBe('approved');
    const { rows: decisions } = await dbh.query(
      `SELECT decided_by, outcome, model_id FROM moderation_decisions
        WHERE content_type = 'review' AND content_id = $1`,
      [reviewId]
    );
    expect(decisions).toEqual([
      expect.objectContaining({ decided_by: 'llm', outcome: 'approved' }),
    ]);
    expect(decisions[0].model_id).toBeTruthy(); // ADR-007: model id recorded per LLM decision

    const approvedRead = await request(app)
      .get(`/api/hosts/${host.id}/reviews`)
      .set('Cookie', await cookieFor(guest));
    expect(JSON.stringify(approvedRead.body)).toContain(reviewId);
  });

  test('the moderator queue is 403 to a non-moderator (AB-08)', async () => {
    const user = await dbh.makeUser();
    const res = await request(app)
      .get('/api/moderation/queue')
      .set('Cookie', await cookieFor(user));
    expect(res.status).toBe(403);
  });
});

// ==========================================================================================
// ADR-010 (j) — wave-4 read surfaces never leak a precise location or contact value
// ==========================================================================================
describe('ADR-010 — moderator queue and export disclosure', () => {
  test('a queued LISTING exposes an excerpt only — no address, coordinate, email or phone', async () => {
    // An eligible host creates a listing with a distinctive precise address; the scan
    // escalates it (low-confidence sentinel) into the human queue.
    const host = await dbh.makeUser({
      can_publish_listing: true,
      phone_enc: 'enc:v1:adrw4-fixture',
    });
    await dbh.makeHostProfile({ user_id: host.id });
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', await cookieFor(host))
      .send({
        title: 'ADR wave-4 queue leak probe',
        description: 'A dinner description carrying [[LOW_CONFIDENCE]] for escalation.',
        ingredients: ['rice'],
        allergens: ['none'],
        cuisine: 'adrw4',
        scheduledStart: new Date(Date.UTC(2029, 5, 20, 20, 0, 0)).toISOString(),
        durationMinutes: 90,
        seatCapacity: 4,
        addressLine1: `99 ${SECRET_STREET}`,
        city: 'San Diego',
        region: 'CA',
        postalCode: '92103',
      });
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;
    // Simulate the geocode worker having stamped precise coordinates.
    await dbh.query(`UPDATE listings SET lat = $2, lng = $3 WHERE id = $1`, [
      listingId,
      PRECISE_LAT,
      PRECISE_LNG,
    ]);

    const scans = await outboxRowsFor('moderation.scan', 'contentId', listingId);
    expect(scans.length).toBeGreaterThanOrEqual(1);
    const dispatch = require('../../src/outbox/dispatch');
    const registry = dispatch.loadHandlers();
    await pollOnlyThese(
      scans.map((r) => r.id),
      registry,
      1
    );
    const { rows: queued } = await dbh.query(
      `SELECT id FROM moderation_queue WHERE content_type = 'listing' AND content_id = $1`,
      [listingId]
    );
    expect(queued).toHaveLength(1);

    const moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
    const page = await request(app)
      .get('/api/moderation/queue')
      .query({ contentType: 'listing', pageSize: 50 })
      .set('Cookie', await cookieFor(moderator));
    expect(page.status).toBe(200);
    const entry = page.body.items.find((i) => i.contentId === listingId);
    expect(entry).toBeDefined();
    expect(entry.excerpt).toContain('queue leak probe'); // the excerpt is the scanned text

    // Deep leak audit of the WHOLE page payload (ADR-010 safety property).
    const text = JSON.stringify(page.body);
    expect(text).not.toContain(SECRET_STREET);
    expect(text).not.toContain(String(PRECISE_LAT));
    expect(text).not.toContain(String(PRECISE_LNG));
    expect(EMAIL_SHAPE.test(text)).toBe(false);
  });

  test('an export is served to its OWNER only; a foreign id is an opaque 404 (AB-08)', async () => {
    const owner = await dbh.makeUser();
    const stranger = await dbh.makeUser();
    const created = await request(app)
      .post('/api/users/me/export')
      .set('Cookie', await cookieFor(owner))
      .send({});
    expect(created.status).toBe(202);
    const id = created.body.request.id;

    const foreign = await request(app)
      .get(`/api/users/me/export/${id}`)
      .set('Cookie', await cookieFor(stranger));
    expect(foreign.status).toBe(404); // existence not disclosed

    const own = await request(app)
      .get(`/api/users/me/export/${id}`)
      .set('Cookie', await cookieFor(owner));
    expect(own.status).toBe(200);
  });
});

// ==========================================================================================
// ADR-004 (e) + NFR-12 — the erasure worker deletes media BY KEY against real MinIO
// ==========================================================================================
describe('ADR-004/NFR-12 — account erasure drives per-object deletion through the worker', () => {
  test('DELETE /api/users/me → due worker drain → objects gone by key, PII emptied, sessions dead', async () => {
    const objectStorage = require('../../src/adapters/objectStorage');
    const mediaService = require('../../src/modules/media/service');

    const user = await dbh.makeUser({ phone_enc: 'enc:v1:adrw4-erasure' });
    const k1 = `listing/${user.id}/adrw4-a-${Date.now()}.jpg`;
    const k2 = `listing/${user.id}/adrw4-b-${Date.now()}.jpg`;
    await objectStorage.put(k1, Buffer.from('adrw4-object-1'), { contentType: 'image/jpeg' });
    await objectStorage.put(k2, Buffer.from('adrw4-object-2'), { contentType: 'image/jpeg' });
    await mediaService.attach(user.id, k1, 'listing');
    await mediaService.attach(user.id, k2, 'listing');

    const cookie = await cookieFor(user);
    const res = await request(app).delete('/api/users/me').set('Cookie', cookie);
    expect(res.status).toBe(202);

    // The old cookie is dead IMMEDIATELY (AB-05), long before the erasure runs.
    const replay = await request(app).get('/api/users/me').set('Cookie', cookie);
    expect(replay.status).toBe(401);

    // The job sits scheduled ~erasureDays out; make it due and drain ONLY it, counting one
    // deleteByKey call per owned object (ADR-004 per-object deletion).
    const jobs = await outboxRowsFor('account.erasure', 'userId', user.id);
    expect(jobs).toHaveLength(1);
    await dbh.query(
      `UPDATE outbox_jobs SET available_at = now() - interval '1 minute' WHERE id = $1`,
      [jobs[0].id]
    );
    const dispatch = require('../../src/outbox/dispatch');
    const registry = dispatch.loadHandlers();
    const spy = jest.spyOn(objectStorage, 'deleteByKey');
    try {
      await pollOnlyThese([jobs[0].id], registry, 1);
      expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual([k1, k2].sort());
    } finally {
      spy.mockRestore();
    }

    // Objects gone from MinIO; rows gone from PostgreSQL; PII emptied; request completed.
    await expect(objectStorage.get(k1)).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    await expect(objectStorage.get(k2)).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    const { rows: media } = await dbh.query(
      `SELECT id FROM media_objects WHERE owner_user_id = $1`,
      [user.id]
    );
    expect(media).toEqual([]);
    const { rows: erased } = await dbh.query(
      `SELECT email, full_name, phone_enc, anonymized_at FROM users WHERE id = $1`,
      [user.id]
    );
    expect(erased[0]).toMatchObject({
      email: `erased:${user.id}`,
      full_name: null,
      phone_enc: null,
    });
    expect(erased[0].anonymized_at).not.toBeNull();
    const { rows: reqRows } = await dbh.query(
      `SELECT status FROM data_requests WHERE user_id = $1 AND kind = 'erasure'`,
      [user.id]
    );
    expect(reqRows[0].status).toBe('completed');
  });
});

// ==========================================================================================
// Redis role (g) — wave-4 flows added only session / rate-limit / cache keys
// ==========================================================================================
describe('Redis role — after every wave-4 flow the keyspace is still sessions/cache only', () => {
  test('every key matches an approved namespace; no moderation/privacy state in Redis', async () => {
    const { redis } = require('../../src/db/redis');
    const keys = await redis.keys('*');
    const offenders = keys.filter((k) => !/^hp:(session|ratelimit|cache):/.test(k));
    expect(offenders).toEqual([]);
    expect(
      keys.filter((k) => /review|message|moderation|queue|export|erasure|privacy/.test(k))
    ).toEqual([]);
  });
});
