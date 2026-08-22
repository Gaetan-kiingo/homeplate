// tests/tc-booking/tc08-moderation-substrate.test.js — VERIFIER lane "tc-booking", TC-08
// (FR-08, ADR-002/007) — THE REAL PIPELINE ACCEPTANCE. Until U4-MODERATION landed, this file
// verified the wave-2 substrate and documented the flow's absence; the flow exists now, so
// the substrate checks remain and the absence probes became the end-to-end acceptance:
//
//   - deterministic pre-filter: a blocklist hit rejects with decided_by='pre_filter' and
//     ZERO LLM calls; the content never publishes;
//   - LLM stage through the ADR-007 adapter (deterministic mock in the suite): benign at
//     high confidence auto-approves and the listing becomes publicly visible;
//   - confidence routing: flagged or low-confidence content files ONE moderator-queue item
//     and stays pending + invisible;
//   - human stage: GET /api/moderation/queue (401/403/200) and
//     POST /api/moderation/queue/:id/decision — approve publishes, reject never does;
//   - the CRITICAL wave-3 backlog: moderation.scan jobs dead-lettered with no handler are
//     requeued by scripts/requeue-dead-letters.js and PROVEN drained by execution through
//     the real handler to real decisions.
//
// Requirement traceability (SRS Appendix B): FR-08 (TC-08), NFR-08 (decision audit lives in
// mt-ut-quality), NFR-09 (outage legs live in rt01/adr-conformance/it01 — dead-letter +
// pending-forever), NFR-11 (422 on hostile decision bodies), AB-01/AB-03/AB-04 (fake, spam
// and abusive content never reaches guests unreviewed), AB-08 (moderator-only surface).
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../../src/app');
const llm = require('../../src/adapters/llmModeration');
const mockLlm = require('../../src/adapters/llmModeration.mock');
const {
  query,
  makeUser,
  makeHostProfile,
  makeListing,
  makeBooking,
  closeDb,
} = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const { pollOnlyThese } = require('../helpers/outboxScope');
const config = require('../../src/config');
const sessions = require('../../src/modules/auth/sessions');
const { loadHandlers, createRegistry } = require('../../src/outbox/dispatch');
const {
  requeueDeadLetters,
  parseArgs,
  main: requeueMain,
} = require('../../scripts/requeue-dead-letters');

let app;
let registry;

const quietLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return this;
  },
};

beforeAll(() => {
  app = createApp();
  registry = loadHandlers({ log: quietLog });
});

afterAll(async () => {
  mockLlm.reset();
  await closeDb();
  await closeTestRedis();
});

async function cookieFor(user) {
  const { token } = await sessions.createSession(user);
  return `${config.auth.sessionCookieName}=${token}`;
}

/** A fresh eligible host (one per listing: the FR-11 daily cap is one listing/host/day). */
async function makeHost() {
  const host = await makeUser({ can_publish_listing: true, phone_enc: 'enc:v1:tc08-fixture' });
  await makeHostProfile({ user_id: host.id });
  return host;
}

let daySeq = 30; // unique future LA day per API-created listing (clears the FR-11 daily cap)
let cuisineSeq = 0;

/** A unique cuisine tag per test: the U3-SEARCH result-page cache keys on the normalized
 *  query, so re-using one cuisine across tests would serve a stale cached page (TTL 60 s)
 *  and hide a listing approved after the first search. */
function uniqueCuisine() {
  cuisineSeq += 1;
  return `tc08lane${process.pid}x${cuisineSeq}`;
}

