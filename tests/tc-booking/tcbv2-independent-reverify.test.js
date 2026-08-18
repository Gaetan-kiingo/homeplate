// tests/tc-booking/tcbv2-independent-reverify.test.js — VERIFIER lane "tc-booking",
// INDEPENDENT RE-VERIFICATION of repair round 1 (f7f954c) plus the lane's normal FR-08..FR-14
// mandate. This file deliberately does NOT reuse tests/tc-booking/tcb-w3-reverify.test.js:
// that file was edited by the fixers whose work is under review here, so it cannot be the
// evidence that their work is correct. Every assertion below re-derives the original
// failureScenario from docs/_generated/verification-findings-wave3.json.
//
// Requirement traceability (SRS Appendix B):
//   FR-08  wave-4 gap asserted as ABSENT (no moderation decision path exists yet)
//   FR-09  eligibility — BOTH the restricted and the permitted state, over the real routes
//   FR-10  registration + email verification through the value the DELIVERY PIPELINE carries
//          (finding TCB-W3-01: waves 1-2 "passed" FR-10 by reading an in-process return value)
//   FR-11  one listing/host/day + AB 626 meal caps, enforced SERVER-SIDE from src/config
//   FR-12  atomic reservation under concurrency; a refusal leaves capacity UNCHANGED;
//          AB-02 per-guest concurrent-pending cap
//   FR-13  notifications enqueued in the booking transaction; an ADAPTER FAILURE neither
//          rolls back nor delays the booking transaction (ADR-001/003 — worker-only delivery)
//   FR-14  cancellation before scheduled start restores capacity atomically
//   ADR-009 caps are configuration, evaluated in America/Los_Angeles
//   ADR-011 mock transport; every emitted template id resolves to a real subject (TCB-W3-04)
'use strict';

const request = require('supertest');
const { createApp } = require('../../src/app');
const { query, makeUser, makeHostProfile, makeListing, closeDb } = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const config = require('../../src/config');
const sessions = require('../../src/modules/auth/sessions');
const dispatch = require('../../src/outbox/dispatch');
const mockTransport = require('../../src/adapters/mockTransport');
const sendgrid = require('../../src/adapters/sendgrid');
const { logger } = require('../../src/lib/logger');

const COOKIE = config.auth.sessionCookieName;
const PASSWORD = 'Tcbv2-strong-pw!42';

let app;
let seq = 0;
function uniq(prefix) {
  seq += 1;
  return `${prefix}-${seq}-${process.pid}-${Date.now()}`;
}

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  mockTransport.reset();
  await closeDb();
  await closeTestRedis();
});

beforeEach(() => {
  mockTransport.reset();
});

// ---- fixtures (all scoped to rows this file creates — never a whole-table scan) ---------------

async function cookieFor(user) {
  const { token } = await sessions.createSession(user);
  return `${COOKIE}=${token}`;
}

/** FR-09-eligible guest: verified email + full name + phone ciphertext present. */
async function makeGuest(overrides = {}) {
  return makeUser({ phone_enc: 'enc:v1:tcbv2', ...overrides });
}

/** FR-09-eligible host: guest attributes + complete host profile + host agreement. */
async function makeEligibleHost() {
  const host = await makeUser({ can_publish_listing: true, phone_enc: 'enc:v1:tcbv2' });
  await makeHostProfile({ user_id: host.id });
  return host;
}

async function approvedListing(overrides = {}) {
  return makeListing({ moderation_status: 'approved', ...overrides });
}

function book(cookie, listingId) {
  return request(app).post('/api/bookings').set('Cookie', cookie).send({ listingId });
}

function cancel(cookie, bookingId) {
  return request(app).post(`/api/bookings/${bookingId}/cancel`).set('Cookie', cookie).send({});
}

async function seatsRemaining(listingId) {
  const { rows } = await query('SELECT seats_remaining FROM listings WHERE id = $1', [listingId]);
  return rows[0].seats_remaining;
}

function jobCtx(job) {
  return {
    jobId: job.id,
    type: job.type,
    attempt: 1,
    correlationId: job.correlation_id,
    idempotencyKey: job.dedupe_key,
    log: logger.child({ correlationId: job.correlation_id }),
  };
}

/**
 * Run the REAL outbox handler for the given rows, one at a time, in id order. Scoped by
 * construction: only rows this test selected are touched, so nothing here depends on — or
 * disturbs — another suite's queue state (PRIORITY 0 determinism rule).
 */
async function runJobs(rows) {
  const handlers = dispatch.loadHandlers({ log: logger });
  const results = [];
  for (const row of rows) {
    const handler = handlers.get(row.type);
    results.push(await handler.handle(row.payload, jobCtx(row)));
  }
  return results;
}

/** Outbox rows of `type` whose payload field `field` equals `id` — never a whole-table scan. */
async function jobsFor(type, field, id) {
  const { rows } = await query(
    `SELECT * FROM outbox_jobs WHERE type = $1 AND payload->>$2 = $3 ORDER BY id`,
    [type, field, id]
  );
  return rows;
}

/**
 * A future UTC instant at 20:00Z on the Nth day from `fromDays`. 20:00Z is 12:00/13:00 in
 * America/Los_Angeles, so the LA calendar day always equals the UTC calendar day — the LA
 * weekday equals the UTC weekday too, which is what the Monday-anchored week math below needs.
 */
