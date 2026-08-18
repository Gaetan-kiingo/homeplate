// tests/unit/listings.test.js — U3-LISTINGS acceptance suite (build-plan wave 3A).
//
// Requirement traceability (SRS Appendix B):
//   FR-11 (TC-11) — eligible-host create (201, pending, LA local_date); one MEHKO enforcement
//            point: second same-LA-day listing 409 MEHKO_DAILY_LISTING_LIMIT (also under
//            concurrency via the 0002 unique index, AND deterministically with the pre-check
//            bypassed so the 23505 → 409 backstop mapping itself is executed — COV-W3-03);
//            seatCapacity over the daily cap 422;
//            Monday-anchored LA weekly seat cap; the two-instants-one-UTC-day timezone pin;
//            cancel cascades to bookings with transactional notify.booking enqueues.
//   FR-02 (TC-02) — detail read: owner sees own pending listing (404 to others); approved
//            listing public shape is an exact key allowlist (no address/lat/lng); precise
//            location only for pending/in-progress guests and access-logged FR-07 moderators;
//            image URLs derived from media_objects storage keys.
//   FR-08  — moderation.scan enqueued in the creating transaction; material edit resets
//            moderation_status to 'pending' and re-enqueues; no LLM adapter call on any
//            request path (jobs simply sit pending — the wave-4 handler will consume them).
//   FR-09  — ineligible host 403 with reason codes; eligible host passes (route-level gate).
//   NFR-08 (MT-01) — every mutation writes one structured audit record with the request's
//            correlation ID; the same ID lands on the outbox rows; captured log output
//            carries no email-shaped string.
//   NFR-11 — hostile input arrives as 422 or inert data; unknown keys stripped.
//   NFR-13 / AB-08 — 401 unauthenticated; allowlist assertion over every public payload key.
//   AB-01 — pending listing invisible to non-owners.  AB-03 — 10-listings script yields
//            1×201 + 9×409.  AB-07 — single enforcement point, creations logged with host id
//            and local date.  ADR-009 — no cap literal outside src/config (scan).
//   ADR-001/003 — outbox rollback proves no dual write; a Maps outage never blocks creation.
//   ADR-004 — mediaUrls presigned URLs verified against the real MinIO store (PUT + GET
//            round-trip) with zero src/adapters imports in the module under test.
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');

const config = require('../../src/config');
const { createApp } = require('../../src/app');
const { createLogger } = require('../../src/lib/logger');
const { NotFoundError, ServiceUnavailableError } = require('../../src/lib/errors');
const { coarsen } = require('../../src/lib/geoPrecision');
const mediaUrls = require('../../src/lib/mediaUrls');
const outbox = require('../../src/outbox/outbox');
const sessions = require('../../src/modules/auth/sessions');
const mehko = require('../../src/modules/listings/mehko');
const serializers = require('../../src/modules/listings/serializers');
const listingsRepo = require('../../src/modules/listings/repo');
const geocodeHandler = require('../../src/outbox/handlers/listingGeocode');
const maps = require('../../src/adapters/maps');
const objectStorage = require('../../src/adapters/objectStorage');
const dbh = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');

const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const SRC = path.join(__dirname, '..', '..', 'src');

// ---- captured-log app (NFR-08 audit assertions run against real log output) ------------------
const logLines = [];
const sink = {
  write(line) {
    logLines.push(line);
  },
};
let app;

beforeAll(() => {
  app = createApp({ logger: createLogger({ level: 'info', stream: sink }) });
});

afterAll(async () => {
  try {
    // This suite owns exactly the rows on its own fixture domain, so it cleans up after
    // itself instead of relying on some other suite's domain-wide sweep (see FIXTURE_DOMAIN).
    // ON DELETE CASCADE carries the host_profiles, listings, bookings and media_objects rows
    // away with the users; the nullable references (safety_alerts.raised_by,
    // access_log.actor_user_id/subject_user_id) go to NULL, which is the NFR-12 anonymize
    // direction the schema already documents.
    await dbh.query(`DELETE FROM users WHERE email LIKE $1`, [`%@${FIXTURE_DOMAIN}`]);
  } finally {
    await dbh.closeDb();
    await closeTestRedis();
  }
});

function parsedAuditLines() {
  return logLines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && entry.audit === true);
}

// ---- fixtures --------------------------------------------------------------------------------

// SUITE-PRIVATE FIXTURE NAMESPACE (finding ADRC2-04).
//
// dbh.makeUser() defaults to the SHARED '@dbunit.homeplate.invalid' domain, and six other
// suites clean up with a blanket `DELETE FROM users WHERE email LIKE '%@dbunit.homeplate.invalid'`
// that is scoped to the domain, not to the rows those suites created. listings.host_id,
// bookings.guest_id, media_objects.owner_user_id and host_profiles.user_id are all
// `REFERENCES users(id) ON DELETE CASCADE`, so one of those statements running against this
// lane's database DELETES THIS SUITE'S LISTINGS. requireSession reads Redis only (ADR-006), so
// the host's cookie still authenticates afterwards and the next request 404s on a listing that
// existed a moment earlier — exactly the ADRC2-04 symptom: the FR-11 idempotent re-cancel
// answering 404 instead of 200, unreproducible in isolation.
//
// Reproduced deterministically by interleaving that blanket delete between the two cancels:
//   create -> 201 | cancel #1 -> 200 | DELETE ... LIKE '%@dbunit.homeplate.invalid' (37 users)
//   -> listing gone -> cancel #2 -> 404.  With the fixture domain below: 0 users deleted,
//   listing survives, cancel #2 -> 200.
// It is NOT a bug in cancelListing's idempotent branch: repo.findByIdForUpdate has no status
// predicate, so an already-cancelled row is found and returns 200 — a 404 there can only mean
// the row is gone.
//
// Within one Jest run suites are serial (jest.config.js maxWorkers: 1), so the cross-suite
// window is an afterAll of an ORPHANED run — the ones the coordinator's operational note warns
// survive an interrupted invocation and keep executing against the shared lane. Owning a
// private domain removes the coupling either way, and is what the other suites' cleanups
// should converge on (their files belong to other lanes).
const FIXTURE_DOMAIN = 'u3listings.homeplate.invalid';
let fixtureSeq = 0;

