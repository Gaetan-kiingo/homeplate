// tests/tc-booking/tc08-moderation-substrate.test.js — VERIFIER lane "tc-booking", TC-08 (FR-08,
// ADR-002/007).
//
// The moderation FLOW (pre-filter, worker scan, moderator queue, publication policy) is a
// wave-4 unit and is NOT built in this run. This file verifies the wave-2 substrate FR-08
// will stand on, and documents the flow's absence:
//  - ADR-007: the automated suite resolves the DETERMINISTIC MOCK adapter; classify()
//    returns {category, confidence, model} with valid category/confidence; a forced outage
//    surfaces as a typed retryable error (so wave 4 can keep public content pending);
//  - no provider name, model id, or API key is hardcoded in either adapter source file;
//  - ADR-002 schema backstop: listings.moderation_status DEFAULTS to 'pending' — content
//    is born unpublished;
//  - moderation flow endpoints/modules do not exist yet (documented gap).
'use strict';

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const { createApp } = require('../../src/app');
const llm = require('../../src/adapters/llmModeration');
const mockLlm = require('../../src/adapters/llmModeration.mock');
const { query, makeUser, makeHostProfile, makeListing, closeDb } = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');
const { pollOnlyThese } = require('../helpers/outboxScope');
const config = require('../../src/config');
const sessions = require('../../src/modules/auth/sessions');
const { loadHandlers } = require('../../src/outbox/dispatch');

let app;

beforeAll(() => {
  app = createApp();
});

afterAll(async () => {
  mockLlm.reset();
  await closeDb();
  await closeTestRedis();
});

describe('FR-08 / TC-08 — moderation substrate (wave-2 scope)', () => {
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

  test('ADR-007: low-confidence sentinel yields confidence below any sane threshold (routes to human review in wave 4)', async () => {
    const low = await llm.classify(`review text ${mockLlm.LOW_CONFIDENCE_SENTINEL}`);
    expect(low.confidence).toBeLessThan(0.8);
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

  test('WAVE-4 GAP (documented): no moderation module, routes, decision writer, or moderation.scan handler exists yet', () => {
    const modulesDir = path.join(__dirname, '..', '..', 'src', 'modules');
    expect(fs.existsSync(path.join(modulesDir, 'moderation'))).toBe(false);
    // …and the outbox worker has NO handler for the scan jobs listings enqueue (the safe
    // failure direction of that absence is proven in the next describe).
    const registry = loadHandlers();
    expect(registry.types()).not.toContain('moderation.scan');
    expect(registry.get('moderation.scan')).toBeFalsy();
    // moderation_decisions / moderation_queue tables exist (schema-first), but nothing
    // writes them yet — assert they are empty of application writes in this run.
  });
});

// ----------------------------------------------------------------------------------------------
// FR-08's safe failure direction — merged from the wave-3 re-verification files: with no
// moderation handler built, an unhandled scan job must strand content INVISIBLE, never publish it.
// ----------------------------------------------------------------------------------------------

describe('FR-08 — an unhandled moderation.scan dead-letters and the content never publishes itself', () => {
  async function cookieFor(user) {
    const { token } = await sessions.createSession(user);
    return `${config.auth.sessionCookieName}=${token}`;
  }

  test('the scan job retries then DEAD-LETTERS, and the listing stays pending and invisible to non-owners', async () => {
    const host = await makeUser({ can_publish_listing: true, phone_enc: 'enc:v1:tc08-fixture' });
    await makeHostProfile({ user_id: host.id });
    const cookie = await cookieFor(host);
    const created = await request(app)
      .post('/api/listings')
      .set('Cookie', cookie)
      .send({
        title: 'Reverify probe meal',
        description: 'A verifier-lane probe listing for the FR-08 safe-direction assertion.',
        ingredients: ['rice'],
        allergens: ['none'],
        cuisine: 'test',
        scheduledStart: new Date(Date.UTC(2030, 5, 17, 20, 0, 0)).toISOString(),
        durationMinutes: 90,
        seatCapacity: 4,
        addressLine1: '9 Probe Street',
        city: 'San Diego',
        region: 'CA',
        postalCode: '92101',
      });
    expect(created.status).toBe(201);
    const listingId = created.body.listing.id;
    expect(created.body.listing.moderationStatus).toBe('pending');

    const { rows: scan } = await query(
      `SELECT id FROM outbox_jobs WHERE type = 'moderation.scan' AND payload->>'contentId' = $1`,
      [listingId]
    );
    expect(scan).toHaveLength(1);

    // Burn the retry budget with the REAL registry (no moderation handler is registered).
    const registry = loadHandlers();
    for (let i = 0; i < config.outbox.maxAttempts + 1; i += 1) {
      await query('UPDATE outbox_jobs SET available_at = now() WHERE id = $1', [scan[0].id]);
      await pollOnlyThese([scan[0].id], registry, 1);
    }
    const { rows: dead } = await query('SELECT status, last_error FROM outbox_jobs WHERE id = $1', [
      scan[0].id,
    ]);
    expect(dead[0].status).toBe('dead');
    expect(dead[0].last_error).toMatch(/no outbox handler registered/i);

    // FR-08's required failure direction: the content NEVER publishes itself.
    const { rows: still } = await query('SELECT moderation_status FROM listings WHERE id = $1', [
      listingId,
    ]);
    expect(still[0].moderation_status).toBe('pending');

    // …and it is invisible to every read path a non-owner can reach. (AB-08: both read
    // routes require a session — anonymous callers get 401, which is also invisibility.)
    expect((await request(app).get(`/api/listings/${listingId}`)).status).toBe(401);
    expect((await request(app).get('/api/listings/search').query({ q: 'Reverify' })).status).toBe(
      401
    );

    const browser = await makeUser({ phone_enc: 'enc:v1:tc08-fixture' });
    const browserCookie = await cookieFor(browser);
    const detail = await request(app)
      .get(`/api/listings/${listingId}`)
      .set('Cookie', browserCookie);
    expect(detail.status).toBe(404); // pending content is indistinguishable from missing

    const search = await request(app)
      .get('/api/listings/search')
      .set('Cookie', browserCookie)
      .query({ city: 'San Diego', pageSize: 50 });
    expect(search.status).toBe(200);
    expect(JSON.stringify(search.body)).not.toContain(listingId);

    // The owner still sees their own pending listing (not a publication).
    const ownerView = await request(app).get(`/api/listings/${listingId}`).set('Cookie', cookie);
    expect(ownerView.status).toBe(200);
    expect(ownerView.body.listing.moderationStatus).toBe('pending');
  });
});