/** Create a listing through the REAL API; returns { host, cookie, listingId, scanJobId, cuisine }. */
async function createListingViaApi(textOverrides = {}) {
  const host = await makeHost();
  const cookie = await cookieFor(host);
  daySeq += 1;
  const res = await request(app)
    .post('/api/listings')
    .set('Cookie', cookie)
    .send({
      title: 'TC08 pipeline meal',
      description: 'A tc08 acceptance listing.',
      ingredients: ['rice'],
      allergens: ['none'],
      cuisine: uniqueCuisine(),
      scheduledStart: new Date(Date.now() + daySeq * 24 * 3600 * 1000).toISOString(),
      durationMinutes: 90,
      seatCapacity: 4,
      addressLine1: '9 Pipeline Street',
      city: 'San Diego',
      region: 'CA',
      postalCode: '92101',
      ...textOverrides,
    });
  expect(res.status).toBe(201);
  expect(res.body.listing.moderationStatus).toBe('pending'); // born pending (ADR-002)
  const listingId = res.body.listing.id;
  const { rows } = await query(
    `SELECT id FROM outbox_jobs WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
    [listingId]
  );
  expect(rows).toHaveLength(1);
  return { host, cookie, listingId, scanJobId: rows[0].id, cuisine: res.body.listing.cuisine };
}

async function moderationStatusOf(listingId) {
  const { rows } = await query(`SELECT moderation_status FROM listings WHERE id = $1`, [listingId]);
  return rows[0].moderation_status;
}

async function decisionsFor(listingId) {
  const { rows } = await query(
    `SELECT category, confidence, outcome, decided_by, model_id FROM moderation_decisions
      WHERE content_type = 'listing' AND content_id = $1 ORDER BY created_at`,
    [listingId]
  );
  return rows;
}

async function makeModeratorCookie() {
  const moderator = await makeUser({ roles: ['user', 'moderator'] });
  return { moderator, cookie: await cookieFor(moderator) };
}

// ----------------------------------------------------------------------------------------------
// Substrate (kept from the wave-2 revision — every invariant still binds)
// ----------------------------------------------------------------------------------------------
describe('FR-08 / TC-08 — moderation substrate (ADR-007 adapter contract, ADR-002 schema)', () => {
  test('ADR-007: NODE_ENV=test resolves the deterministic mock; classify returns {category, confidence, model}', async () => {
    const result = await llm.classify('a perfectly friendly home-cooked meal description');
    expect(['offensive', 'spam', 'fraudulent', 'benign']).toContain(result.category);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
    expect(result.confidence).toBeLessThanOrEqual(1);
    expect(typeof result.model).toBe('string');
    expect(result.model).toMatch(/mock/i); // never a real provider model id in the suite
    // Deterministic: same input, same answer.
    const again = await llm.classify('a perfectly friendly home-cooked meal description');
    expect(again).toEqual(result);
  });

  test('ADR-007: low-confidence sentinel yields confidence below the routing threshold', async () => {
    const low = await llm.classify(`review text ${mockLlm.LOW_CONFIDENCE_SENTINEL}`);
    expect(low.confidence).toBeLessThan(config.moderation.confidenceThreshold);
  });

  test('ADR-002/NFR-09: a provider outage is a typed retryable failure, never a fake "approved"', async () => {
    mockLlm.setOutage(true);
    try {
      await expect(llm.classify('anything at all')).rejects.toMatchObject({
        retryable: true,
      });
    } finally {
      mockLlm.setOutage(false);
    }
  });

  test('ADR-007: no provider name, model id, or key hardcoded in the adapter sources', () => {
    const dir = path.join(__dirname, '..', '..', 'src', 'adapters');
    for (const file of ['llmModeration.js', 'llmModeration.mock.js']) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(src).not.toMatch(/gemini/i);
      expect(src).not.toMatch(/googleapis\.com/i);
      expect(src).not.toMatch(/AIza[0-9A-Za-z_-]{10,}/); // Google API key shape
    }
  });

  test('ADR-002 schema backstop: a new listing is born moderation_status=pending (never auto-published)', async () => {
    const listing = await makeListing({});
    expect(listing.moderation_status).toBe('pending');
    const { rows } = await query(
      `SELECT column_default FROM information_schema.columns
        WHERE table_name = 'listings' AND column_name = 'moderation_status'`
    );
    expect(rows[0].column_default).toMatch(/pending/);
  });

  test('U4-MODERATION landed: module, handler and moderator routes exist (converted absence probe)', async () => {
    const modulesDir = path.join(__dirname, '..', '..', 'src', 'modules');
    expect(fs.existsSync(path.join(modulesDir, 'moderation'))).toBe(true);
    expect(registry.types()).toContain('moderation.scan');
    expect(typeof registry.get('moderation.scan').handle).toBe('function');
    // The surface is mounted and session-gated (AB-08): 401 anonymous, never 404.
    expect((await request(app).get('/api/moderation/queue')).status).toBe(401);
  });
});

// ----------------------------------------------------------------------------------------------
// The FR-08 pipeline end to end (TC-08 acceptance)
// ----------------------------------------------------------------------------------------------
describe('TC-08 — pre-filter stage: blocklist hit rejects with ZERO LLM calls', () => {
  test('an obviously abusive listing is rejected by the pre-filter and never surfaces (AB-04)', async () => {
    const { cookie, listingId, scanJobId, cuisine } = await createListingViaApi({
      title: 'Abusive probe meal',
      description: 'If you complain about my food you should go die, all of you.',
    });
    const spy = jest.spyOn(llm, 'classify');
    try {
      await pollOnlyThese([scanJobId], registry, 1);
      expect(spy).not.toHaveBeenCalled(); // stage 1 decided — the provider was never involved
    } finally {
      spy.mockRestore();
    }
    expect(await moderationStatusOf(listingId)).toBe('rejected');
    const decisions = await decisionsFor(listingId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      outcome: 'rejected',
      decided_by: 'pre_filter',
      category: 'offensive',
      model_id: null,
    });
    // Never on a public read path: detail 404 to a stranger, absent from search.
    const browser = await makeUser({});
    const browserCookie = await cookieFor(browser);
    expect(
      (await request(app).get(`/api/listings/${listingId}`).set('Cookie', browserCookie)).status
    ).toBe(404);
    const search = await request(app)
      .get('/api/listings/search')
      .set('Cookie', browserCookie)
      .query({ cuisine, pageSize: 100 });
    expect(search.status).toBe(200);
    expect(JSON.stringify(search.body)).not.toContain(listingId);
    // The owner still sees their own listing, un-published (not a disclosure).
    const ownerView = await request(app).get(`/api/listings/${listingId}`).set('Cookie', cookie);
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.listing.moderationStatus).toBe('rejected');
  });
});

describe('TC-08 — LLM stage: benign content auto-approves and PUBLISHES', () => {
  test('a benign listing scans clean and appears on the public read paths', async () => {
    const { listingId, scanJobId, cuisine } = await createListingViaApi({
      title: 'Friendly tamales evening',
      description: 'Six seats of homemade tamales with salsa verde.',
    });
    await pollOnlyThese([scanJobId], registry, 1);
    expect(await moderationStatusOf(listingId)).toBe('approved');
    const decisions = await decisionsFor(listingId);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      outcome: 'approved',
      decided_by: 'llm',
      category: 'benign',
      model_id: mockLlm.model, // ADR-007: the model id is recorded with the decision
    });
    // Publicly visible now: search finds it, a stranger's detail read is 200.
    const browser = await makeUser({});
    const browserCookie = await cookieFor(browser);
    const search = await request(app)
      .get('/api/listings/search')
      .set('Cookie', browserCookie)
      .query({ cuisine, pageSize: 100 });
    expect(search.status).toBe(200);
    expect(search.body.results.map((r) => r.id)).toContain(listingId);
    expect(
      (await request(app).get(`/api/listings/${listingId}`).set('Cookie', browserCookie)).status
    ).toBe(200);
  });
});

describe('TC-08 — confidence routing + the human stage (FR-08, AB-08)', () => {
  test('flagged content queues for human review; APPROVE publishes it', async () => {
    // "wire transfer" is a deterministic mock fixture (fraudulent, 0.93) that the blocklist
    // deliberately does not cover — the LLM stage flags it, ADR-002 routes it to a human.
    const { listingId, scanJobId, cuisine } = await createListingViaApi({
      description: 'Payment by wire transfer preferred for this dinner.',
    });
    await pollOnlyThese([scanJobId], registry, 1);
    expect(await moderationStatusOf(listingId)).toBe('pending'); // a flag is not a verdict
    const [escalation] = await decisionsFor(listingId);
    expect(escalation).toMatchObject({
      outcome: 'escalated',
      decided_by: 'llm',
      category: 'fraudulent',
    });
    const { rows: items } = await query(
      `SELECT id, reason, status FROM moderation_queue
        WHERE content_type = 'listing' AND content_id = $1`,
      [listingId]
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ reason: 'flagged', status: 'open' });

    // Invisible while queued (never published unreviewed).
    const browser = await makeUser({});
    const browserCookie = await cookieFor(browser);
    expect(
      (await request(app).get(`/api/listings/${listingId}`).set('Cookie', browserCookie)).status
    ).toBe(404);

    // The queue surface: 401 anonymous, 403 ordinary session, 200 moderator with the item.
    expect((await request(app).get('/api/moderation/queue')).status).toBe(401);
    expect(
      (await request(app).get('/api/moderation/queue').set('Cookie', browserCookie)).status
    ).toBe(403);
    const { cookie: moderatorCookie } = await makeModeratorCookie();
    const page = await request(app)
      .get('/api/moderation/queue')
      .set('Cookie', moderatorCookie)
      .query({ status: 'open', contentType: 'listing', pageSize: 100 });
    expect(page.status).toBe(200);
    const entry = page.body.items.find((i) => i.id === items[0].id);
    expect(entry).toBeDefined();
    expect(entry.contentId).toBe(listingId);
    expect(entry.excerpt).toContain('wire transfer');
    expect(entry.latestDecision).toMatchObject({ category: 'fraudulent', outcome: 'escalated' });
    // ADR-010: the queue read model exposes NO location data of the listing.
    expect(JSON.stringify(page.body)).not.toContain('Pipeline Street');

    // Human APPROVE → the content appears on the public read paths.
    const decided = await request(app)
      .post(`/api/moderation/queue/${items[0].id}/decision`)
      .set('Cookie', moderatorCookie)
      .send({ decision: 'approve', category: 'benign', note: 'legitimate menu wording' });
    expect(decided.status).toBe(200);
    expect(decided.body.item.status).toBe('resolved');
    expect(await moderationStatusOf(listingId)).toBe('approved');
    expect(
      (await request(app).get(`/api/listings/${listingId}`).set('Cookie', browserCookie)).status
    ).toBe(200);
    const search = await request(app)
      .get('/api/listings/search')
      .set('Cookie', browserCookie)
      .query({ cuisine, pageSize: 100 });
    expect(search.body.results.map((r) => r.id)).toContain(listingId);
  });

  test('low-confidence content queues; REJECT keeps it unpublished forever', async () => {
    const { listingId, scanJobId, cuisine } = await createListingViaApi({
      description: `An ambiguous description ${mockLlm.LOW_CONFIDENCE_SENTINEL} for review.`,
    });
    await pollOnlyThese([scanJobId], registry, 1);
    expect(await moderationStatusOf(listingId)).toBe('pending');
    const { rows: items } = await query(
      `SELECT id, reason FROM moderation_queue WHERE content_type = 'listing' AND content_id = $1`,
      [listingId]
    );
    expect(items).toHaveLength(1);
    expect(items[0].reason).toBe('low_confidence');

    const { cookie: moderatorCookie } = await makeModeratorCookie();
    const decided = await request(app)
      .post(`/api/moderation/queue/${items[0].id}/decision`)
      .set('Cookie', moderatorCookie)
      .send({ decision: 'reject', category: 'spam' });
    expect(decided.status).toBe(200);
    expect(await moderationStatusOf(listingId)).toBe('rejected');
    const human = (await decisionsFor(listingId)).find((d) => d.decided_by === 'human');
    expect(human).toMatchObject({ outcome: 'rejected', category: 'spam' });
    // Never on a public read path.
    const browser = await makeUser({});
    const browserCookie = await cookieFor(browser);
    expect(
      (await request(app).get(`/api/listings/${listingId}`).set('Cookie', browserCookie)).status
    ).toBe(404);
    const search = await request(app)
      .get('/api/listings/search')
      .set('Cookie', browserCookie)
      .query({ cuisine, pageSize: 100 });
    expect(JSON.stringify(search.body)).not.toContain(listingId);
  });

  test('NFR-11: hostile decision input is a 422 with field-level errors, never a 500', async () => {
    const { cookie: moderatorCookie } = await makeModeratorCookie();
    const bad = await request(app)
      .post(`/api/moderation/queue/not-a-uuid/decision`)
      .set('Cookie', moderatorCookie)
      .send({ decision: 'publish', category: "'; DROP TABLE moderation_queue; --" });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('VALIDATION_FAILED');
    expect(Array.isArray(bad.body.error.fields)).toBe(true);
    // The table survived the injection string (parameterized SQL + schema rejection).
    const { rows } = await query(`SELECT count(*)::int AS n FROM moderation_queue`);
    expect(rows[0].n).toBeGreaterThanOrEqual(0);
  });
});

// ----------------------------------------------------------------------------------------------
// The CRITICAL wave-3 backlog: dead-lettered scans are requeued and PROVEN drained (FR-08,
// NFR-09 — build-plan §4A "requeue the wave-3 dead letters, verify the requeue actually
// drains them")
// ----------------------------------------------------------------------------------------------
describe('FR-08 — wave-3 dead-lettered moderation.scan jobs requeue and drain to decisions', () => {
  test('dead letters (no-handler era) → scripts/requeue-dead-letters.js → real handler drains them', async () => {
    // 1. Recreate the exact wave-3 failure mode: scans enqueued, NO handler registered.
    const a = await createListingViaApi({ description: 'Backlog meal one, perfectly benign.' });
    const b = await createListingViaApi({ description: 'Backlog meal two, also benign.' });
    const emptyRegistry = createRegistry([]); // wave 3's worker had no moderation handler
    for (const scanJobId of [a.scanJobId, b.scanJobId]) {
      for (let i = 0; i < config.outbox.maxAttempts + 1; i += 1) {
        await query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [scanJobId]);
        await pollOnlyThese([scanJobId], emptyRegistry, 1);
      }
      const { rows } = await query(`SELECT status, last_error FROM outbox_jobs WHERE id = $1`, [
        scanJobId,
      ]);
      expect(rows[0].status).toBe('dead');
      expect(rows[0].last_error).toMatch(/no outbox handler registered/i);
    }
    // Failing safe all along: both listings still pending, never published.
    expect(await moderationStatusOf(a.listingId)).toBe('pending');
    expect(await moderationStatusOf(b.listingId)).toBe('pending');

    // 2. The operator script requeues the type's dead letters (fresh budget, available now).
    //    In-process call: a standalone child process would contend on the suite advisory
    //    lock (tests/helpers/env.js concurrency rule); the CLI arg surface is pinned below.
    const result = await requeueDeadLetters({ type: 'moderation.scan', log: { log: () => {} } });
    const requeuedIds = result.requeued.map((r) => String(r.id));
    expect(requeuedIds).toEqual(expect.arrayContaining([String(a.scanJobId), String(b.scanJobId)]));
    for (const row of result.requeued) {
      expect(row.type).toBe('moderation.scan'); // --type filters; nothing else was touched
      expect(row.status).toBe('pending');
      expect(row.attempt_count).toBe(0); // a FRESH retry budget (outbox.requeueDeadLetter)
    }

    // 3. PROVEN DRAINED BY EXECUTION: the real registry delivers both jobs to real decisions.
    await pollOnlyThese([a.scanJobId, b.scanJobId], registry, 2);
    for (const { listingId, scanJobId } of [a, b]) {
      const { rows } = await query(`SELECT status FROM outbox_jobs WHERE id = $1`, [scanJobId]);
      expect(rows[0].status).toBe('delivered');
      expect(await moderationStatusOf(listingId)).toBe('approved'); // benign backlog published
      const decisions = await decisionsFor(listingId);
      expect(decisions).toHaveLength(1);
      expect(decisions[0]).toMatchObject({ decided_by: 'llm', outcome: 'approved' });
    }
  });

  test('the CLI argument surface is pinned (operator contract)', () => {
    expect(parseArgs(['--type', 'moderation.scan'])).toMatchObject({
      type: 'moderation.scan',
      limit: 500,
      dryRun: false,
    });
    expect(parseArgs(['--type=moderation.scan', '--limit=10', '--dry-run'])).toMatchObject({
      type: 'moderation.scan',
      limit: 10,
      dryRun: true,
    });
    expect(parseArgs(['--all'])).toMatchObject({ all: true });
    expect(() => parseArgs([])).toThrow(/--type/);
    expect(() => parseArgs(['--frobnicate'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--type', 'x', '--limit', '0'])).toThrow(/--limit/);
  });

  test('the CLI entry point runs end to end; --dry-run requeues NOTHING', async () => {
    // A fresh dead scan the dry run must see but not touch.
    const probe = await createListingViaApi({ description: 'Dry-run probe meal, benign.' });
    const emptyRegistry = createRegistry([]);
    for (let i = 0; i < config.outbox.maxAttempts + 1; i += 1) {
      await query(`UPDATE outbox_jobs SET available_at = now() WHERE id = $1`, [probe.scanJobId]);
      await pollOnlyThese([probe.scanJobId], emptyRegistry, 1);
    }
    const io = { log: jest.fn(), error: jest.fn() };
    const result = await requeueMain(['--type', 'moderation.scan', '--dry-run'], io);
    expect(result.matched).toBeGreaterThanOrEqual(1);
    expect(result.requeued).toEqual([]); // dry run: nothing re-opened
    const { rows } = await query(`SELECT status FROM outbox_jobs WHERE id = $1`, [probe.scanJobId]);
    expect(rows[0].status).toBe('dead'); // untouched
    expect(io.log).toHaveBeenCalled();
    // --all --dry-run lists every dead type without touching any (operator overview lane).
    const allDry = await requeueMain(['--all', '--dry-run'], { log: jest.fn(), error: jest.fn() });
    expect(allDry.requeued).toEqual([]);
    expect(allDry.matched).toBeGreaterThanOrEqual(1); // at least our probe is listed
    // A non-matching type requeues nothing even without --dry-run (the filter is real).
    const noneSuchIo = { log: jest.fn(), error: jest.fn() };
    const noneSuch = await requeueMain(['--type', 'no.such.type'], noneSuchIo);
    expect(noneSuch.matched).toBe(0);
    expect(noneSuch.requeued).toEqual([]);
    // Clean up: really requeue and drain it so no dead row leaks into sibling suites' scans.
    await requeueDeadLetters({ type: 'moderation.scan', log: { log: () => {} } });
    await pollOnlyThese([probe.scanJobId], registry, 2);
    expect(await moderationStatusOf(probe.listingId)).toBe('approved');
  });
});

// ----------------------------------------------------------------------------------------------
// Wave-4 verification additions (lane tc-booking, TC-08): the FR-08 acceptance clauses the
// file above did not yet execute — the publication policy on the two NEW scanned surfaces
// (reviews FR-05, messages FR-06), the provider-outage clause ("stays pending indefinitely,
// never appears in search/detail, while the job is retried"), and the AB-03 per-author
// submission rate limit (stage 1b).
// ----------------------------------------------------------------------------------------------
const moderationService = require('../../src/modules/moderation/service');

/** Completed booking between a fresh eligible guest and a host with a public profile. */
async function makeReviewableBooking() {
  const host = await makeUser({ can_publish_listing: true, phone_enc: 'enc:v1:tc08-w4' });
  await makeHostProfile({ user_id: host.id });
  const listing = await makeListing({ host_id: host.id, moderation_status: 'approved' });
  const guest = await makeUser({ phone_enc: 'enc:v1:tc08-w4' });
  const booking = await makeBooking({
    listing_id: listing.id,
    guest_id: guest.id,
    status: 'completed',
    host_confirmed_completion: true,
    guest_confirmed_completion: true,
    completed_at: new Date(),
  });
  return { host, listing, guest, booking };
}

async function scanJobFor(contentType, contentId) {
  const { rows } = await query(
    `SELECT id, payload FROM outbox_jobs
      WHERE type = 'moderation.scan' AND payload->>'contentType' = $1
        AND payload->>'contentId' = $2`,
    [contentType, contentId]
  );
  expect(rows).toHaveLength(1);
  // ADR-003: the scan payload carries IDs only — exactly the two contract keys.
  expect(Object.keys(rows[0].payload).sort()).toEqual(['contentId', 'contentType']);
  return rows[0].id;
}

async function openQueueItemFor(contentType, contentId) {
  const { rows } = await query(
    `SELECT id, reason, status FROM moderation_queue
      WHERE content_type = $1 AND content_id = $2 AND status <> 'resolved'`,
    [contentType, contentId]
  );
  return rows[0] || null;
}

async function hostReviewIds(hostId, viewerCookie) {
  const res = await request(app)
    .get(`/api/hosts/${hostId}/reviews`)
    .set('Cookie', viewerCookie)
    .query({ pageSize: 100 });
  expect(res.status).toBe(200);
  return res.body.reviews.map((r) => r.id);
}

async function threadMessageIds(bookingId, cookie) {
  const res = await request(app)
    .get(`/api/bookings/${bookingId}/messages`)
    .set('Cookie', cookie)
    .query({ pageSize: 100 });
  expect(res.status).toBe(200);
  return res.body.items.map((m) => m.id);
}

describe('TC-08 wave 4 — FR-08 publication policy: reviews stay pending until approved', () => {
  test('a review is born pending and INVISIBLE on GET /api/hosts/:id/reviews; the scan approves it into view', async () => {
    const { host, guest, booking } = await makeReviewableBooking();
    const guestCookie = await cookieFor(guest);
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reviews`)
      .set('Cookie', guestCookie)
      .send({ rating: 5, comment: 'Delicious tamales and a very kind host.' });
    expect(res.status).toBe(201);
    expect(res.body.review.moderationStatus).toBe('pending');
    const reviewId = res.body.review.id;
    const jobId = await scanJobFor('review', reviewId);

    // Pending review is NOT publicly readable (FR-08 publication gate).
    const browser = await makeUser({});
    const browserCookie = await cookieFor(browser);
    expect(await hostReviewIds(host.id, browserCookie)).not.toContain(reviewId);

    await pollOnlyThese([jobId], registry, 1);

    const { rows: statusRows } = await query(
      `SELECT moderation_status FROM reviews WHERE id = $1`,
      [reviewId]
    );
    expect(statusRows[0].moderation_status).toBe('approved');
    const { rows: decisions } = await query(
      `SELECT outcome, decided_by, category, model_id FROM moderation_decisions
        WHERE content_type = 'review' AND content_id = $1`,
      [reviewId]
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      outcome: 'approved',
      decided_by: 'llm',
      category: 'benign',
      model_id: mockLlm.model,
    });
    expect(await hostReviewIds(host.id, browserCookie)).toContain(reviewId);
  });

  test('a flagged review files ONE queue item and stays pending; human REJECT keeps it unpublished forever', async () => {
    const { host, guest, booking } = await makeReviewableBooking();
    const guestCookie = await cookieFor(guest);
    const res = await request(app)
      .post(`/api/bookings/${booking.id}/reviews`)
      .set('Cookie', guestCookie)
      // "wire transfer" = deterministic mock fixture (fraudulent 0.93); NOT a blocklist rule.
      .send({ rating: 1, comment: 'Host asked for a wire transfer before the meal.' });
    expect(res.status).toBe(201);
    const reviewId = res.body.review.id;
    const jobId = await scanJobFor('review', reviewId);
    await pollOnlyThese([jobId], registry, 1);

    // Escalated, not decided: review pending + one open queue item, reason 'flagged'.
    const { rows } = await query(`SELECT moderation_status FROM reviews WHERE id = $1`, [reviewId]);
    expect(rows[0].moderation_status).toBe('pending');
    const item = await openQueueItemFor('review', reviewId);
    expect(item).not.toBeNull();
    expect(item.reason).toBe('flagged');

    const browser = await makeUser({});
    const browserCookie = await cookieFor(browser);
    expect(await hostReviewIds(host.id, browserCookie)).not.toContain(reviewId);

    // Human stage: reject → rejected, still never published.
    const { cookie: modCookie } = await makeModeratorCookie();
    const decide = await request(app)
      .post(`/api/moderation/queue/${item.id}/decision`)
      .set('Cookie', modCookie)
      .send({ decision: 'reject', category: 'fraudulent' });
    expect(decide.status).toBe(200);
    const { rows: after } = await query(`SELECT moderation_status FROM reviews WHERE id = $1`, [
      reviewId,
    ]);
    expect(after[0].moderation_status).toBe('rejected');
    expect(await hostReviewIds(host.id, browserCookie)).not.toContain(reviewId);
  });
});

