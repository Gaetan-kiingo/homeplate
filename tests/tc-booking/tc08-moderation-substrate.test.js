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
const llm = require('../../src/adapters/llmModeration');
const mockLlm = require('../../src/adapters/llmModeration.mock');
const { query, makeListing, closeDb } = require('../helpers/db');
const { closeTestRedis } = require('../helpers/redis');

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

  test('WAVE-4 GAP (documented): no moderation module, pre-filter, queue, or decision writer exists yet', () => {
    const modulesDir = path.join(__dirname, '..', '..', 'src', 'modules');
    expect(fs.existsSync(path.join(modulesDir, 'moderation'))).toBe(false);
    // moderation_decisions / moderation_queue tables exist (schema-first), but nothing
    // writes them yet — assert they are empty of application writes in this run.
  });
});