/**
 * dbh.makeUser() on this suite's OWN email domain. Every user this file creates goes through
 * here so no sibling suite's domain-wide cleanup can cascade our fixtures away mid-test.
 * @param {Record<string, unknown>} [overrides] forwarded to dbh.makeUser (email included: an
 *   explicit email still wins, but no call site needs one)
 */
async function makeUser(overrides = {}) {
  fixtureSeq += 1;
  return dbh.makeUser({
    email: `u3listings.${fixtureSeq}.${process.pid}.${Date.now()}@${FIXTURE_DOMAIN}`,
    ...overrides,
  });
}

async function cookieFor(user) {
  const { token } = await sessions.createSession({ id: user.id, roles: user.roles });
  return `${config.auth.sessionCookieName}=${token}`;
}

/** Fully canPublishListing-eligible host (NFR-06: email+name+phone+profile+agreement). */
async function makeEligibleHost() {
  const host = await makeUser({ can_publish_listing: true, phone_enc: 'enc:v1:fixture' });
  await dbh.makeHostProfile({ user_id: host.id });
  return host;
}

let daySeq = 0;
/** A unique future LA calendar day per call (avoids accidental FR-11 collisions). */
function uniqueFutureStart() {
  daySeq += 1;
  return new Date(Date.UTC(2028, 0, 5 + daySeq, 20, 0, 0)).toISOString(); // 12:00 PT
}

function listingBody(overrides = {}) {
  return {
    title: 'Pozole night',
    description: 'Slow-simmered pozole rojo with fresh garnishes.',
    ingredients: ['hominy', 'pork shoulder', 'guajillo chiles'],
    allergens: ['none'],
    cuisine: 'mexican',
    scheduledStart: uniqueFutureStart(),
    durationMinutes: 120,
    seatCapacity: 4,
    addressLine1: '4076 Test Kitchen Way',
    city: 'San Diego',
    region: 'CA',
    postalCode: '92103',
    ...overrides,
  };
}

async function createVia(cookie, overrides = {}) {
  return request(app).post('/api/listings').set('Cookie', cookie).send(listingBody(overrides));
}

async function approve(listingId) {
  await dbh.query(`UPDATE listings SET moderation_status = 'approved' WHERE id = $1`, [listingId]);
}

async function outboxJobs(type, ref) {
  const { rows } = await dbh.query(
    `SELECT * FROM outbox_jobs
     WHERE type = $1 AND (payload->>'listingId' = $2 OR payload->>'contentId' = $2
                          OR payload->>'bookingId' = $2)
     ORDER BY id`,
    [type, ref]
  );
  return rows;
}

// =============================================================================================
// ADR-009 — timezone boundaries and configuration-only caps
// =============================================================================================
describe('mehko — ADR-009 boundaries and caps', () => {
  test('23:30 PT and 00:30 PT next day are different LA days while sharing a UTC day', () => {
    const lateNight = new Date('2027-03-11T07:30:00Z'); // 23:30 PT on Mar 10 (PST)
    const justAfterMidnight = new Date('2027-03-11T08:30:00Z'); // 00:30 PT on Mar 11
    // Same UTC calendar day…
    expect(lateNight.toISOString().slice(0, 10)).toBe('2027-03-11');
    expect(justAfterMidnight.toISOString().slice(0, 10)).toBe('2027-03-11');
    // …but DIFFERENT America/Los_Angeles days (the ADR-009 boundary that matters).
    expect(mehko.localDateFor(lateNight)).toBe('2027-03-10');
    expect(mehko.localDateFor(justAfterMidnight)).toBe('2027-03-11');
  });

  test('weekRangeFor is Monday-anchored on the LA calendar', () => {
    // 2027-06-15 is a Tuesday (LA): its week runs Mon 06-14 .. Sun 06-20.
    const tue = mehko.weekRangeFor('2027-06-15T18:00:00-07:00');
    expect(tue).toEqual({ weekStart: '2027-06-14', weekEnd: '2027-06-20' });
    // Sunday 23:00 PT still belongs to that week; Monday 00:30 PT starts the next.
    expect(mehko.weekRangeFor('2027-06-21T06:00:00Z').weekStart).toBe('2027-06-14'); // Sun 23:00 PT
    expect(mehko.weekRangeFor('2027-06-21T07:30:00Z').weekStart).toBe('2027-06-21'); // Mon 00:30 PT
  });

  test('no MEHKO cap literal appears in any U3-LISTINGS source file (config-only, ADR-009)', () => {
    const owned = [
      ...fs
        .readdirSync(path.join(SRC, 'modules', 'listings'))
        .map((f) => path.join(SRC, 'modules', 'listings', f)),
      path.join(SRC, 'schemas', 'listings.js'),
      path.join(SRC, 'lib', 'mediaUrls.js'),
      path.join(SRC, 'outbox', 'handlers', 'listingGeocode.js'),
    ];
    for (const file of owned) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toMatch(/\b30\b/);
      expect(text).not.toMatch(/\b60\b/);
    }
    // The caps themselves come from config and are frozen (TC-11 pins the values).
    expect(Object.isFrozen(config.mehko)).toBe(true);
  });
});