function at20Z(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 20));
  return d;
}

/** The first Monday at 20:00Z at least `minDays` days in the future. */
function futureMonday(minDays) {
  const d = at20Z(new Date(Date.now() + minDays * 86400000));
  while (d.getUTCDay() !== 1) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

function plusDays(date, n) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function listingBody(scheduledStart, seatCapacity, extra = {}) {
  return {
    title: uniq('TCBv2 Supper'),
    description: 'Independent re-verification fixture listing.',
    ingredients: ['rice', 'beans'],
    allergens: [],
    cuisine: 'test',
    scheduledStart: scheduledStart.toISOString(),
    durationMinutes: 90,
    seatCapacity,
    addressLine1: '742 Evergreen Terrace',
    city: 'San Diego',
    region: 'CA',
    postalCode: '92101',
    country: 'US',
    ...extra,
  };
}

function createListing(cookie, body) {
  return request(app).post('/api/listings').set('Cookie', cookie).send(body);
}

// ==============================================================================================
// PRIORITY 1 — TCB-W3-01 (blocker): FR-10 must be closable with the value the DELIVERY
// PIPELINE actually carries, not with an in-process return value.
// ==============================================================================================

describe('TCB-W3-01 / FR-10 — the verification value the delivery pipeline carries verifies the account', () => {
  test('register -> outbox -> real handler -> real transport -> rendered email body -> verify-email 200', async () => {
    const email = `${uniq('tcbv2-fr10')}@tcbooking.homeplate.invalid`;
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email, password: PASSWORD, fullName: 'Reverify Probe', phone: '+16195550142' });
    expect(reg.status).toBe(201);

    const { rows: users } = await query('SELECT * FROM users WHERE email = $1', [email]);
    expect(users).toHaveLength(1);
    expect(users[0].email_verified).toBe(false);
    const userId = users[0].id;

    const jobs = await jobsFor('email.verification', 'userId', userId);
    expect(jobs).toHaveLength(1);
    // ADR-003: the row that crosses the transaction boundary carries IDs/digests only.
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['tokenHash', 'userId']);

    // Run the REAL handler through the REAL transport. The ADR-011 mock stands in for a
    // body-composing adapter (it declares requiresRenderContext exactly as
    // src/adapters/sendgrid.js does) so we can capture what the adapter is handed.
    const realDeliver = mockTransport.adapter.deliver;
    const received = [];
    mockTransport.adapter.requiresRenderContext = true;
    mockTransport.adapter.deliver = async (input) => {
      received.push(input);
      return realDeliver(input);
    };
    let result;
    try {
      result = (await runJobs(jobs))[0];
    } finally {
      mockTransport.adapter.deliver = realDeliver;
      delete mockTransport.adapter.requiresRenderContext;
    }
    expect(result.status).toBe('sent');
    expect(received).toHaveLength(1);

    // Compose the message a real recipient would receive, from what the adapter received.
    const { subject, text } = sendgrid.renderEmail(
      received[0].template,
      received[0].params,
      received[0].renderContext
    );
    // TCB-W3-04: not the neutral fallback subject.
    expect(subject).toBe('Verify your Homeplate email address');
    expect(subject).not.toMatch(/Homeplate notification \(/);

    // Extract the token from the RENDERED BODY TEXT — this is the strongest value a real
    // recipient can hold. No in-process return value is consulted anywhere in this test.
    const urlMatch = text.match(/https?:\/\/\S*[?&]token=([A-Za-z0-9._~+/=-]+)/);
    expect(urlMatch).not.toBeNull();
    const tokenFromEmail = urlMatch[1];
    expect(tokenFromEmail).not.toMatch(/^[0-9a-f]{64}$/); // not the SHA-256 digest

    const verify = await request(app)
      .post('/api/auth/verify-email')
      .send({ token: tokenFromEmail });
    expect(verify.status).toBe(200);

    const { rows: after } = await query('SELECT email_verified FROM users WHERE id = $1', [userId]);
    expect(after[0].email_verified).toBe(true);
  });

  test('the emailed token never appears in any persisted row (ADR-003 / §3.4)', async () => {
    const email = `${uniq('tcbv2-fr10b')}@tcbooking.homeplate.invalid`;
    const reg = await request(app)
      .post('/api/auth/register')
      .send({ email, password: PASSWORD, fullName: 'Reverify Probe', phone: '+16195550143' });
    expect(reg.status).toBe(201);
    const { rows: users } = await query('SELECT id FROM users WHERE email = $1', [email]);
    const userId = users[0].id;
    const jobs = await jobsFor('email.verification', 'userId', userId);

    const realDeliver = mockTransport.adapter.deliver;
    const received = [];
    mockTransport.adapter.requiresRenderContext = true;
    mockTransport.adapter.deliver = async (input) => {
      received.push(input);
      return realDeliver(input);
    };
    try {
      await runJobs(jobs);
    } finally {
      mockTransport.adapter.deliver = realDeliver;
      delete mockTransport.adapter.requiresRenderContext;
    }
    const url = received[0].renderContext.verificationUrl;
    const token = url.split('token=')[1];
    expect(token.length).toBeGreaterThan(20);

    const { rows: jobRows } = await query(
      `SELECT payload::text AS p FROM outbox_jobs WHERE payload->>'userId' = $1`,
      [userId]
    );
    for (const r of jobRows) expect(r.p).not.toContain(token);

    const { rows: attempts } = await query(
      `SELECT params::text AS p FROM notification_attempts WHERE recipient_user_id = $1`,
      [userId]
    );
    expect(attempts.length).toBeGreaterThan(0);
    for (const r of attempts) expect(r.p).not.toContain(token);

    const { rows: tokenRows } = await query(
      `SELECT * FROM email_verification_tokens WHERE user_id = $1`,
      [userId]
    );
    expect(JSON.stringify(tokenRows)).not.toContain(token);
  });

  test('verifying unlocks FR-09: canReserveSeat flips false -> true for the same account', async () => {
    // Restricted state: a registered but unverified account cannot reserve a seat.
    const email = `${uniq('tcbv2-fr10c')}@tcbooking.homeplate.invalid`;
    await request(app)
      .post('/api/auth/register')
      .send({ email, password: PASSWORD, fullName: 'Reverify Probe', phone: '+16195550144' });
    const { rows: users } = await query('SELECT * FROM users WHERE email = $1', [email]);
    const user = users[0];
    const cookie = await cookieFor(user);
    const listing = await approvedListing({ seat_capacity: 3, seats_remaining: 3 });

    const before = await book(cookie, listing.id);
    expect(before.status).toBe(403);
    expect(before.body.error.details.reasons).toContain('EMAIL_UNVERIFIED');
    expect(await seatsRemaining(listing.id)).toBe(3); // refusal consumed nothing

    // Permitted state: verify through the delivered link, then the same request succeeds.
    const jobs = await jobsFor('email.verification', 'userId', user.id);
    const realDeliver = mockTransport.adapter.deliver;
    const received = [];
    mockTransport.adapter.requiresRenderContext = true;
    mockTransport.adapter.deliver = async (input) => {
      received.push(input);
      return realDeliver(input);
    };
    try {
      await runJobs(jobs);
    } finally {
      mockTransport.adapter.deliver = realDeliver;
      delete mockTransport.adapter.requiresRenderContext;
    }
    const token = received[0].renderContext.verificationUrl.split('token=')[1];
    expect((await request(app).post('/api/auth/verify-email').send({ token })).status).toBe(200);

    const after = await book(cookie, listing.id);
    expect(after.status).toBe(201);
    expect(await seatsRemaining(listing.id)).toBe(2);
  });
});