describe('TC-08 wave 4 — FR-08 publication policy: messages deliver first, scan later', () => {
  test('a message is readable by the other participant BEFORE any scan; an LLM-flag queues it; human REJECT hides it', async () => {
    const { host, guest, booking } = await makeReviewableBooking();
    const guestCookie = await cookieFor(guest);
    const hostCookie = await cookieFor(host);

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/messages`)
      .set('Cookie', guestCookie)
      // "click here" = deterministic mock spam fixture (0.95); NOT a blocklist rule.
      .send({ body: 'Hi! click here for my other menus.' });
    expect(res.status).toBe(201);
    const messageId = res.body.message.id;
    const jobId = await scanJobFor('message', messageId);

    // Delivered immediately: the HOST reads it while the scan job is still pending.
    expect(await threadMessageIds(booking.id, hostCookie)).toContain(messageId);

    await pollOnlyThese([jobId], registry, 1);

    // Flagged → escalated to the human queue; message row NOT auto-rejected by the LLM stage.
    const item = await openQueueItemFor('message', messageId);
    expect(item).not.toBeNull();
    expect(item.reason).toBe('flagged');
    const { rows } = await query(`SELECT moderation_status FROM messages WHERE id = $1`, [
      messageId,
    ]);
    expect(rows[0].moderation_status).toBe('pending');

    // Human REJECT → the message disappears from subsequent thread reads (AB-04).
    const { cookie: modCookie } = await makeModeratorCookie();
    const decide = await request(app)
      .post(`/api/moderation/queue/${item.id}/decision`)
      .set('Cookie', modCookie)
      .send({ decision: 'reject', category: 'spam' });
    expect(decide.status).toBe(200);
    expect(await threadMessageIds(booking.id, hostCookie)).not.toContain(messageId);
    // ... for BOTH participants (the sender does not keep a private copy of removed content).
    expect(await threadMessageIds(booking.id, guestCookie)).not.toContain(messageId);
  });

  test('a blocklist-hit message is delivered, then auto-rejected by the pre-filter with ZERO LLM calls and hidden (AB-04)', async () => {
    const { host, guest, booking } = await makeReviewableBooking();
    const guestCookie = await cookieFor(guest);
    const hostCookie = await cookieFor(host);

    const res = await request(app)
      .post(`/api/bookings/${booking.id}/messages`)
      .set('Cookie', guestCookie)
      .send({ body: 'If you rate me badly you should go die.' });
    expect(res.status).toBe(201); // ADR-002: delivery never waits on moderation
    const messageId = res.body.message.id;
    const jobId = await scanJobFor('message', messageId);
    expect(await threadMessageIds(booking.id, hostCookie)).toContain(messageId);

    const spy = jest.spyOn(llm, 'classify');
    try {
      await pollOnlyThese([jobId], registry, 1);
      expect(spy).not.toHaveBeenCalled(); // stage 1 decided
    } finally {
      spy.mockRestore();
    }
    const { rows } = await query(`SELECT moderation_status FROM messages WHERE id = $1`, [
      messageId,
    ]);
    expect(rows[0].moderation_status).toBe('rejected');
    const { rows: decisions } = await query(
      `SELECT outcome, decided_by, category FROM moderation_decisions
        WHERE content_type = 'message' AND content_id = $1`,
      [messageId]
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      outcome: 'rejected',
      decided_by: 'pre_filter',
      category: 'offensive',
    });
    expect(await threadMessageIds(booking.id, hostCookie)).not.toContain(messageId);
  });
});

describe('TC-08 wave 4 — provider outage: public content stays pending, is retried, never publishes unreviewed', () => {
  test('with the LLM adapter failing every attempt, a listing and a review stay pending + invisible; recovery publishes', async () => {
    const { listingId, scanJobId, cuisine } = await createListingViaApi({
      title: 'Outage drill supper',
      description: 'A perfectly benign meal used for the NFR-09 outage drill.',
    });
    const { host: rHost, guest, booking } = await makeReviewableBooking();
    const guestCookie = await cookieFor(guest);
    const reviewRes = await request(app)
      .post(`/api/bookings/${booking.id}/reviews`)
      .set('Cookie', guestCookie)
      .send({ rating: 4, comment: 'Really lovely evening, thank you.' });
    expect(reviewRes.status).toBe(201);
    const reviewId = reviewRes.body.review.id;
    const reviewJobId = await scanJobFor('review', reviewId);

    const browser = await makeUser({});
    const browserCookie = await cookieFor(browser);

    mockLlm.setOutage(true);
    try {
      // Two scoped cycles: each due job fails once and is backed off (not yet dead).
      await pollOnlyThese([scanJobId, reviewJobId], registry, 2);

      const { rows: jobs } = await query(
        `SELECT id, status, attempt_count, available_at > now() AS backed_off
           FROM outbox_jobs WHERE id = ANY($1::bigint[]) ORDER BY id`,
        [[scanJobId, reviewJobId]]
      );
      for (const job of jobs) {
        expect(job.status).toBe('pending'); // retried, NOT delivered, NOT auto-anything
        expect(job.attempt_count).toBeGreaterThanOrEqual(1);
        expect(job.backed_off).toBe(true); // exponential backoff pushed available_at out
      }
      // Both stay pending and OFF every public read path.
      expect(await moderationStatusOf(listingId)).toBe('pending');
      expect(
        (await request(app).get(`/api/listings/${listingId}`).set('Cookie', browserCookie)).status
      ).toBe(404);
      const search = await request(app)
        .get('/api/listings/search')
        .set('Cookie', browserCookie)
        .query({ cuisine, pageSize: 100 });
      expect(search.status).toBe(200);
      expect(JSON.stringify(search.body)).not.toContain(listingId);
      expect(await hostReviewIds(rHost.id, browserCookie)).not.toContain(reviewId);
    } finally {
      mockLlm.reset();
    }

    // Provider recovers: pull the backed-off jobs due and drain — NOW they publish.
    await query(`UPDATE outbox_jobs SET available_at = now() WHERE id = ANY($1::bigint[])`, [
      [scanJobId, reviewJobId],
    ]);
    await pollOnlyThese([scanJobId, reviewJobId], registry, 1);
    expect(await moderationStatusOf(listingId)).toBe('approved');
    const { rows: after } = await query(`SELECT moderation_status FROM reviews WHERE id = $1`, [
      reviewId,
    ]);
    expect(after[0].moderation_status).toBe('approved');
  });
});

describe('TC-08 wave 4 — AB-03: the per-author submission rate limit escalates, never auto-rejects', () => {
  test('the 16th listing inside the 60-minute window escalates to the human queue with reason rate_limited and ZERO LLM calls', async () => {
    const { RATE_LIMIT } = require('../../src/modules/moderation/prefilter');
    expect(RATE_LIMIT).toEqual({ windowMinutes: 60, maxSubmissionsPerWindow: 15 });

    const host = await makeUser({ can_publish_listing: true, phone_enc: 'enc:v1:tc08-w4' });
    await makeHostProfile({ user_id: host.id });
    let last;
    for (let i = 0; i < RATE_LIMIT.maxSubmissionsPerWindow + 1; i += 1) {
      last = await makeListing({ host_id: host.id }); // distinct LA days; created_at = now()
    }

    const spy = jest.spyOn(mockLlm, 'classify');
    let outcome;
    try {
      outcome = await moderationService.processScan(
        { contentType: 'listing', contentId: last.id },
        { classify: mockLlm.classify, mode: 'mock' }
      );
      expect(spy).not.toHaveBeenCalled(); // stage 1b decided before any provider call
    } finally {
      spy.mockRestore();
    }
    expect(outcome.outcome).toBe('escalated');

    // Escalated to a human as probable spam — content stays pending (volume is a signal, not proof).
    expect(await moderationStatusOf(last.id)).toBe('pending');
    const item = await openQueueItemFor('listing', last.id);
    expect(item).not.toBeNull();
    expect(item.reason).toBe('rate_limited');
    const { rows: decisions } = await query(
      `SELECT outcome, decided_by, category, model_id FROM moderation_decisions
        WHERE content_type = 'listing' AND content_id = $1`,
      [last.id]
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      outcome: 'escalated',
      decided_by: 'pre_filter',
      category: 'spam',
      model_id: null,
    });
  });
});

// ----------------------------------------------------------------------------------------------
// U-V4R-SAFETY-QUEUE acceptance (U4-SAFETY-COMPLETE): a raised safety alert, drained through
// the REAL worker, appears as a moderation_queue row of content_type 'safety_alert' that the
// unified queue ROUTE serves — filterable, unfiltered-safe, and decidable — while the alert
// row itself keeps its FR-07 delivery lifecycle (no publication state to flip).
// ----------------------------------------------------------------------------------------------
describe('TC-08 wave 4 — U4-SAFETY-COMPLETE: safety alerts in the ONE unified queue (FR-07/FR-08)', () => {
  afterEach(async () => {
    // Hygiene: remove the safety_alert rows this describe filed into the SHARED queue table
    // so sibling suites' queue pages stay predictable (helpers CONCURRENCY RULE).
    await query(`DELETE FROM moderation_queue WHERE content_type = 'safety_alert'`);
  });

  test('alert raise → worker drain → queue row served unfiltered AND filtered → human decision resolves it; the alert row is untouched', async () => {
    // A booking whose guest raises the alert over HTTP (FR-07 request half).
    const host = await makeUser({ can_publish_listing: true, phone_enc: 'enc:v1:tc08-w4' });
    await makeHostProfile({ user_id: host.id });
    const listing = await makeListing({ host_id: host.id, moderation_status: 'approved' });
    const guest = await makeUser({ phone_enc: 'enc:v1:tc08-w4' });
    const booking = await makeBooking({ listing_id: listing.id, guest_id: guest.id });
    const raised = await request(app)
      .post(`/api/bookings/${booking.id}/safety-alerts`)
      .set('Cookie', await cookieFor(guest))
      .send({});
    expect(raised.status).toBe(201);
    const alertId = raised.body.alert.id;

    // Drain ONLY this alert's safety.alert job through the real worker (house rule (b)).
    const { rows: jobs } = await query(
      `SELECT id FROM outbox_jobs WHERE type = 'safety.alert' AND payload->>'alertId' = $1`,
      [alertId]
    );
    expect(jobs).toHaveLength(1);
    await pollOnlyThese([jobs[0].id], registry, 1);

    // The unified-queue entry was filed (unifiedQueueSupported() is TRUE on the real tree).
    const item = await openQueueItemFor('safety_alert', alertId);
    expect(item).not.toBeNull();
    expect(item.reason).toBe('safety_alert');

    const moderator = await makeUser({ roles: ['user', 'moderator'] });
    const moderatorCookie = await cookieFor(moderator);

    // The route serves the type FILTERED (widened schema enum, no more 422)…
    const filtered = await request(app)
      .get('/api/moderation/queue')
      .set('Cookie', moderatorCookie)
      .query({ contentType: 'safety_alert', status: 'open', pageSize: 100 });
    expect(filtered.status).toBe(200);
    const entry = filtered.body.items.find((i) => i.contentId === alertId);
    expect(entry).toMatchObject({ contentType: 'safety_alert', status: 'open' });
    // …with an IDs-only excerpt (booking id + raised time — NFR-13/ADR-010: never a name,
    // address or contact value) and no publication state (an alert has none).
    expect(entry.excerpt).toContain(booking.id);
    expect(entry.excerpt).not.toMatch(/[^\s@]+@[^\s@]+\.[^\s@]+/);
    expect(entry.contentStatus).toBeNull();

    // …and UNFILTERED: the mixed page serializes, one safety_alert row 500s nothing.
    const unfiltered = await request(app)
      .get('/api/moderation/queue')
      .set('Cookie', moderatorCookie)
      .query({ status: 'open', pageSize: 100 });
    expect(unfiltered.status).toBe(200);
    expect(unfiltered.body.items.some((i) => i.contentId === alertId)).toBe(true);

    // The entry is DECIDABLE: the human decision records and resolves it (FR-08 human stage)…
    const decided = await request(app)
      .post(`/api/moderation/queue/${item.id}/decision`)
      .set('Cookie', moderatorCookie)
      .send({ decision: 'approve', category: 'benign', note: 'Safety alert reviewed.' });
    expect(decided.status).toBe(200);
    expect(decided.body.item).toMatchObject({ id: item.id, status: 'resolved' });
    const { rows: decisions } = await query(
      `SELECT decided_by, decided_by_user_id, outcome FROM moderation_decisions
        WHERE content_type = 'safety_alert' AND content_id = $1`,
      [alertId]
    );
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ decided_by: 'human', decided_by_user_id: moderator.id });

    // …while setModerationStatus stayed a recorded no-op: the alert row still exists with
    // its own delivery lifecycle untouched ('no_channel' — the guest has no contact on file).
    const { rows: alerts } = await query(
      `SELECT delivery_status FROM safety_alerts WHERE id = $1`,
      [alertId]
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0].delivery_status).toBe('no_channel');
  });
});