// =============================================================================================
// FR-11 / TC-11 — create with MEHKO enforcement
// =============================================================================================
describe('POST /api/listings — FR-11 create', () => {
  test('eligible host creates a listing: 201, pending, LA local_date, transactional jobs', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    // 23:30 PT June 15 — the UTC calendar already says June 16 (ADR-009 pin through the API).
    const res = await createVia(cookie, { scheduledStart: '2027-06-16T06:30:00Z' });
    expect(res.status).toBe(201);
    const listing = res.body.listing;
    expect(listing.moderationStatus).toBe('pending'); // FR-08: pending until approved
    expect(listing.status).toBe('active');
    expect(listing.seatsRemaining).toBe(4);
    expect(listing.hostId).toBe(host.id);

    const { rows } = await dbh.query(
      `SELECT local_date::text AS local_date, seats_remaining, moderation_status
       FROM listings WHERE id = $1`,
      [listing.id]
    );
    expect(rows[0].local_date).toBe('2027-06-15'); // LA day, NOT the UTC day
    expect(rows[0].moderation_status).toBe('pending');

    // Same-transaction deferred work (ADR-001/003): both rows exist right after the 201.
    const geocodeJobs = await outboxJobs('listing.geocode', listing.id);
    const scanJobs = await outboxJobs('moderation.scan', listing.id);
    expect(geocodeJobs).toHaveLength(1);
    expect(geocodeJobs[0].payload).toEqual({ listingId: listing.id });
    expect(scanJobs).toHaveLength(1);
    expect(scanJobs[0].payload).toEqual({ contentType: 'listing', contentId: listing.id });
  });

  test('second listing on the same LA day (across the UTC boundary) is 409 MEHKO_DAILY_LISTING_LIMIT; next LA day works', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    // First: 23:30 PT June 20 (UTC June 21).
    expect((await createVia(cookie, { scheduledStart: '2027-06-21T06:30:00Z' })).status).toBe(201);
    // Second: 13:00 PT June 20 — a DIFFERENT UTC day than the first, same LA day → refused.
    const dup = await createVia(cookie, { scheduledStart: '2027-06-20T20:00:00Z' });
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('MEHKO_DAILY_LISTING_LIMIT');
    // Third: 00:30 PT June 21 — SAME UTC day as the first, next LA day → allowed.
    expect((await createVia(cookie, { scheduledStart: '2027-06-21T07:30:00Z' })).status).toBe(201);
  });

  test('concurrent duplicate creations cannot both commit (unique-index backstop → one 201, one 409)', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const scheduledStart = '2027-07-06T19:00:00-07:00';
    const [a, b] = await Promise.all([
      createVia(cookie, { scheduledStart, title: 'Race A dinner' }),
      createVia(cookie, { scheduledStart, title: 'Race B dinner' }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body.error.code).toBe('MEHKO_DAILY_LISTING_LIMIT');
    const { rows } = await dbh.query(
      `SELECT count(*)::int AS n FROM listings
       WHERE host_id = $1 AND status <> 'cancelled'`,
      [host.id]
    );
    expect(rows[0].n).toBe(1);
  });

  test('deterministic 23505 backstop: with the pre-check bypassed, the unique index alone maps to 409 MEHKO_DAILY_LISTING_LIMIT', async () => {
    // COV-W3-03: the Promise.all race above usually resolves through the in-transaction MEHKO
    // pre-check, so the isDailyLimitViolation → dailyLimitConflict mapping in
    // src/modules/listings/service.js (the true race-loser path) can go unexecuted. Force it
    // deterministically: bypass mehko.assertWithinCaps so BOTH creates reach INSERT and the
    // 0002 partial unique index (listings_host_local_date_key) itself must refuse the second.
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const spy = jest
      .spyOn(mehko, 'assertWithinCaps')
      .mockResolvedValue({ localDate: '2028-09-14' });
    let winner;
    let loser;
    try {
      winner = await createVia(cookie, { title: 'Backstop winner dinner' });
      loser = await createVia(cookie, { title: 'Backstop loser dinner' });
      expect(spy).toHaveBeenCalledTimes(2); // both requests really bypassed the pre-check
    } finally {
      spy.mockRestore();
    }
    expect(winner.status).toBe(201);
    expect(loser.status).toBe(409); // the mapped 23505 — a wrong constraint match would 500
    expect(loser.body.error.code).toBe('MEHKO_DAILY_LISTING_LIMIT');
    // NFR-13: no database internals leak through the mapped error.
    expect(JSON.stringify(loser.body)).not.toMatch(/23505|listings_host_local_date_key/);

    // The DB refused the duplicate (exactly one row committed) and the failure went through
    // the audited race-loser catch block — the pre-check path never writes a failure audit.
    const { rows } = await dbh.query(`SELECT count(*)::int AS n FROM listings WHERE host_id = $1`, [
      host.id,
    ]);
    expect(rows[0].n).toBe(1);
    const failureAudit = parsedAuditLines().find(
      (l) => l.event === 'listing.created' && l.outcome === 'failure' && l.actorUserId === host.id
    );
    expect(failureAudit).toMatchObject({ reason: 'MEHKO_DAILY_LISTING_LIMIT' });
  });

  test('AB-03: a script firing 10 same-day creations yields exactly 1 listing and 9×409', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const scheduledStart = '2027-07-13T19:00:00-07:00';
    const results = [];
    for (let i = 0; i < 10; i += 1) {
      results.push(await createVia(cookie, { scheduledStart, title: `Spam attempt ${i} listing` }));
    }
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
    const { rows } = await dbh.query(
      `SELECT count(*)::int AS n FROM listings WHERE host_id = $1 AND status <> 'cancelled'`,
      [host.id]
    );
    expect(rows[0].n).toBe(1);
  });

  test('seatCapacity above the configured daily meal cap is 422 MEHKO_DAILY_MEAL_LIMIT', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const res = await createVia(cookie, { seatCapacity: config.mehko.maxMealsPerDay + 1 });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('MEHKO_DAILY_MEAL_LIMIT');
  });

  test('weekly seat cap is enforced over the Monday-anchored LA week; next week is fresh', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const daily = config.mehko.maxMealsPerDay;
    const weekly = config.mehko.maxMealsPerWeek;
    // Tue + Wed of the 2027-06-14 LA week fill the whole weekly budget…
    const tue = await createVia(cookie, {
      scheduledStart: '2027-06-15T18:00:00-07:00',
      seatCapacity: daily,
    });
    const wed = await createVia(cookie, {
      scheduledStart: '2027-06-16T18:00:00-07:00',
      seatCapacity: weekly - daily,
    });
    expect(tue.status).toBe(201);
    expect(wed.status).toBe(201);
    // …so even ONE more seat on Thursday exceeds it.
    const thu = await createVia(cookie, {
      scheduledStart: '2027-06-17T18:00:00-07:00',
      seatCapacity: 1,
    });
    expect(thu.status).toBe(422);
    expect(thu.body.error.code).toBe('MEHKO_WEEKLY_MEAL_LIMIT');
    // Monday of the NEXT LA week starts a fresh window (anchored, not rolling).
    const nextMon = await createVia(cookie, {
      scheduledStart: '2027-06-21T18:00:00-07:00',
      seatCapacity: daily,
    });
    expect(nextMon.status).toBe(201);
  });

  test('FR-09: ineligible host is 403 with reason codes; eligibility fixes make the identical request succeed', async () => {
    const host = await makeUser({ phone_enc: 'enc:v1:fixture' }); // no host profile yet
    const cookie = await cookieFor(host);
    const body = listingBody();
    const denied = await request(app).post('/api/listings').set('Cookie', cookie).send(body);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('NOT_ELIGIBLE');
    expect(denied.body.error.details.reasons).toEqual(
      expect.arrayContaining(['HOST_PROFILE_INCOMPLETE', 'HOST_AGREEMENT_MISSING'])
    );
    await dbh.makeHostProfile({ user_id: host.id });
    const allowed = await request(app).post('/api/listings').set('Cookie', cookie).send(body);
    expect(allowed.status).toBe(201);
  });

  test('AB-08: unauthenticated create is 401; NFR-11: malformed body is a field-level 422', async () => {
    expect((await request(app).post('/api/listings').send(listingBody())).status).toBe(401);

    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const res = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send({ title: 'x', seatCapacity: 'many' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    expect(JSON.stringify(res.body)).not.toMatch(/at\s+\S+\s+\(/); // no stack trace
  });

  test('ADR-001/003: an outbox enqueue failure rolls back the listing row too (no dual write)', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const spy = jest
      .spyOn(outbox, 'enqueue')
      .mockRejectedValue(new Error('listings-test: injected enqueue failure'));
    try {
      const res = await createVia(cookie);
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      spy.mockRestore();
    }
    const { rows } = await dbh.query(`SELECT id FROM listings WHERE host_id = $1`, [host.id]);
    expect(rows).toEqual([]);
  });
});

