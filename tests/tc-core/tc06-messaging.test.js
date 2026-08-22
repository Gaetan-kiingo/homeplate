// tests/tc-core/tc06-messaging.test.js — TC-06 / FR-06: the host↔guest booking thread
// (SRS §3.1; acceptance per docs/_generated/requirements-inventory.json). Replaces the
// wave-4 status probe that lived in tc05-07-wave4-status.test.js, exactly as that file's
// header instructed.
//
// Asserted here, by execution against the seeded test DB (SRS §4.1):
//   - POST and GET /api/bookings/:id/messages succeed ONLY for the booking's guest and the
//     listing's host (published bookingsRepo.findParticipantBooking), on bookings whose
//     status is pending, in_progress or completed; a cancelled booking is 409, a third
//     party (a moderator included — NFR-13 data minimization) is 403, no session is 401,
//     an unknown booking is 404, a malformed id is 422;
//   - a posted message is persisted and returned in the 201 IMMEDIATELY, and the other
//     participant reads it at once while its scan job is still queued — delivery NEVER
//     waits on moderation (ADR-002), proven again under a full provider outage;
//   - the message row and its 'moderation.scan' outbox row commit in the SAME transaction
//     (xmin proof) with an IDs-only payload, and ZERO adapter modules load on the request
//     path (require.cache assertion — ADR-001/003);
//   - a message the 4A pipeline flags is escalated to the REAL moderator queue (visible to
//     the Moderator with its excerpt), and once rejected — by the human decision, or
//     directly by the deterministic pre-filter — it is hidden from every subsequent GET of
//     both participants while its MODERATION_DECISION rows and resolved queue entry remain
//     (FR-08 / AB-04); an approved message stays visible;
//   - ORDER: the ADR-001/003 request-path purity assertions run FIRST; tests that
//     legitimately load the worker registry (and thereby the mock LLM adapter) run AFTER
//     them, via lazy requires — same discipline as adr-wave3-invariants.
//
// Requirement traceability: FR-06 (TC-06), FR-08, NFR-08, NFR-11, NFR-13, AB-04, AB-06, AB-08.
'use strict';

const path = require('path');
const request = require('supertest');

const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const dbh = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const { pollOnlyThese } = require('../helpers/outboxScope');
const support = require('./support');

const sink = { write() {} };
const UNKNOWN_UUID = '00000000-0000-4000-8000-0000000006ff';

const quietLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return this;
  },
};

let app;
let host;
let hostCookie;
let guest;
let guestCookie;
let stranger;
let strangerCookie;
let moderator;
let moderatorCookie;
let listing;

// Loaded LAZILY (inside tests that run AFTER the purity assertions): the registry pulls the
// mock LLM adapter into require.cache, which must not happen before the request-path tests.
let registry = null;
let mockLlm = null;

function workerRegistry() {
  if (!registry) {
    // eslint-disable-next-line global-require
    const { loadHandlers } = require('../../src/outbox/dispatch');
    registry = loadHandlers({ log: quietLog });
  }
  return registry;
}

function mock() {
  if (!mockLlm) {
    // eslint-disable-next-line global-require
    mockLlm = require('../../src/adapters/llmModeration.mock');
  }
  return mockLlm;
}

beforeAll(async () => {
  app = createApp({ logger: createLogger({ level: 'silent', stream: sink }) });
  host = await dbh.makeUser({ can_publish_listing: true, full_name: 'TC06 Host' });
  await dbh.makeHostProfile({ user_id: host.id, bio: 'TC06 host bio.' });
  guest = await dbh.makeUser({ full_name: 'TC06 Guest' });
  stranger = await dbh.makeUser();
  moderator = await dbh.makeUser({ roles: ['user', 'moderator'] });
  hostCookie = await support.cookieFor(host);
  guestCookie = await support.cookieFor(guest);
  strangerCookie = await support.cookieFor(stranger);
  moderatorCookie = await support.cookieFor(moderator);
  listing = await support.makeApprovedListing({ host_id: host.id });
});