// ==============================================================================================
// PRIORITY 1 — TCB-W3-02: moving scheduled_start EARLIER must reschedule the promote job.
// ==============================================================================================

describe('TCB-W3-02 — a listing moved EARLIER reschedules its bookings promote job', () => {
  test('PATCH scheduledStart earlier leaves a live booking.promote row at the NEW instant', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const start = plusDays(futureMonday(400), 0);
    const created = await createListing(hostCookie, listingBody(start, 4));
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;
    await query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [listingId]);

    const guest = await makeGuest();
    const res = await book(await cookieFor(guest), listingId);
    expect(res.status).toBe(201);
    const bookingId = res.body.booking.id;

    const earlier = plusDays(start, -30);
    const patched = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', hostCookie)
      .send({ scheduledStart: earlier.toISOString() });
    expect(patched.status).toBe(200);

    const promotes = await jobsFor('booking.promote', 'bookingId', bookingId);
    const live = promotes.filter((j) => j.status === 'pending');
    const atNewInstant = live.filter(
      (j) => new Date(j.available_at).getTime() === earlier.getTime()
    );
    expect(atNewInstant.length).toBeGreaterThanOrEqual(1);

    // And it actually promotes: force it due, run the real handler, expect in_progress.
    await query(`UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`, [
      listingId,
    ]);
    await runJobs([atNewInstant[0]]);
    const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    expect(rows[0].status).toBe('in_progress');
  });
});

// ==============================================================================================
// PRIORITY 1 — TCB-W3-03: the pending -> in_progress transition must enqueue notifications.
// ==============================================================================================