// =============================================================================================
// FR-02 / TC-02 — detail read with ADR-010 progressive disclosure
// =============================================================================================
describe('GET /api/listings/:id — FR-02 detail, ADR-010 disclosure', () => {
  async function approvedListingFixture() {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const created = await createVia(hostCookie);
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;
    // Worker-side geocode fills precise + coarse location (mock Maps adapter).
    await geocodeHandler.handle({ listingId }, {});
    await approve(listingId);
    // Attach one image by storage key (ADR-004).
    const storageKey = `listing/${host.id}/detail-${Date.now()}.jpg`;
    await dbh.insertRow('media_objects', {
      owner_user_id: host.id,
      entity_type: 'listing',
      entity_id: listingId,
      storage_key: storageKey,
      content_type: 'image/jpeg',
    });
    return { host, hostCookie, listingId, storageKey };
  }

  test('pending listing: owner sees it with status + address; everyone else gets 404 (AB-01)', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const created = await createVia(hostCookie);
    const listingId = created.body.listing.id;

    const ownerView = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', hostCookie);
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.listing.moderationStatus).toBe('pending');
    expect(ownerView.body.listing.addressLine1).toBe('4076 Test Kitchen Way');

    const stranger = await makeUser();
    const strangerView = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', await cookieFor(stranger));
    expect(strangerView.status).toBe(404);

    // Rejected content is equally invisible (FR-08).
    await dbh.query(`UPDATE listings SET moderation_status = 'rejected' WHERE id = $1`, [
      listingId,
    ]);
    const rejectedView = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', await cookieFor(stranger));
    expect(rejectedView.status).toBe(404);
    // …while the owner still sees it, with its status (TC-02).
    const ownerRejected = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', hostCookie);
    expect(ownerRejected.status).toBe(200);
    expect(ownerRejected.body.listing.moderationStatus).toBe('rejected');
  });

  test('approved listing: public payload is the EXACT key allowlist — coarse location only (AB-08)', async () => {
    const { listingId, storageKey } = await approvedListingFixture();
    const viewer = await makeUser();
    const res = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', await cookieFor(viewer));
    expect(res.status).toBe(200);
    const listing = res.body.listing;

    // Key-allowlist assertion: exactly the public shape plus the FR-02 detail context
    // ({host, reviews} — attached on GET /api/listings/:id ONLY), nothing more.
    expect(Object.keys(listing).sort()).toEqual(
      [...serializers.PUBLIC_KEYS, ...serializers.DETAIL_CONTEXT_KEYS].sort()
    );
    for (const forbidden of serializers.PRIVILEGED_ONLY_KEYS) {
      expect(listing).not.toHaveProperty(forbidden);
    }
    // FR-02: the host summary is itself an exact allowlist; reviews are the approved page.
    expect(Object.keys(listing.host).sort()).toEqual([...serializers.HOST_SUMMARY_KEYS].sort());
    expect(Array.isArray(listing.reviews)).toBe(true);
    expect(JSON.stringify(listing)).not.toMatch(/Test Kitchen Way|92103/);
    expect(JSON.stringify(listing)).not.toMatch(EMAIL_SHAPE); // no host contact data

    // Coarse public precision present and genuinely coarse (grid-snapped → idempotent).
    expect(typeof listing.coarseLat).toBe('number');
    expect(typeof listing.coarseLng).toBe('number');
    const again = coarsen(listing.coarseLat, listing.coarseLng);
    expect(again.lat).toBe(listing.coarseLat);
    expect(again.lng).toBe(listing.coarseLng);
    expect(typeof listing.areaLabel).toBe('string');

    // FR-02 detail fields + image URL derived from the storage key (ADR-004).
    expect(listing.ingredients).toEqual(['hominy', 'pork shoulder', 'guajillo chiles']);
    expect(listing.allergens).toEqual(['none']);
    expect(listing.seatCapacity).toBe(4);
    expect(listing.images).toHaveLength(1);
    expect(listing.images[0].url).toContain(storageKey);
    expect(listing.images[0].url).toContain(config.objectStorage.bucket);

    // AB-08: no session → 401, never data.
    expect((await request(app).get(`/api/listings/${listingId}`)).status).toBe(401);
  });

  test('ADR-010: pending/in-progress guest sees the exact address; cancelled guest reverts to public', async () => {
    const { host, listingId } = await approvedListingFixture();
    const guest = await makeUser();
    await dbh.makeBooking({ listing_id: listingId, guest_id: guest.id, status: 'pending' });
    const guestView = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', await cookieFor(guest));
    expect(guestView.status).toBe(200);
    expect(guestView.body.listing.addressLine1).toBe('4076 Test Kitchen Way');
    expect(typeof guestView.body.listing.lat).toBe('number'); // precise, from the geocode job
    expect(guestView.body.listing.hostId).toBe(host.id);

    const pastGuest = await makeUser();
    await dbh.makeBooking({
      listing_id: listingId,
      guest_id: pastGuest.id,
      status: 'cancelled',
      cancelled_at: new Date(),
    });
    const pastView = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', await cookieFor(pastGuest));
    expect(pastView.status).toBe(200);
    expect(pastView.body.listing).not.toHaveProperty('addressLine1');
    expect(pastView.body.listing).not.toHaveProperty('lat');
  });

  test('ADR-010: moderator sees the address ONLY with an FR-07 alert on the listing — and the read is access-logged', async () => {
    const { host, listingId } = await approvedListingFixture();
    const moderator = await makeUser({ roles: ['user', 'moderator'] });
    const moderatorCookie = await cookieFor(moderator);

    // No safety alert yet → public projection, no access_log row.
    const before = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', moderatorCookie);
    expect(before.status).toBe(200);
    expect(before.body.listing).not.toHaveProperty('addressLine1');

    // FR-07 alert on one of the listing's bookings opens the disclosure window.
    const guest = await makeUser();
    const booking = await dbh.makeBooking({
      listing_id: listingId,
      guest_id: guest.id,
      status: 'in_progress',
    });
    await dbh.insertRow('safety_alerts', { booking_id: booking.id, raised_by: guest.id });

    const after = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', moderatorCookie);
    expect(after.status).toBe(200);
    expect(after.body.listing.addressLine1).toBe('4076 Test Kitchen Way');

    const { rows } = await dbh.query(
      `SELECT actor_user_id, subject_user_id, purpose, resource FROM access_log
       WHERE actor_user_id = $1 AND resource = $2`,
      [moderator.id, `listing:${listingId}`]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_user_id: moderator.id,
      subject_user_id: host.id,
      purpose: 'fr07_safety_alert',
    });
  });

  test('the :id route is UUID-constrained: /api/listings/search falls through (404 until U3-SEARCH mounts)', async () => {
    const viewer = await makeUser();
    const res = await request(app)
      .get('/api/listings/search')
      .set('Cookie', await cookieFor(viewer));
    // 'search' is not a UUID → never this router's GET /:id, so it can never be answered as
    // a listing. Until U3-SEARCH mounts it is the registry's structured 404; once mounted it
    // is whatever the search router answers — never a listing envelope, never a 500.
    expect(res.status).not.toBe(500);
    expect(res.body && res.body.listing).toBeUndefined();
    if (res.status === 404) expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

// =============================================================================================
// FR-11 — update (owner-only, moderation reset, MEHKO on the update path)
// =============================================================================================
describe('PATCH /api/listings/:id — FR-11 update', () => {
  test('owner-only: another authenticated user gets 403; owner update succeeds', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const listingId = (await createVia(hostCookie)).body.listing.id;

    const stranger = await makeUser();
    const denied = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', await cookieFor(stranger))
      .send({ title: 'Hijacked listing title' });
    expect(denied.status).toBe(403);

    const ok = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', hostCookie)
      .send({ durationMinutes: 90 });
    expect(ok.status).toBe(200);
    expect(ok.body.listing.durationMinutes).toBe(90);
  });

  test('FR-08: a material edit resets an approved listing to pending and re-enqueues moderation.scan', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const listingId = (await createVia(hostCookie)).body.listing.id;
    await approve(listingId);

    const res = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', hostCookie)
      .send({ description: 'Now with a completely different menu.' });
    expect(res.status).toBe(200);
    expect(res.body.listing.moderationStatus).toBe('pending'); // unreviewed again

    const scans = await outboxJobs('moderation.scan', listingId);
    expect(scans).toHaveLength(2); // create + material update, each transactional

    // A NON-material change must not reset moderation.
    await approve(listingId);
    const seatRes = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', hostCookie)
      .send({ seatCapacity: 6 });
    expect(seatRes.status).toBe(200);
    expect(seatRes.body.listing.moderationStatus).toBe('approved');
    expect(seatRes.body.listing.seatsRemaining).toBe(6);
  });

  test('MEHKO on the update path: moving onto an occupied LA day is 409; over-cap seats are 422', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const first = await createVia(hostCookie, { scheduledStart: '2027-08-10T19:00:00-07:00' });
    const second = await createVia(hostCookie, { scheduledStart: '2027-08-24T19:00:00-07:00' });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const clash = await request(app)
      .patch(`/api/listings/${second.body.listing.id}`)
      .set('Cookie', hostCookie)
      .send({ scheduledStart: '2027-08-11T06:30:00Z' }); // 23:30 PT Aug 10 — first's LA day
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('MEHKO_DAILY_LISTING_LIMIT');

    const overCap = await request(app)
      .patch(`/api/listings/${second.body.listing.id}`)
      .set('Cookie', hostCookie)
      .send({ seatCapacity: config.mehko.maxMealsPerDay + 1 });
    expect(overCap.status).toBe(422);
    expect(overCap.body.error.code).toBe('MEHKO_DAILY_MEAL_LIMIT');

    // An unchanged re-submit of its own values passes (excludeListingId — no self-conflict).
    const selfOk = await request(app)
      .patch(`/api/listings/${second.body.listing.id}`)
      .set('Cookie', hostCookie)
      .send({ scheduledStart: '2027-08-24T19:00:00-07:00' });
    expect(selfOk.status).toBe(200);
  });

  test('an address change clears the stored geocode and enqueues a fresh listing.geocode job', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const listingId = (await createVia(hostCookie)).body.listing.id;
    await geocodeHandler.handle({ listingId }, {});
    const geocoded = await listingsRepo.findById(listingId);
    expect(geocoded.lat).not.toBeNull();

    const res = await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', hostCookie)
      .send({ addressLine1: '900 Relocated Kitchen Court' });
    expect(res.status).toBe(200);

    const moved = await listingsRepo.findById(listingId);
    expect(moved.lat).toBeNull(); // stale precise location must not survive (ADR-010)
    expect(moved.coarse_lat).toBeNull();
    expect(moved.area_label).toBeNull();
    expect(await outboxJobs('listing.geocode', listingId)).toHaveLength(2); // create + move
  });
});

