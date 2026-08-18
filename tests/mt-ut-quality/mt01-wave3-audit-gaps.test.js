// tests/mt-ut-quality/mt01-wave3-audit-gaps.test.js — verifier lane "mt-ut-quality".
//
// Wave-3 re-verification of MT-01 (SRS §4.6) / NFR-08, covering the parts of the audit trail
// the two sibling mt01 files leave under-asserted:
//
//   A. AB-03 / NFR-08 — "listing creations are logged with host ID and LOCAL DATE". The
//      sibling file only asserts `typeof rec.localDate === 'string'`; a stringified JS Date
//      satisfies that while being unusable as a MEHKO calendar day. This block pins the
//      contract the wire serializer already honours (src/modules/listings/serializers.js
//      isoCalendarDate): YYYY-MM-DD, equal to mehko.localDateFor(scheduledStart).
//      >>> THESE ASSERTIONS CURRENTLY FAIL — finding W3-MT-01 (see the lane's report).
//   B. MT-01 action 4 — a MODERATION DECISION. The moderation module is wave 4; this block
//      probes the surface so "not implemented" is a measured fact, not an assumption.
//   C. FR-04 meal completion — an "important action" per NFR-08's non-exhaustive list; its
//      audit records were not covered by any mt-ut-quality file.
//   D. FR-02/FR-03 media attachment and delete-mark audit records (correlation ID + IDs only).
//   E. The worker-initiated booking.promoted audit record (no HTTP request behind it).
//
// Everything runs against the REAL app factory (Supertest) + the REAL outbox worker on the
// seeded *_test database, with a recording logger sink capturing the exact bytes a log
// aggregator would receive. SQL is used only for test-environment state preparation
// (email verification, moderation approval, clock movement) — never to fake an assertion.
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const { loadHandlers } = require('../../src/outbox/dispatch');
const { pollOnce } = require('../../src/outbox/worker');
const mehko = require('../../src/modules/listings/mehko');
const mediaUrls = require('../../src/lib/mediaUrls');
const { query, closeDb } = require('../helpers/db');
const { closeRedis } = require('../../src/db/redis');