afterAll(async () => {
  try {
    if (mockLlm) mockLlm.reset();
  } finally {
    try {
      await dbh.closeDb();
    } finally {
      await closeTestRedis();
    }
  }
});

function bookingIn(status, overrides = {}) {
  const completionFlags =
    status === 'completed'
      ? { host_confirmed_completion: true, guest_confirmed_completion: true }
      : {};
  return dbh.makeBooking({
    listing_id: listing.id,
    guest_id: guest.id,
    status,
    ...completionFlags,
    ...overrides,
  });
}

async function scanJobFor(messageId) {
  const { rows } = await dbh.query(
    `SELECT id, payload, status, attempt_count, last_error, xmin::text AS xid FROM outbox_jobs
      WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
    [messageId]
  );
  return rows;
}

async function moderationStatusOf(messageId) {
  const { rows } = await dbh.query(`SELECT moderation_status FROM messages WHERE id = $1`, [
    messageId,
  ]);
  return rows[0].moderation_status;
}

async function decisionsFor(messageId) {
  const { rows } = await dbh.query(
    `SELECT category, outcome, decided_by, model_id FROM moderation_decisions
      WHERE content_type = 'message' AND content_id = $1
      ORDER BY created_at, id`,
    [messageId]
  );
  return rows;
}

async function queueItemsFor(messageId) {
  const { rows } = await dbh.query(
    `SELECT id, reason, status FROM moderation_queue
      WHERE content_type = 'message' AND content_id = $1`,
    [messageId]
  );
  return rows;
}

/** Message ids the given participant currently reads on the thread (page big enough). */
async function threadIdsFor(bookingId, cookie) {
  const res = await support.get(
    app,
    `/api/bookings/${bookingId}/messages?page=1&pageSize=100`,
    cookie
  );
  expect(res.status).toBe(200);
  return res.body.items.map((m) => m.id);
}

// =============================================================================================
// 1. The participant/state truth table + request-path purity (MUST RUN FIRST — see header)
// =============================================================================================
describe('TC-06 · participant gating truth table at the HTTP boundary', () => {
  test('401 unauthenticated on both verbs — never data, never a row (AB-08)', async () => {
    const booking = await bookingIn('pending');
    const post = await request(app)
      .post(`/api/bookings/${booking.id}/messages`)
      .send({ body: 'no session' });
    expect(post.status).toBe(401);
    const get = await request(app).get(`/api/bookings/${booking.id}/messages`);
    expect(get.status).toBe(401);
    const { rows } = await dbh.query(`SELECT id FROM messages WHERE booking_id = $1`, [booking.id]);
    expect(rows).toEqual([]);
  });

  test('422 malformed id; 404 unknown booking; 403 third party AND moderator; both verbs', async () => {
    const booking = await bookingIn('pending');

    const badPost = await support.post(app, `/api/bookings/not-a-uuid/messages`, guestCookie, {
      body: 'malformed id',
    });
    expect(badPost.status).toBe(422);
    const badGet = await support.get(app, `/api/bookings/not-a-uuid/messages`, guestCookie);
    expect(badGet.status).toBe(422);

    const ghostPost = await support.post(
      app,
      `/api/bookings/${UNKNOWN_UUID}/messages`,
      guestCookie,
      { body: 'ghost booking' }
    );
    expect(ghostPost.status).toBe(404);
    const ghostGet = await support.get(app, `/api/bookings/${UNKNOWN_UUID}/messages`, guestCookie);
    expect(ghostGet.status).toBe(404);

    for (const cookie of [strangerCookie, moderatorCookie]) {
      const post = await support.post(app, `/api/bookings/${booking.id}/messages`, cookie, {
        body: 'not my meal',
      });
      expect(post.status).toBe(403);
      expect(post.body.error.code).toBe('NOT_PARTICIPANT');
      // NFR-13 data minimization: no moderator thread-reading route exists beyond the
      // queue's flagged-content excerpt — a moderator reads a thread only as a participant.
      const get = await support.get(app, `/api/bookings/${booking.id}/messages`, cookie);
      expect(get.status).toBe(403);
      expect(get.body.error.code).toBe('NOT_PARTICIPANT');
    }
  });

  test('409 BOOKING_CANCELLED on both verbs; no message row is written', async () => {
    const cancelled = await bookingIn('cancelled', { cancelled_at: new Date() });
    const post = await support.post(app, `/api/bookings/${cancelled.id}/messages`, guestCookie, {
      body: 'too late',
    });
    expect(post.status).toBe(409);
    expect(post.body.error.code).toBe('BOOKING_CANCELLED');
    const get = await support.get(app, `/api/bookings/${cancelled.id}/messages`, hostCookie);
    expect(get.status).toBe(409);
    expect(get.body.error.code).toBe('BOOKING_CANCELLED');
    const { rows } = await dbh.query(`SELECT id FROM messages WHERE booking_id = $1`, [
      cancelled.id,
    ]);
    expect(rows).toEqual([]);
  });

  test('pending, in_progress and completed all accept both verbs from BOTH participants (FR-06)', async () => {
    for (const status of ['pending', 'in_progress', 'completed']) {
      const booking = await bookingIn(status);
      const fromGuest = await support.post(
        app,
        `/api/bookings/${booking.id}/messages`,
        guestCookie,
        { body: `guest question on a ${status} booking` }
      );
      expect(fromGuest.status).toBe(201);
      expect(fromGuest.body.message.senderId).toBe(guest.id);
      const fromHost = await support.post(app, `/api/bookings/${booking.id}/messages`, hostCookie, {
        body: `host answer on a ${status} booking`,
      });
      expect(fromHost.status).toBe(201);
      // Both participants read the whole thread, oldest first.
      for (const cookie of [guestCookie, hostCookie]) {
        const ids = await threadIdsFor(booking.id, cookie);
        expect(ids).toEqual([fromGuest.body.message.id, fromHost.body.message.id]);
      }
    }
  });

  test('ADR-001/003: all the traffic above loaded ZERO adapter modules (request-path purity)', () => {
    // Every POST/GET this file has made so far — including the ones that wrote scan jobs —
    // ran without src/adapters/* entering require.cache: the LLM stage is worker-only.
    const loadedAdapters = Object.keys(require.cache).filter((p) =>
      p.includes(`${path.sep}src${path.sep}adapters${path.sep}`)
    );
    expect(loadedAdapters).toEqual([]);
  });
});

// =============================================================================================
// 2. Immediate delivery + the one-transaction scan enqueue (FR-06 / FR-08 / ADR-002/003)
// =============================================================================================
describe('TC-06 · delivered immediately; scan row in the SAME transaction, IDs only', () => {
  test('201 returns the message; the other participant reads it while the scan is still queued', async () => {
    const booking = await bookingIn('pending');
    const res = await support.post(app, `/api/bookings/${booking.id}/messages`, guestCookie, {
      body: 'Can I bring my famous lemonade?',
    });
    expect(res.status).toBe(201);
    const message = res.body.message;
    // NFR-13 allowlist on the wire: sender id, body, timestamps and lifecycle IDs — nothing
    // email-, phone- or address-shaped, and no listing location data rides a message.
    expect(Object.keys(message).sort()).toEqual(
      ['id', 'bookingId', 'senderId', 'body', 'createdAt'].sort()
    );
    expect(JSON.stringify(res.body)).not.toMatch(support.EMAIL_SHAPE);

    // ONE transaction (xmin): the message row and its moderation.scan row commit together;
    // the payload is IDs-only (ADR-003) — never the text.
    const jobs = await scanJobFor(message.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].status).toBe('pending'); // not yet scanned…
    expect(jobs[0].payload).toEqual({ contentType: 'message', contentId: message.id });
    const { rows: xid } = await dbh.query(`SELECT xmin::text AS xid FROM messages WHERE id = $1`, [
      message.id,
    ]);
    expect(jobs[0].xid).toBe(xid[0].xid);

    // …and the host ALREADY reads it: delivery never waits on the scan (ADR-002).
    expect(await threadIdsFor(booking.id, hostCookie)).toContain(message.id);
    expect(await moderationStatusOf(message.id)).toBe('pending');
  });

  test('a full moderation-provider OUTAGE delays only the scan — the message stays delivered', async () => {
    const booking = await bookingIn('in_progress');
    const res = await support.post(app, `/api/bookings/${booking.id}/messages`, guestCookie, {
      body: 'A completely ordinary question about parking.',
    });
    expect(res.status).toBe(201);
    const messageId = res.body.message.id;
    const [job] = await scanJobFor(messageId);

    mock().setOutage(true);
    try {
      await pollOnlyThese([job.id], workerRegistry(), 1);
    } finally {
      mock().setOutage(false);
    }
    // The scan FAILED and is backing off (ADR-002/NFR-09) — attempt recorded, still pending.
    const [failed] = await scanJobFor(messageId);
    expect(failed.status).toBe('pending');
    expect(failed.attempt_count).toBe(1);
    expect(failed.last_error).toMatch(/provider unavailable/i);
    // Delivery is untouched: both participants still read the message (FR-06 acceptance —
    // messages are never withheld pending moderation).
    expect(await threadIdsFor(booking.id, hostCookie)).toContain(messageId);
    expect(await threadIdsFor(booking.id, guestCookie)).toContain(messageId);

    // Provider recovers: make the retry due now and drain — benign, auto-approved, STILL
    // visible; the delayed scan changed nothing the participants could observe.
    await dbh.query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [job.id]);
    await pollOnlyThese([job.id], workerRegistry(), 1);
    expect((await scanJobFor(messageId))[0].status).toBe('delivered');
    expect(await moderationStatusOf(messageId)).toBe('approved');
    expect(await threadIdsFor(booking.id, hostCookie)).toContain(messageId);
  });
});

// =============================================================================================
// 3. Flagged → queued → rejected → hidden (FR-08 / AB-04, through the REAL 4A pipeline)
// =============================================================================================
describe('TC-06 · a flagged message is delivered, queued for the human, and hidden on rejection', () => {
  test('abusive message: delivered → escalated with excerpt in the moderator queue → human reject hides it from BOTH participants', async () => {
    const booking = await bookingIn('in_progress');
    const abusiveBody = 'You are an offensive-fixture kind of host, truly.';
    const res = await support.post(app, `/api/bookings/${booking.id}/messages`, hostCookie, {
      body: abusiveBody,
    });
    expect(res.status).toBe(201); // delivered immediately — the scan has not run (ADR-002)
    const messageId = res.body.message.id;
    expect(await threadIdsFor(booking.id, guestCookie)).toContain(messageId);

    // The REAL pipeline: mock classifier flags it offensive → escalated, queue item filed.
    const [job] = await scanJobFor(messageId);
    await pollOnlyThese([job.id], workerRegistry());
    expect(await moderationStatusOf(messageId)).toBe('pending'); // no auto-reject for a flag
    const queued = await queueItemsFor(messageId);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ reason: 'flagged', status: 'open' });
    let decisions = await decisionsFor(messageId);
    expect(decisions).toEqual([
      expect.objectContaining({ category: 'offensive', outcome: 'escalated', decided_by: 'llm' }),
    ]);

    // Escalated-but-undecided: STILL delivered (private messages are not public content —
    // only a rejection retracts one; ADR-002).
    expect(await threadIdsFor(booking.id, guestCookie)).toContain(messageId);

    // The moderator sees it in the REAL queue with the flagged-content excerpt (their ONLY
    // window on message content — NFR-13).
    const queue = await support.get(
      app,
      `/api/moderation/queue?contentType=message&status=open&page=1&pageSize=100`,
      moderatorCookie
    );
    expect(queue.status).toBe(200);
    const entry = queue.body.items.find((i) => i.contentId === messageId);
    expect(entry).toBeDefined();
    expect(entry.excerpt).toContain('offensive-fixture');

    // The human rejects through the real surface — not SQL.
    const decide = await support.post(
      app,
      `/api/moderation/queue/${queued[0].id}/decision`,
      moderatorCookie,
      { decision: 'reject', category: 'offensive', note: 'harassment of the guest' }
    );
    expect(decide.status).toBe(200);
    expect(await moderationStatusOf(messageId)).toBe('rejected');

    // HIDDEN from every subsequent GET, for both participants (AB-04) — and the record
    // remains: two MODERATION_DECISION rows and the resolved queue entry.
    expect(await threadIdsFor(booking.id, guestCookie)).not.toContain(messageId);
    expect(await threadIdsFor(booking.id, hostCookie)).not.toContain(messageId);
    decisions = await decisionsFor(messageId);
    expect(decisions).toHaveLength(2);
    expect(decisions[1]).toMatchObject({
      category: 'offensive',
      outcome: 'rejected',
      decided_by: 'human',
    });
    expect((await queueItemsFor(messageId))[0].status).toBe('resolved');
  });

  test('pre-filter blocklist hit: rejected by the pipeline itself and hidden — zero LLM calls', async () => {
    const booking = await bookingIn('pending');
    const res = await support.post(app, `/api/bookings/${booking.id}/messages`, guestCookie, {
      body: 'Pay me by western union or else.',
    });
    expect(res.status).toBe(201); // still delivered first — the pre-filter runs in the worker
    const messageId = res.body.message.id;
    expect(await threadIdsFor(booking.id, hostCookie)).toContain(messageId);

    const [job] = await scanJobFor(messageId);
    await pollOnlyThese([job.id], workerRegistry());
    expect(await moderationStatusOf(messageId)).toBe('rejected');
    const decisions = await decisionsFor(messageId);
    expect(decisions).toEqual([
      expect.objectContaining({
        category: 'fraudulent',
        outcome: 'rejected',
        decided_by: 'pre_filter',
        model_id: null, // stage 1 is deterministic — no model touched it (ADR-002)
      }),
    ]);
    expect(await threadIdsFor(booking.id, hostCookie)).not.toContain(messageId);
    expect(await threadIdsFor(booking.id, guestCookie)).not.toContain(messageId);
  });

  test('a benign message auto-approves and stays visible; thread total reflects hiding', async () => {
    const booking = await bookingIn('completed');
    const benign = await support.post(app, `/api/bookings/${booking.id}/messages`, guestCookie, {
      body: 'Thank you for a lovely meal!',
    });
    const flagged = await support.post(app, `/api/bookings/${booking.id}/messages`, guestCookie, {
      body: 'And here is some offensive-fixture spite.',
    });
    expect(benign.status).toBe(201);
    expect(flagged.status).toBe(201);

    const [benignJob] = await scanJobFor(benign.body.message.id);
    const [flaggedJob] = await scanJobFor(flagged.body.message.id);
    await pollOnlyThese([benignJob.id, flaggedJob.id], workerRegistry());
    expect(await moderationStatusOf(benign.body.message.id)).toBe('approved');

    const queued = await queueItemsFor(flagged.body.message.id);
    const decide = await support.post(
      app,
      `/api/moderation/queue/${queued[0].id}/decision`,
      moderatorCookie,
      { decision: 'reject', category: 'offensive' }
    );
    expect(decide.status).toBe(200);

    const thread = await support.get(
      app,
      `/api/bookings/${booking.id}/messages?page=1&pageSize=100`,
      hostCookie
    );
    expect(thread.status).toBe(200);
    expect(thread.body.items.map((m) => m.id)).toEqual([benign.body.message.id]);
    expect(thread.body.total).toBe(1); // the hidden message is not even counted
  });
});