// =============================================================================================
// FR-11 cancel — cascade to bookings + transactional notify.booking enqueues (FR-13)
// =============================================================================================
describe('POST /api/listings/:id/cancel — FR-11 cancel', () => {
  test('owner cancel cascades to active bookings and writes one notify.booking row per guest, same transaction', async () => {
    const host = await makeEligibleHost();
    const hostCookie = await cookieFor(host);
    const created = await createVia(hostCookie, { seatCapacity: 5 });
    const listingId = created.body.listing.id;
    await approve(listingId);

    const guestA = await makeUser();
    const guestB = await makeUser();
    const bookingA = await dbh.makeBooking({
      listing_id: listingId,
      guest_id: guestA.id,
      status: 'pending',
    });
    const bookingB = await dbh.makeBooking({
      listing_id: listingId,
      guest_id: guestB.id,
      status: 'in_progress',
    });
    const doneGuest = await makeUser();
    await dbh.makeBooking({
      listing_id: listingId,
      guest_id: doneGuest.id,
      status: 'completed',
      host_confirmed_completion: true,
      guest_confirmed_completion: true,
    });

    const stranger = await makeUser();
    const denied = await request(app)
      .post(`/api/listings/${listingId}/cancel`)
      .set('Cookie', await cookieFor(stranger));
    expect(denied.status).toBe(403);

    const res = await request(app)
      .post(`/api/listings/${listingId}/cancel`)
      .set('Cookie', hostCookie);
    expect(res.status).toBe(200);
    expect(res.body.cancelledBookings).toBe(2); // completed booking untouched
    expect(res.body.listing.status).toBe('cancelled');

    const { rows: bookings } = await dbh.query(
      `SELECT id, status, cancelled_at FROM bookings WHERE listing_id = $1 ORDER BY created_at`,
      [listingId]
    );
    const byId = Object.fromEntries(bookings.map((b) => [b.id, b]));
    expect(byId[bookingA.id].status).toBe('cancelled');
    expect(byId[bookingA.id].cancelled_at).not.toBeNull();
    expect(byId[bookingB.id].status).toBe('cancelled');

    // FR-13: one notify.booking job per affected guest, committed with the cancel; the
    // payloads carry IDs only (ADR-003 — enqueue would have rejected anything else).
    for (const [bookingId, guest] of [
      [bookingA.id, guestA],
      [bookingB.id, guestB],
    ]) {
      const jobs = await outboxJobs('notify.booking', bookingId);
      expect(jobs).toHaveLength(1);
      expect(jobs[0].payload).toEqual({
        bookingId,
        event: 'listing_cancelled',
        recipientUserId: guest.id,
      });
      expect(JSON.stringify(jobs[0].payload)).not.toMatch(EMAIL_SHAPE);
    }

    // Idempotent repeat: 200, nothing new enqueued.
    const again = await request(app)
      .post(`/api/listings/${listingId}/cancel`)
      .set('Cookie', hostCookie);
    expect(again.status).toBe(200);
    expect(await outboxJobs('notify.booking', bookingA.id)).toHaveLength(1);

    // FR-11 re-create path: the cancelled listing frees its LA day.
    const recreate = await createVia(hostCookie, {
      scheduledStart: created.body.listing.scheduledStart,
    });
    expect(recreate.status).toBe(201);
  });
});