describe('TCB-W3-03 / FR-13 — the status transition itself notifies both participants', () => {
  test("promotion writes 'started' notify.booking rows for guest AND host, in one transaction", async () => {
    const host = await makeEligibleHost();
    const listing = await approvedListing({
      host_id: host.id,
      seat_capacity: 3,
      seats_remaining: 3,
    });
    const guest = await makeGuest();
    const res = await book(await cookieFor(guest), listing.id);
    expect(res.status).toBe(201);
    const bookingId = res.body.booking.id;

    const promotes = await jobsFor('booking.promote', 'bookingId', bookingId);
    expect(promotes).toHaveLength(1);
    await query(`UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`, [
      listing.id,
    ]);
    await runJobs(promotes);

    const { rows: booking } = await query('SELECT status, xmin FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    expect(booking[0].status).toBe('in_progress');

    const notify = await jobsFor('notify.booking', 'bookingId', bookingId);
    const events = [...new Set(notify.map((j) => j.payload.event))].sort();
    expect(events).toEqual(['created', 'started']);

    const startedRows = notify.filter((j) => j.payload.event === 'started');
    const recipients = startedRows.map((j) => j.payload.recipientUserId).sort();
    expect(recipients).toEqual([guest.id, host.id].sort());

    // ADR-001/003: the status change and its notification rows share ONE transaction.
    const { rows: xmins } = await query(
      `SELECT DISTINCT xmin::text AS x FROM outbox_jobs WHERE id = ANY($1::bigint[])`,
      [startedRows.map((r) => r.id)]
    );
    expect(xmins).toHaveLength(1);
    expect(xmins[0].x).toBe(String(booking[0].xmin));
  });
});

// ==============================================================================================
// PRIORITY 1 — TCB-W3-04: every emitted template id must resolve to a real subject.
// ==============================================================================================

describe('TCB-W3-04 / ADR-011 — no v1.0 email ships with the neutral fallback subject', () => {
  test('every template id this booking flow persists has a registered SendGrid subject', async () => {
    const host = await makeEligibleHost();
    const listing = await approvedListing({
      host_id: host.id,
      seat_capacity: 3,
      seats_remaining: 3,
    });
    const guest = await makeGuest();
    const guestCookie = await cookieFor(guest);
    const res = await book(guestCookie, listing.id);
    expect(res.status).toBe(201);
    const bookingId = res.body.booking.id;

    const cancelled = await cancel(guestCookie, bookingId);
    expect(cancelled.status).toBe(200);

    const notify = await jobsFor('notify.booking', 'bookingId', bookingId);
    expect(notify.length).toBeGreaterThanOrEqual(4);
    await runJobs(notify);

    const { rows } = await query(
      `SELECT DISTINCT template FROM notification_attempts
        WHERE params->>'bookingId' = $1`,
      [bookingId]
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(sendgrid.hasSubject(r.template)).toBe(true);
      expect(sendgrid.subjectFor(r.template)).not.toMatch(/^Homeplate notification \(/);
    }
  });

  test('every lifecycle event has a registered subject (a new event cannot regress silently)', () => {
    const { EVENT_VALUES } = require('../../src/modules/bookings/lifecycle');
    for (const event of EVENT_VALUES) {
      expect(sendgrid.hasSubject(`booking.${event}`)).toBe(true);
    }
    expect(sendgrid.hasSubject('email.verification')).toBe(true);
  });
});

// ==============================================================================================
// PRIORITY 1 — TCB-W3-06: FR-11 audit records must carry a YYYY-MM-DD MEHKO calendar day.
// ==============================================================================================

describe('TCB-W3-06 / AB-03 — listing audit records stamp an ISO calendar date', () => {
  test('listing.created / listing.updated / listing.cancelled localDate is YYYY-MM-DD', async () => {
    const listingsService = require('../../src/modules/listings/service');
    const host = await makeEligibleHost();
    const auth = { userId: host.id };

    // Capture the MT-01 audit records emitted by the service (audit() calls log.info).
    const records = [];
    const capture = {
      info: (fields) => records.push(fields),
      warn: () => {},
      error: () => {},
      debug: () => {},
      child: () => capture,
    };

    const start = futureMonday(500);
    const listing = await listingsService.createListing(auth, listingBody(start, 4), {
      log: capture,
    });
    await listingsService.updateListing(
      auth,
      listing.id,
      { title: 'TCBv2 Renamed Supper' },
      {
        log: capture,
      }
    );
    await listingsService.cancelListing(auth, listing.id, { log: capture });

    const audited = records.filter((r) => r.audit === true && r.localDate !== undefined);
    const events = audited.map((r) => r.event).sort();
    expect(events).toEqual(['listing.cancelled', 'listing.created', 'listing.updated']);
    for (const r of audited) {
      // The regression: String(pg DATE) used to yield 'Tue Sep 01 2026 00:00:00 GMT-0700 (…)'.
      expect(r.localDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(r.localDate).toBe(listing.localDate);
    }
  });
});

// ==============================================================================================
// FR-08 — moderation decision path (wave 4): asserted ABSENT, never reported as a pass.
// ==============================================================================================

describe('FR-08 — the moderation pipeline is wave-4 scope and is not implemented', () => {
  test('no moderation module, no moderation route, no moderation.scan handler', () => {
    const fs = require('fs');
    const path = require('path');
    const moduleDir = path.join(__dirname, '..', '..', 'src', 'modules', 'moderation');
    expect(fs.existsSync(moduleDir)).toBe(false);
    const types = dispatch.loadHandlers({ log: logger }).types();
    expect(types).not.toContain('moderation.scan');
  });

  test('FR-08-safe failure direction: an unapproved listing is invisible and unbookable', async () => {
    const pending = await makeListing({ moderation_status: 'pending' });
    const guest = await makeGuest();
    const cookie = await cookieFor(guest);
    expect(
      (await request(app).get(`/api/listings/${pending.id}`).set('Cookie', cookie)).status
    ).toBe(404);
    expect((await book(cookie, pending.id)).status).toBe(404);
    expect(await seatsRemaining(pending.id)).toBe(4);
  });
});

// ==============================================================================================
// FR-09 — eligibility is state-driven: BOTH the restricted and the permitted state.
// ==============================================================================================

describe('FR-09 — restricted and permitted states, over the real routes', () => {
  test('RESERVE_SEAT: each missing attribute is refused 403, the complete state is 201', async () => {
    const listing = await approvedListing({ seat_capacity: 5, seats_remaining: 5 });
    const cases = [
      [{ email_verified: false }, 'EMAIL_UNVERIFIED'],
      [{ full_name: null }, 'NAME_MISSING'],
      [{ phone_enc: null }, 'PHONE_MISSING'],
    ];
    for (const [overrides, reason] of cases) {
      const u = await makeGuest(overrides);
      const res = await book(await cookieFor(u), listing.id);
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('NOT_ELIGIBLE');
      expect(res.body.error.details.reasons).toContain(reason);
    }
    expect(await seatsRemaining(listing.id)).toBe(5); // no refusal touched capacity

    const eligible = await makeGuest();
    const ok = await book(await cookieFor(eligible), listing.id);
    expect(ok.status).toBe(201);
    expect(await seatsRemaining(listing.id)).toBe(4);
  });

  test('PUBLISH_LISTING: missing host profile / agreement is 403, the complete state is 201', async () => {
    const start = futureMonday(600);

    const noProfile = await makeUser({ can_publish_listing: true, phone_enc: 'enc:v1:tcbv2' });
    const denied = await createListing(await cookieFor(noProfile), listingBody(start, 4));
    expect(denied.status).toBe(403);
    expect(denied.body.error.details.reasons).toContain('HOST_PROFILE_INCOMPLETE');

    const noAgreement = await makeUser({ can_publish_listing: true, phone_enc: 'enc:v1:tcbv2' });
    await makeHostProfile({ user_id: noAgreement.id, host_agreement_accepted_at: null });
    const denied2 = await createListing(await cookieFor(noAgreement), listingBody(start, 4));
    expect(denied2.status).toBe(403);
    expect(denied2.body.error.details.reasons).toContain('HOST_AGREEMENT_MISSING');

    const host = await makeEligibleHost();
    const ok = await createListing(await cookieFor(host), listingBody(start, 4));
    expect(ok.status).toBe(201);
  });

  test('the eligibility policy is defined in exactly one module', () => {
    const { execSync } = require('child_process');
    const out = execSync(
      `grep -rln "function canReserveSeat\\|canReserveSeat = " "${__dirname}/../../src" || true`,
      { encoding: 'utf8' }
    ).trim();
    const files = out ? out.split('\n') : [];
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/src\/modules\/eligibility\/policy\.js$/);
  });
});

// ==============================================================================================
// FR-11 — MEHKO caps enforced SERVER-SIDE from configuration (ADR-009).
// ==============================================================================================

describe('FR-11 — one listing per host per day and the AB 626 meal caps', () => {
  test('caps come from src/config and are frozen, never inline literals', () => {
    expect(config.mehko).toEqual({
      listingsPerHostPerDay: 1,
      maxMealsPerDay: 30,
      maxMealsPerWeek: 90,
      timezone: 'America/Los_Angeles',
    });
    expect(Object.isFrozen(config.mehko)).toBe(true);
  });

  test('a second listing on the same LA calendar day is refused 409 MEHKO_DAILY_LISTING_LIMIT', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const day = futureMonday(700);
    const first = await createListing(cookie, listingBody(day, 4));
    expect(first.status).toBe(201);
    // A DIFFERENT instant on the SAME LA calendar day (20:00Z and 21:30Z are both LA midday).
    const sameDayLater = new Date(day.getTime() + 90 * 60000);
    const second = await createListing(cookie, listingBody(sameDayLater, 4));
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('MEHKO_DAILY_LISTING_LIMIT');

    const { rows } = await query(
      `SELECT count(*)::int AS c FROM listings WHERE host_id = $1 AND local_date = $2`,
      [host.id, first.body.listing.localDate]
    );
    expect(rows[0].c).toBe(1);
  });

  test('seatCapacity above the daily meal cap is refused 422 MEHKO_DAILY_MEAL_LIMIT', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const day = futureMonday(800);
    const over = await createListing(cookie, listingBody(day, config.mehko.maxMealsPerDay + 1));
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('MEHKO_DAILY_MEAL_LIMIT');

    const atCap = await createListing(cookie, listingBody(day, config.mehko.maxMealsPerDay));
    expect(atCap.status).toBe(201);
  });

  test('the weekly meal cap is enforced within one Monday-anchored LA week', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const monday = futureMonday(900);
    const perDay = config.mehko.maxMealsPerDay;
    // Derived, not hardcoded: the AB 1325 move from 60 to 90 meals/week silently invalidated
    // the previous fixed two-day form of this test.
    const daysToFill = Math.floor(config.mehko.maxMealsPerWeek / perDay);
    expect(daysToFill).toBeLessThan(7);
    for (let i = 0; i < daysToFill; i += 1) {
      expect((await createListing(cookie, listingBody(plusDays(monday, i), perDay))).status).toBe(
        201
      );
    }
    const over = await createListing(cookie, listingBody(plusDays(monday, daysToFill), 1));
    expect(over.status).toBe(422);
    expect(over.body.error.code).toBe('MEHKO_WEEKLY_MEAL_LIMIT');
  });

  test('TCB-W3-05 (ACCEPTED RESIDUAL RISK since ADR-009 was ratified 2026-08-18): the calendar week admits twice the weekly cap across its boundary', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const perDay = config.mehko.maxMealsPerDay;
    const weekly = config.mehko.maxMealsPerWeek;
    const daysToFill = Math.floor(weekly / perDay);
    const monday = futureMonday(1000);
    // Trailing `daysToFill` days of the PREVIOUS Monday-anchored week, then the leading
    // `daysToFill` of this one. Each listing is legal inside its own week; together they sit
    // in a single 7-day span.
    const first = plusDays(monday, -daysToFill);
    const last = plusDays(monday, daysToFill - 1);
    expect(2 * daysToFill).toBeLessThanOrEqual(7);
    for (let i = 0; i < 2 * daysToFill; i += 1) {
      expect((await createListing(cookie, listingBody(plusDays(first, i), perDay))).status).toBe(
        201
      );
    }

    const { rows } = await query(
      `SELECT coalesce(sum(seat_capacity), 0)::int AS total FROM listings
        WHERE host_id = $1 AND local_date BETWEEN $2 AND $3`,
      [host.id, first.toISOString().slice(0, 10), last.toISOString().slice(0, 10)]
    );
    // Ratified 2026-08-18: this is the ACCEPTED residual risk of a calendar-week basis, which
    // is how California MEHKO weekly limits are calculated. Pinned so it stays visible.
    expect(rows[0].total).toBe(2 * weekly);
  });

  test('there is exactly one server-side MEHKO enforcement point', () => {
    const { execSync } = require('child_process');
    // Files containing an actual CALL to the enforcement point (comments excluded).
    const out = execSync(`grep -rln "mehko\\.assertWithinCaps(" "${__dirname}/../../src" || true`, {
      encoding: 'utf8',
    }).trim();
    const files = out
      .split('\n')
      .map((f) => f.replace(/.*\/src\//, 'src/'))
      .sort();
    expect(files).toEqual(['src/modules/listings/service.js']);
    // …and exactly one definition site.
    const defs = execSync(
      `grep -rln "async function assertWithinCaps" "${__dirname}/../../src" || true`,
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .map((f) => f.replace(/.*\/src\//, 'src/'));
    expect(defs).toEqual(['src/modules/listings/mehko.js']);
    // No cap-shaped literal lives outside src/config (ADR-009 — caps are configuration).
    const literals = execSync(
      `grep -rln "maxMealsPerDay: 30\\|maxMealsPerWeek: 90\\|listingsPerHostPerDay: 1" "${__dirname}/../../src" || true`,
      { encoding: 'utf8' }
    )
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((f) => f.replace(/.*\/src\//, 'src/'));
    expect(literals.every((f) => f.startsWith('src/config/'))).toBe(true);
  });
});

// ==============================================================================================
// FR-12 — atomic reservation. Concurrency must never overbook; a refusal must never move seats.
// ==============================================================================================

describe('FR-12 — atomicity under concurrency', () => {
  test('seats_remaining=3, 40 concurrent distinct guests: exactly 3 succeed and seats reach 0', async () => {
    const listing = await approvedListing({ seat_capacity: 3, seats_remaining: 3 });
    const guests = await Promise.all(Array.from({ length: 40 }, () => makeGuest()));
    const cookies = await Promise.all(guests.map(cookieFor));

    const started = Date.now();
    const responses = await Promise.all(cookies.map((c) => book(c, listing.id)));
    const elapsedMs = Date.now() - started;

    // Full status distribution — a non-201/409 status is a real defect, not "just flaky".
    const byStatus = responses.reduce((acc, r) => {
      acc[r.status] = (acc[r.status] || 0) + 1;
      return acc;
    }, {});
    const unexpected = responses.filter((r) => r.status !== 201 && r.status !== 409);
    if (unexpected.length > 0) {
      // Surface the real cause instead of an opaque length mismatch.
      throw new Error(
        `FR-12: ${unexpected.length}/40 responses were neither 201 nor 409 after ${elapsedMs} ms. ` +
          `distribution=${JSON.stringify(byStatus)} first=${JSON.stringify(unexpected[0].body)}`
      );
    }

    expect(byStatus[201]).toBe(3);
    expect(byStatus[409]).toBe(37);
    for (const r of responses.filter((x) => x.status === 409)) {
      expect(r.body.error.code).toBe('NO_CAPACITY');
    }
    expect(await seatsRemaining(listing.id)).toBe(0);

    const { rows } = await query(
      `SELECT count(*)::int AS c FROM bookings WHERE listing_id = $1 AND status <> 'cancelled'`,
      [listing.id]
    );
    expect(rows[0].c).toBe(3);
  }, 30000);

  test('a rejected request leaves capacity UNCHANGED on every refusal path', async () => {
    const guest = await makeGuest();
    const cookie = await cookieFor(guest);

    const full = await approvedListing({ seat_capacity: 2, seats_remaining: 0 });
    expect((await book(cookie, full.id)).status).toBe(409);
    expect(await seatsRemaining(full.id)).toBe(0);

    const host = await makeGuest({ can_publish_listing: true });
    const own = await approvedListing({ host_id: host.id, seat_capacity: 2, seats_remaining: 2 });
    const ownRes = await book(await cookieFor(host), own.id);
    expect(ownRes.status).toBe(409);
    expect(ownRes.body.error.code).toBe('OWN_LISTING');
    expect(await seatsRemaining(own.id)).toBe(2);

    const started = await approvedListing({
      seat_capacity: 2,
      seats_remaining: 2,
      scheduled_start: new Date(Date.now() - 3600000),
    });
    const startedRes = await book(cookie, started.id);
    expect(startedRes.status).toBe(409);
    expect(startedRes.body.error.code).toBe('LISTING_STARTED');
    expect(await seatsRemaining(started.id)).toBe(2);

    const { rows } = await query(
      `SELECT count(*)::int AS c FROM bookings WHERE listing_id = ANY($1::uuid[])`,
      [[full.id, own.id, started.id]]
    );
    expect(rows[0].c).toBe(0);
  });

  test('AB-02 per-guest concurrent pending cap holds under simultaneous requests', async () => {
    const limit = config.booking.maxConcurrentPending;
    expect(typeof limit).toBe('number');
    const guest = await makeGuest();
    const cookie = await cookieFor(guest);
    const listings = await Promise.all(
      Array.from({ length: limit + 5 }, () =>
        approvedListing({ seat_capacity: 5, seats_remaining: 5 })
      )
    );
    const responses = await Promise.all(listings.map((l) => book(cookie, l.id)));
    const unexpected = responses.filter((r) => r.status !== 201 && r.status !== 409);
    expect(unexpected.map((r) => [r.status, r.body])).toEqual([]);
    expect(responses.filter((r) => r.status === 201)).toHaveLength(limit);
    const capped = responses.filter((r) => r.status === 409);
    expect(capped).toHaveLength(5);
    for (const r of capped) expect(r.body.error.code).toBe('BOOKING_LIMIT');

    const { rows } = await query(
      `SELECT count(*)::int AS c FROM bookings WHERE guest_id = $1 AND status = 'pending'`,
      [guest.id]
    );
    expect(rows[0].c).toBe(limit);
    // The five refusals consumed no capacity anywhere.
    const seats = await Promise.all(listings.map((l) => seatsRemaining(l.id)));
    expect(seats.filter((s) => s === 4)).toHaveLength(limit);
    expect(seats.filter((s) => s === 5)).toHaveLength(5);
  }, 30000);
});

// ==============================================================================================
// FR-13 — notifications are transactional and worker-delivered; an adapter failure must
// neither roll back nor delay the booking transaction (ADR-001/003).
// ==============================================================================================

describe('FR-13 — an adapter failure neither rolls back nor delays the booking transaction', () => {
  test('the request path never touches the transport, even with the adapter hard-down', async () => {
    const host = await makeEligibleHost();
    const listing = await approvedListing({
      host_id: host.id,
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const guest = await makeGuest();
    const cookie = await cookieFor(guest);

    // Every upcoming adapter call fails; a hung adapter would also block a caller that
    // awaited it inline (both injected together).
    mockTransport.injectFailures(20);
    mockTransport.injectHangs(1);

    const started = Date.now();
    const res = await book(cookie, listing.id);
    const elapsedMs = Date.now() - started;

    expect(res.status).toBe(201);
    // The adapter's per-attempt timeout is config.adapters.timeoutMs; if the request path
    // had called the transport inline, this would take at least that long.
    expect(elapsedMs).toBeLessThan(config.adapters.timeoutMs);
    // Nothing was delivered during the request.
    expect(mockTransport.deliveries()).toHaveLength(0);
    expect(await seatsRemaining(listing.id)).toBe(3);

    const bookingId = res.body.booking.id;
    const notify = await jobsFor('notify.booking', 'bookingId', bookingId);
    expect(notify).toHaveLength(2);
    expect(notify.map((j) => j.payload.recipientUserId).sort()).toEqual([guest.id, host.id].sort());
    // ADR-003: IDs only.
    for (const j of notify) {
      for (const value of Object.values(j.payload)) {
        expect(String(value)).not.toMatch(/@/);
      }
    }
    mockTransport.reset();
  });

  test('a booking row and its outbox rows commit in ONE transaction (ADR-001/003)', async () => {
    const host = await makeEligibleHost();
    const listing = await approvedListing({
      host_id: host.id,
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const guest = await makeGuest();
    const res = await book(await cookieFor(guest), listing.id);
    expect(res.status).toBe(201);
    const bookingId = res.body.booking.id;

    const { rows: b } = await query('SELECT xmin::text AS x FROM bookings WHERE id = $1', [
      bookingId,
    ]);
    const { rows: jobs } = await query(
      `SELECT DISTINCT xmin::text AS x FROM outbox_jobs WHERE payload->>'bookingId' = $1`,
      [bookingId]
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].x).toBe(b[0].x);
  });

  test('worker-side delivery failure is recorded and never mutates the booking', async () => {
    const host = await makeEligibleHost();
    const listing = await approvedListing({
      host_id: host.id,
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const guest = await makeGuest();
    const res = await book(await cookieFor(guest), listing.id);
    const bookingId = res.body.booking.id;
    const notify = await jobsFor('notify.booking', 'bookingId', bookingId);

    mockTransport.injectFailures(50);
    let threw = false;
    try {
      await runJobs([notify[0]]);
    } catch {
      threw = true; // handler throws so the OUTBOX retry budget takes over (NFR-09)
    }
    expect(threw).toBe(true);

    const { rows: attempts } = await query(
      `SELECT status FROM notification_attempts WHERE params->>'bookingId' = $1`,
      [bookingId]
    );
    expect(attempts.length).toBeGreaterThan(0);
    expect(attempts.every((a) => a.status === 'failed')).toBe(true);

    const { rows: after } = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    expect(after[0].status).toBe('pending');
    expect(await seatsRemaining(listing.id)).toBe(3);
    mockTransport.reset();
  }, 30000);

  test('every FR-13 status change notifies: created, started and completed', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const listing = await approvedListing({
      host_id: host.id,
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const guest = await makeGuest();
    const guestCookie = await cookieFor(guest);
    const res = await book(guestCookie, listing.id);
    const bookingId = res.body.booking.id;

    // pending -> in_progress
    await query(`UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`, [
      listing.id,
    ]);
    await runJobs(await jobsFor('booking.promote', 'bookingId', bookingId));

    // in_progress -> completed (dual confirmation, FR-04)
    const first = await request(app)
      .post(`/api/bookings/${bookingId}/confirm-completion`)
      .set('Cookie', guestCookie)
      .send({});
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/bookings/${bookingId}/confirm-completion`)
      .set('Cookie', hostCookie)
      .send({});
    expect(second.status).toBe(200);

    const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    expect(rows[0].status).toBe('completed');

    const notify = await jobsFor('notify.booking', 'bookingId', bookingId);
    const events = [...new Set(notify.map((j) => j.payload.event))].sort();
    expect(events).toEqual(['completed', 'created', 'started']);
    for (const event of events) {
      const recipients = notify
        .filter((j) => j.payload.event === event)
        .map((j) => j.payload.recipientUserId)
        .sort();
      expect(recipients).toEqual([guest.id, host.id].sort());
    }
  });

  test('no request-path module imports an adapter (ADR-001/003 static check)', () => {
    const { execSync } = require('child_process');
    const out = execSync(
      `grep -rn "require(.*adapters/" "${__dirname}/../../src/modules/bookings" "${__dirname}/../../src/modules/listings" || true`,
      { encoding: 'utf8' }
    ).trim();
    expect(out).toBe('');
  });
});

// ==============================================================================================
// FR-14 — cancellation before scheduled start restores capacity atomically.
// ==============================================================================================

describe('FR-14 — cancellation restores capacity atomically', () => {
  test('guest cancel restores exactly one seat and enqueues both notifications', async () => {
    const host = await makeEligibleHost();
    const listing = await approvedListing({
      host_id: host.id,
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const guest = await makeGuest();
    const cookie = await cookieFor(guest);
    const res = await book(cookie, listing.id);
    expect(await seatsRemaining(listing.id)).toBe(3);

    const cancelled = await cancel(cookie, res.body.booking.id);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.booking.status).toBe('cancelled');
    expect(await seatsRemaining(listing.id)).toBe(4);

    const notify = await jobsFor('notify.booking', 'bookingId', res.body.booking.id);
    const cancelEvents = notify.filter((j) => j.payload.event === 'cancelled_by_guest');
    expect(cancelEvents.map((j) => j.payload.recipientUserId).sort()).toEqual(
      [guest.id, host.id].sort()
    );
  });

  test('guest and host cancelling simultaneously restore exactly ONE seat', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const listing = await approvedListing({
      host_id: host.id,
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const guest = await makeGuest();
    const guestCookie = await cookieFor(guest);
    const res = await book(guestCookie, listing.id);
    const bookingId = res.body.booking.id;

    const results = await Promise.all([
      cancel(guestCookie, bookingId),
      cancel(hostCookie, bookingId),
      cancel(guestCookie, bookingId),
      cancel(hostCookie, bookingId),
    ]);
    for (const r of results) expect(r.status).toBe(200);
    expect(await seatsRemaining(listing.id)).toBe(4); // never 5

    const { rows } = await query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    expect(rows[0].status).toBe('cancelled');
  }, 30000);

  test('cancellation after scheduled start is refused and capacity is untouched', async () => {
    const host = await makeEligibleHost();
    const listing = await approvedListing({
      host_id: host.id,
      seat_capacity: 4,
      seats_remaining: 4,
    });
    const guest = await makeGuest();
    const cookie = await cookieFor(guest);
    const res = await book(cookie, listing.id);
    const bookingId = res.body.booking.id;

    await query(`UPDATE listings SET scheduled_start = now() - interval '1 minute' WHERE id = $1`, [
      listing.id,
    ]);
    const late = await cancel(cookie, bookingId);
    expect(late.status).toBe(409);
    expect(late.body.error.code).toBe('CANCEL_TOO_LATE');
    expect(await seatsRemaining(listing.id)).toBe(3);
  });

  test('a non-participant cannot cancel (403) and capacity is untouched', async () => {
    const listing = await approvedListing({ seat_capacity: 4, seats_remaining: 4 });
    const guest = await makeGuest();
    const res = await book(await cookieFor(guest), listing.id);
    const stranger = await makeGuest();
    const denied = await cancel(await cookieFor(stranger), res.body.booking.id);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('NOT_PARTICIPANT');
    expect(await seatsRemaining(listing.id)).toBe(3);
  });
});