// ---- recording logger ------------------------------------------------------------------------
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
function auditsFor(event, cid) {
  return auditRecords().filter((r) => r.event === event && r.correlationId === cid);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// ---- fixture identity ---------------------------------------------------------------------
const RUN = `${process.pid}${Date.now()}`;
const HOST = {
  email: `mt01gap.host.${RUN}@mt01-lane.homeplate.invalid`,
  password: 'CorrectHorse!42gaph',
  fullName: 'Anselm Kingfisher-Hostperson',
  phone: '+14155550311',
};
const GUEST = {
  email: `mt01gap.guest.${RUN}@mt01-lane.homeplate.invalid`,
  password: 'CorrectHorse!42gapg',
  fullName: 'Ottoline Marmoset-Guestperson',
  phone: '+14155550322',
};
const STREET = '1180 Chaparral Ridge Terrace';

let app;
let hostId;
let guestId;
let hostCookie;
let guestCookie;
let listingId;
let listingScheduledStart;
let bookingId;

async function registerAndLogin(identity) {
  const reg = await request(app).post('/api/auth/register').send(identity);
  expect(reg.status).toBe(201);
  const userId = reg.body.user.id;
  await query('UPDATE users SET email_verified = true WHERE id = $1', [userId]);
  const login = await request(app)
    .post('/api/auth/login')
    .send({ email: identity.email, password: identity.password });
  expect(login.status).toBe(200);
  return { userId, cookie: login.headers['set-cookie'].join(';') };
}

function listingBody(scheduledStart, overrides = {}) {
  return {
    title: 'MT01 Gap Lane Pozole',
    description: 'Audit-trail gap probe meal.',
    ingredients: ['hominy', 'pork'],
    allergens: [],
    cuisine: 'mexican',
    scheduledStart,
    durationMinutes: 90,
    seatCapacity: 2,
    addressLine1: STREET,
    city: 'San Diego',
    region: 'CA',
    postalCode: '92101',
    country: 'US',
    ...overrides,
  };
}

beforeAll(async () => {
  app = createApp({ logger: recLogger });
  ({ userId: hostId, cookie: hostCookie } = await registerAndLogin(HOST));
  ({ userId: guestId, cookie: guestCookie } = await registerAndLogin(GUEST));
  await query(
    `INSERT INTO host_profiles (user_id, bio, host_agreement_accepted_at)
     VALUES ($1, $2, now())`,
    [hostId, 'MT-01 audit-gap fixture host.']
  );
});

afterAll(async () => {
  await closeRedis();
  await closeDb();
});

// =============================================================================================
// A. AB-03 / NFR-08 — the LOCAL DATE in listing audit records must be a MEHKO calendar day
// =============================================================================================
describe('MT-01 / AB-03 — listing audit records carry a YYYY-MM-DD LA calendar day', () => {
  const createCid = `mt01gap-create-${RUN}`;
  const updateCid = `mt01gap-update-${RUN}`;
  const cancelCid = `mt01gap-cancel-${RUN}`;

  test('listing.created — localDate equals mehko.localDateFor(scheduledStart) in YYYY-MM-DD', async () => {
    listingScheduledStart = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .set('X-Correlation-Id', createCid)
      .send(listingBody(listingScheduledStart));
    expect(res.status).toBe(201);
    listingId = res.body.listing.id;

    const expected = mehko.localDateFor(listingScheduledStart);
    expect(expected).toMatch(ISO_DATE); // sanity: the module under comparison is well-formed
    // The wire serializer already gets this right — the audit record must agree with it.
    expect(res.body.listing.localDate).toBe(expected);

    const [rec] = auditsFor('listing.created', createCid);
    expect(rec).toBeDefined();
    expect(rec.hostId).toBe(hostId);
    // AB-03: the reviewable local date. A stringified JS Date is not a calendar day.
    expect(rec.localDate).toMatch(ISO_DATE);
    expect(rec.localDate).toBe(expected);
  });

  test('listing.updated — a reschedule audits the NEW local date in YYYY-MM-DD', async () => {
    const newStart = new Date(Date.now() + 96 * 3600 * 1000).toISOString();
    const res = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', hostCookie)
      .set('X-Correlation-Id', updateCid)
      .send({ scheduledStart: newStart });
    expect(res.status).toBe(200);
    listingScheduledStart = newStart;

    const expected = mehko.localDateFor(newStart);
    expect(res.body.listing.localDate).toBe(expected);

    const [rec] = auditsFor('listing.updated', updateCid);
    expect(rec).toBeDefined();
    expect(rec.entityId).toBe(listingId);
    expect(rec.localDate).toMatch(ISO_DATE);
    expect(rec.localDate).toBe(expected);
  });

  test('listing.cancelled — the audit record also carries a YYYY-MM-DD local date', async () => {
    // Use a throwaway listing on a DIFFERENT LA day so the 1-listing/host/day cap is untouched.
    const start = new Date(Date.now() + 10 * 24 * 3600 * 1000).toISOString();
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(listingBody(start, { title: 'MT01 Gap Lane Cancel Probe' }));
    expect(created.status).toBe(201);

    const res = await request(app)
      .post(`/api/listings/${created.body.listing.id}/cancel`)
      .set('Cookie', hostCookie)
      .set('X-Correlation-Id', cancelCid)
      .send();
    expect(res.status).toBe(200);

    const [rec] = auditsFor('listing.cancelled', cancelCid);
    expect(rec).toBeDefined();
    expect(rec.localDate).toMatch(ISO_DATE);
    expect(rec.localDate).toBe(mehko.localDateFor(start));
  });
});

// =============================================================================================
// B. MT-01 action 4 — moderation decision (wave 4): measured absence, not assumed
// =============================================================================================
describe('MT-01 action 4 — a moderation decision cannot be performed in this build', () => {
  test('no moderation decision surface is mounted (probed, not assumed)', async () => {
    const probes = [
      ['get', '/api/moderation/queue'],
      ['post', '/api/moderation/decisions'],
      ['post', `/api/moderation/items/${listingId}/approve`],
      ['post', `/api/listings/${listingId}/moderate`],
    ];
    for (const [method, path] of probes) {
      const res = await request(app)[method](path).set('Cookie', hostCookie).send();
      expect([404, 405]).toContain(res.status);
    }
    // No moderation.decision audit event can exist anywhere in the corpus.
    expect(auditRecords().filter((r) => String(r.event).startsWith('moderation.'))).toHaveLength(0);
  });

  test('the FR-08 safe direction holds meanwhile: the listing is still PENDING, unpublished', async () => {
    const { rows } = await query('SELECT moderation_status FROM listings WHERE id = $1', [
      listingId,
    ]);
    expect(rows[0].moderation_status).toBe('pending');
  });
});

// =============================================================================================
// C. FR-04 meal completion — audit records for an "important action" (NFR-08)
// =============================================================================================
describe('MT-01 / FR-04 — completion confirmations are audited with correlation IDs', () => {
  const bookCid = `mt01gap-book-${RUN}`;
  const guestConfirmCid = `mt01gap-cg-${RUN}`;
  const hostConfirmCid = `mt01gap-ch-${RUN}`;

  beforeAll(async () => {
    await query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [listingId]);
    const res = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .set('X-Correlation-Id', bookCid)
      .send({ listingId });
    expect(res.status).toBe(201);
    bookingId = res.body.booking.id;
    // Move the meal into the past and the booking into in_progress — the state the FR-04
    // dual-confirmation flow requires (the promote worker does this on the real clock).
    await query(`UPDATE listings SET scheduled_start = now() - interval '3 hours' WHERE id = $1`, [
      listingId,
    ]);
    await query(`UPDATE bookings SET status = 'in_progress' WHERE id = $1`, [bookingId]);
  });

  test('the guest confirmation audits booking.completion_confirmed (awaiting the other party)', async () => {
    const res = await request(app)
      .post(`/api/bookings/${bookingId}/confirm-completion`)
      .set('Cookie', guestCookie)
      .set('X-Correlation-Id', guestConfirmCid)
      .send();
    expect(res.status).toBe(200);
    expect(res.body.awaitingOtherParty).toBe(true);

    const [rec] = auditsFor('booking.completion_confirmed', guestConfirmCid);
    expect(rec).toBeDefined();
    expect(rec.outcome).toBe('success');
    expect(rec.actorUserId).toBe(guestId);
    expect(rec.entityType).toBe('booking');
    expect(rec.entityId).toBe(bookingId);
    expect(rec.role).toBe('guest');
    expect(Number.isNaN(Date.parse(rec.time))).toBe(false);
  });

  test('the host confirmation audits booking.completed and the row really is completed', async () => {
    const res = await request(app)
      .post(`/api/bookings/${bookingId}/confirm-completion`)
      .set('Cookie', hostCookie)
      .set('X-Correlation-Id', hostConfirmCid)
      .send();
    expect(res.status).toBe(200);

    const [rec] = auditsFor('booking.completed', hostConfirmCid);
    expect(rec).toBeDefined();
    expect(rec.actorUserId).toBe(hostId);
    expect(rec.entityId).toBe(bookingId);

    const { rows } = await query('SELECT status, completed_at FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    expect(rows[0].status).toBe('completed');
    expect(rows[0].completed_at).not.toBeNull();
  });

  test('a non-participant confirmation is refused 403 and leaves no success record', async () => {
    const cid = `mt01gap-intruder-${RUN}`;
    const intruder = await registerAndLogin({
      email: `mt01gap.intruder.${RUN}@mt01-lane.homeplate.invalid`,
      password: 'CorrectHorse!42gapi',
      fullName: 'Thaddeus Pangolin-Intruder',
      phone: '+14155550333',
    });
    const res = await request(app)
      .post(`/api/bookings/${bookingId}/confirm-completion`)
      .set('Cookie', intruder.cookie)
      .set('X-Correlation-Id', cid)
      .send();
    expect(res.status).toBe(403);
    expect(
      auditRecords().filter((r) => r.correlationId === cid && r.outcome === 'success')
    ).toEqual([]);
    // The refusal is still traceable: the error line carries the correlation ID and status.
    const errs = records().filter((r) => r.event === 'request_error' && r.correlationId === cid);
    expect(errs).toHaveLength(1);
    expect(errs[0].status).toBe(403);
  });
});

// =============================================================================================
// D. FR-02 / FR-03 media attachment audit records
// =============================================================================================
describe('MT-01 — media attach / delete-mark are audited with IDs only', () => {
  let mediaId;
  const attachCid = `mt01gap-media-${RUN}`;
  const deleteCid = `mt01gap-mediadel-${RUN}`;

  test('POST /api/media audits media.attached with the request correlation ID', async () => {
    const target = await request(app)
      .post('/api/media/uploads')
      .set('Cookie', hostCookie)
      .send({ kind: 'listing', contentType: 'image/jpeg', sizeBytes: 4096 });
    expect(target.status).toBe(200);
    expect(target.body.storageKey).toMatch(mediaUrls.KEY_PATTERN);

    const res = await request(app)
      .post('/api/media')
      .set('Cookie', hostCookie)
      .set('X-Correlation-Id', attachCid)
      .send({
        storageKey: target.body.storageKey,
        kind: 'listing',
        entityId: listingId,
        contentType: 'image/jpeg',
        sizeBytes: 4096,
      });
    expect(res.status).toBe(201);
    mediaId = res.body.media.id;

    const [rec] = auditsFor('media.attached', attachCid);
    expect(rec).toBeDefined();
    expect(rec.outcome).toBe('success');
    expect(rec.actorUserId).toBe(hostId);
    expect(rec.entityType).toBe('media');
    expect(rec.entityId).toBe(mediaId);
    expect(rec.attachedTo).toBe(listingId);
  });

  test('DELETE /api/media/:id audits media.delete_marked', async () => {
    const res = await request(app)
      .delete(`/api/media/${mediaId}`)
      .set('Cookie', hostCookie)
      .set('X-Correlation-Id', deleteCid)
      .send();
    expect(res.status).toBe(204);

    const [rec] = auditsFor('media.delete_marked', deleteCid);
    expect(rec).toBeDefined();
    expect(rec.entityId).toBe(mediaId);
    expect(rec.actorUserId).toBe(hostId);
  });
});

// =============================================================================================
// E. Worker-initiated audit records (no HTTP request behind them)
// =============================================================================================
describe('MT-01 — worker-initiated transitions stay traceable', () => {
  test('booking.promote runs and its audit/log lines carry the originating correlation ID', async () => {
    const cid = `mt01gap-promote-${RUN}`;
    // A fresh listing on its own LA day, approved, booked, then made due.
    const start = new Date(Date.now() + 20 * 24 * 3600 * 1000).toISOString();
    const listing = await request(app)
      .post('/api/listings')
      .set('Cookie', hostCookie)
      .send(listingBody(start, { title: 'MT01 Gap Lane Promote Probe' }));
    expect(listing.status).toBe(201);
    const promoteListingId = listing.body.listing.id;
    await query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [
      promoteListingId,
    ]);

    const booking = await request(app)
      .post('/api/bookings')
      .set('Cookie', guestCookie)
      .set('X-Correlation-Id', cid)
      .send({ listingId: promoteListingId });
    expect(booking.status).toBe(201);
    const promoteBookingId = booking.body.booking.id;

    // Make the promotion due: the meal starts now, the job is available now.
    await query(`UPDATE listings SET scheduled_start = now() WHERE id = $1`, [promoteListingId]);
    await query(
      `UPDATE outbox_jobs SET available_at = now() - interval '1 minute'
       WHERE type = 'booking.promote' AND payload->>'bookingId' = $1`,
      [promoteBookingId]
    );

    const registry = loadHandlers({ log: recLogger });
    // DETERMINISM (verification-report F-01): a RUNAWAY GUARD, not a budget. pollOnce claims from the
    // whole outbox table oldest-first, ten rows a pass, so the passes this job needs depend
    // on how many rows sibling suites left behind — state this test does not own. The loop
    // is ended by the `stats.claimed === 0` break below (jobs that back off take a future
    // available_at and drop out of the claim), never by this number.
    for (let i = 0; i < 5000; i += 1) {
      const stats = await pollOnce({ registry, log: recLogger });
      const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [promoteBookingId]);
      if (rows[0].status !== 'pending') break;
      if (stats.claimed === 0) break;
    }

    const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [promoteBookingId]);
    expect(rows[0].status).toBe('in_progress');

    const promoted = auditRecords().filter(
      (r) => r.event === 'booking.promoted' && r.entityId === promoteBookingId
    );
    expect(promoted).toHaveLength(1);
    // NFR-08: the worker line is traceable back to the request that created the booking.
    expect(promoted[0].correlationId).toBe(cid);
    // MTUT-W3-02 (re-verification 2026-08-17): MT-01's acceptance names an ACTOR on every audit
    // record. Round-1 measurement of this record's key set found no `actorUserId` at all:
    //   ["level","time","service","correlationId","jobId","jobType","attempt","audit",
    //    "event","outcome","entityType","entityId","msg"]
    // The repair makes the system actor explicit rather than absent. Asserted here so the
    // resolution is proven by a test, not by a fixer's report: the key must be PRESENT (pino
    // drops `undefined` but emits `null`), and `actor` must name the worker.
    expect(Object.keys(promoted[0])).toContain('actorUserId');
    expect(promoted[0].actorUserId).toBeNull();
    expect(promoted[0].actor).toBe('system:outbox');
    expect(promoted[0].jobType).toBe('booking.promote');
  });
});

// =============================================================================================
// F. SRS §3.4 PII register over this file's whole corpus
// =============================================================================================
describe('MT-01 — SRS §3.4 PII register over the wave-3 audit corpus', () => {
  test('no email, password, name, phone or street address in any captured line', () => {
    const blob = lines.join('\n');
    expect(lines.length).toBeGreaterThan(30);
    for (const identity of [HOST, GUEST]) {
      expect(blob).not.toContain(identity.email);
      expect(blob).not.toContain(identity.password);
      expect(blob).not.toContain(identity.fullName);
      expect(blob).not.toContain(identity.phone);
    }
    expect(blob).not.toContain('Kingfisher');
    expect(blob).not.toContain('Marmoset');
    expect(blob).not.toContain('Pangolin');
    expect(blob).not.toContain(STREET);
    expect(blob).not.toContain('Chaparral');
    expect(blob).not.toContain('92101'); // postal code is location identity too (ADR-010)
    expect(blob.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).toEqual([]);
    for (const id of [hostId, guestId, listingId, bookingId]) {
      expect(blob).toContain(id);
    }
  });
});