// =============================================================================================
// listing.geocode worker handler (ADR-001/003, ADR-005, ADR-010, NFR-09)
// =============================================================================================
describe('outbox handler listing.geocode', () => {
  test('fills precise lat/lng + coarse public projection from the Maps adapter (worker-side only)', async () => {
    const host = await makeEligibleHost();
    const created = await createVia(await cookieFor(host));
    const listingId = created.body.listing.id;

    const result = await geocodeHandler.handle({ listingId }, {});
    expect(result).toEqual({ status: 'geocoded', listingId });

    const row = await listingsRepo.findById(listingId);
    expect(typeof row.lat).toBe('number');
    expect(typeof row.lng).toBe('number');
    // The coarse pair is genuinely public precision: coarsening is idempotent on it, and it
    // is NOT the precise pair (ADR-010).
    const snapped = coarsen(row.coarse_lat, row.coarse_lng);
    expect(snapped.lat).toBe(row.coarse_lat);
    expect(snapped.lng).toBe(row.coarse_lng);
    expect(typeof row.area_label).toBe('string');

    // Idempotent under redelivery (RT-02): running again rewrites the same values.
    await expect(geocodeHandler.handle({ listingId }, {})).resolves.toMatchObject({
      status: 'geocoded',
    });
  });

  test('a Maps outage throws (worker retries) but the listing itself was never blocked (NFR-09)', async () => {
    const host = await makeEligibleHost();
    const created = await createVia(await cookieFor(host));
    expect(created.status).toBe(201); // creation already committed — outage cannot undo it
    const listingId = created.body.listing.id;

    const spy = jest
      .spyOn(maps, 'geocode')
      .mockRejectedValue(new ServiceUnavailableError('maps down', { code: 'MAPS_UNAVAILABLE' }));
    try {
      await expect(geocodeHandler.handle({ listingId }, {})).rejects.toMatchObject({
        code: 'MAPS_UNAVAILABLE',
      });
    } finally {
      spy.mockRestore();
    }
    const row = await listingsRepo.findById(listingId);
    expect(row).not.toBeNull(); // still there, still pending, geocode simply deferred
    expect(row.lat).toBeNull();
  });

  test('definitive no-results completes without retry; missing listing is skipped; bad payload throws', async () => {
    const host = await makeEligibleHost();
    const created = await createVia(await cookieFor(host));
    const listingId = created.body.listing.id;

    const spy = jest
      .spyOn(maps, 'geocode')
      .mockRejectedValue(new NotFoundError('nowhere', { code: 'MAPS_NO_RESULTS' }));
    try {
      await expect(geocodeHandler.handle({ listingId }, {})).resolves.toEqual({
        status: 'no_results',
        listingId,
      });
    } finally {
      spy.mockRestore();
    }

    await expect(
      geocodeHandler.handle({ listingId: '00000000-0000-4000-8000-000000000000' }, {})
    ).resolves.toMatchObject({ status: 'skipped' });
    await expect(geocodeHandler.handle({ listingId: 'not-a-uuid' }, {})).rejects.toThrow(TypeError);
  });
});

// =============================================================================================
// src/lib/mediaUrls — pure local URL derivation (ADR-004, build-plan §6.3)
// =============================================================================================
describe('mediaUrls — presigned URLs by pure local computation', () => {
  test('imports nothing from src/adapters and mirrors the canonical key rule', () => {
    const text = fs.readFileSync(path.join(SRC, 'lib', 'mediaUrls.js'), 'utf8');
    expect(text).not.toMatch(/require\(['"][^'"]*adapters\//);
    expect(mediaUrls.KEY_PATTERN.source).toBe(objectStorage.KEY_PATTERN.source);
  });

  test('urlForKey derives a signed GET URL from config alone; invalid keys are refused', () => {
    const url = mediaUrls.urlForKey('listing/00000000-0000-4000-8000-000000000000/a.jpg');
    expect(url).toContain(config.objectStorage.bucket);
    expect(url).toContain('listing/00000000-0000-4000-8000-000000000000/a.jpg');
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Credential=');
    expect(() => mediaUrls.urlForKey('../etc/passwd')).toThrow(
      expect.objectContaining({ code: 'INVALID_STORAGE_KEY' })
    );
  });

  test('createUploadTarget namespaces the key under the caller and validates kind/MIME/size', () => {
    const userId = '11111111-2222-4333-8444-555555555555';
    const target = mediaUrls.createUploadTarget(userId, 'listing', 'image/jpeg', {
      sizeBytes: 1024,
    });
    expect(target.storageKey.startsWith(`listing/${userId}/`)).toBe(true);
    expect(target.storageKey.endsWith('.jpg')).toBe(true);
    expect(target.uploadUrl).toContain(target.storageKey);
    expect(target.uploadUrl).toContain('X-Amz-Signature=');
    expect(target.headers).toEqual({ 'Content-Type': 'image/jpeg' });
    expect(new Date(target.expiresAt).getTime()).toBeGreaterThan(Date.now());

    expect(() => mediaUrls.createUploadTarget(userId, 'avatar', 'image/jpeg')).toThrow(
      expect.objectContaining({ status: 422 })
    );
    expect(() => mediaUrls.createUploadTarget(userId, 'listing', 'application/x-sh')).toThrow(
      expect.objectContaining({ code: 'UNSUPPORTED_MEDIA_TYPE' })
    );
    expect(() =>
      mediaUrls.createUploadTarget(userId, 'listing', 'image/png', {
        sizeBytes: config.media.maxUploadBytes + 1,
      })
    ).toThrow(expect.objectContaining({ code: 'MEDIA_TOO_LARGE' }));
    expect(() => mediaUrls.createUploadTarget('not-a-uuid', 'listing', 'image/png')).toThrow(
      expect.objectContaining({ status: 422 })
    );
  });

  test('the SigV4 math is real: PUT to the presigned upload URL, GET via urlForKey (MinIO round-trip)', async () => {
    const userId = '99999999-1111-4222-8333-444444444444';
    const target = mediaUrls.createUploadTarget(userId, 'listing', 'image/png');
    const body = Buffer.from(`mediaUrls-roundtrip-${Date.now()}`);

    const put = await fetch(target.uploadUrl, {
      method: 'PUT',
      headers: target.headers,
      body,
    });
    expect(put.status).toBe(200); // MinIO accepted the locally computed signature

    const get = await fetch(mediaUrls.urlForKey(target.storageKey));
    expect(get.status).toBe(200);
    expect(Buffer.from(await get.arrayBuffer()).equals(body)).toBe(true);

    // Cleanup through the adapter (test context, not request path).
    await objectStorage.deleteByKey(target.storageKey);
  });
});

// =============================================================================================
// NFR-08 / MT-01 — audit records with correlation IDs; PII-free log output
// =============================================================================================
describe('NFR-08 — audit logging and correlation propagation', () => {
  test('create/update/cancel each write one audit record carrying the request correlation ID', async () => {
    const host = await makeEligibleHost();
    const cookie = await cookieFor(host);
    const correlationId = `listings-audit-${Date.now()}`;

    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .set('X-Correlation-Id', correlationId)
      .send(listingBody());
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;

    await request(app)
      .patch(`/api/listings/${listingId}`)
      .set('Cookie', cookie)
      .set('X-Correlation-Id', correlationId)
      .send({ title: 'Renamed pozole night' });
    await request(app)
      .post(`/api/listings/${listingId}/cancel`)
      .set('Cookie', cookie)
      .set('X-Correlation-Id', correlationId);

    const audits = parsedAuditLines().filter((l) => l.correlationId === correlationId);
    const events = audits.map((l) => l.event);
    expect(events).toEqual(
      expect.arrayContaining(['listing.created', 'listing.updated', 'listing.cancelled'])
    );
    const createdAudit = audits.find((l) => l.event === 'listing.created');
    // AB-07: creations carry host id + local date for duplicate-account review.
    expect(createdAudit).toMatchObject({
      actorUserId: host.id,
      entityType: 'listing',
      entityId: listingId,
      outcome: 'success',
    });
    expect(createdAudit.localDate).toBeDefined();

    // The SAME correlation ID was stamped onto the outbox rows (worker side of MT-01).
    const { rows } = await dbh.query(
      `SELECT correlation_id FROM outbox_jobs WHERE payload->>'listingId' = $1`,
      [listingId]
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.correlation_id).toBe(correlationId);
  });

  test('captured log output contains no email-shaped string and no street address (SRS §3.4)', () => {
    const joined = logLines.join('\n');
    expect(joined).not.toMatch(EMAIL_SHAPE);
    expect(joined).not.toMatch(/Test Kitchen Way|Relocated Kitchen Court/);
  });
});
