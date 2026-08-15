// tests/coverage/cov-verify-probes.test.js — COVERAGE lane re-verification probes (waves 0-3).
//
// Owned by the "coverage" verification lane. Each probe pins down a mechanism that the
// lane's findings report, so a fixer can reproduce it without re-deriving it:
//
//   P1  ADR-005/ADR-010 maps-cache audit shape — the shared audit loop in
//       tests/adr-conformance/adr-invariants.test.js asserts EVERY value cached under
//       hp:cache:maps:* is a bare {areaLabel, lat, lng}. maps.searchArea caches a
//       {areas: [...]} ENVELOPE under the same namespace, so the audit throws as soon as
//       any sibling suite has resolved a location in the same Jest run (shared Redis DB,
//       flushed only once per run in globalSetup). This probe reproduces that
//       deterministically inside one file, and separately proves the envelope's CONTENTS
//       are still public precision (so the production invariant itself holds).
//
//   P2  Exported-function reachability — the exports the lane's static cross-reference
//       flagged as never named outside their own file are executed here so the coverage
//       report shows a real hit rather than an unexercised branch.
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-01   — location search resolves through the Maps adapter (searchArea).
//   NFR-01  — repeat lookups are served from the Redis cache.
//   ADR-005 — one Maps adapter, Redis-cached, cache doubles as the NFR-09 fallback.
//   ADR-010 — Redis caches PUBLIC precision only; a cache read can never leak an exact
//             street address or precise coordinates.
'use strict';

const maps = require('../../src/adapters/maps');
const { coarsen, defaultAreaLabel, METERS_PER_DEGREE_LAT } = require('../../src/lib/geoPrecision');
const { redis } = require('../../src/db/redis');
const sanitize = require('../../src/lib/sanitize');
const resilience = require('../../src/lib/resilience');
const dispatch = require('../../src/outbox/dispatch');
const routeRegistry = require('../../src/routes/index');
const policy = require('../../src/modules/eligibility/policy');
const tokens = require('../../src/modules/users/tokens');
const fcm = require('../../src/adapters/fcm');

const MAPS_KEYS = 'hp:cache:maps:*';

async function mapsCacheEntries() {
  const keys = await redis.keys(MAPS_KEYS);
  const out = [];
  for (const key of keys) {
    const raw = await redis.get(key);
    if (raw === null) continue;
    out.push({ key, raw, value: JSON.parse(raw) });
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// P1 — the maps-cache audit shape
//
// HOUSEKEEPING: these probes deliberately WRITE {areas:[…]} envelopes into the shared
// hp:cache:maps:* namespace — which is exactly what makes the audit loop in
// tests/adr-conformance/adr-invariants.test.js:273 throw. Until that loop learns to unwrap
// the envelope (see the lane's finding), this file removes ONLY the keys it created so a
// later suite in the same Jest run cannot inherit them. Redis is flushed once per run in
// globalSetup, never between suites, so leaving them behind would make suite order decide
// whether the run is green.
// -------------------------------------------------------------------------------------------
describe('coverage lane P1 — hp:cache:maps:* holds two different value shapes', () => {
  let preexistingKeys = new Set();

  beforeAll(async () => {
    preexistingKeys = new Set(await redis.keys(MAPS_KEYS));
  });

  afterAll(async () => {
    const now = await redis.keys(MAPS_KEYS);
    const mine = now.filter((k) => !preexistingKeys.has(k));
    if (mine.length > 0) await redis.del(...mine);
  });

  test('searchArea caches an {areas:[…]} envelope, geocode caches a bare {areaLabel,lat,lng}', async () => {
    await maps.geocode('1 Coverage Probe Way, San Diego, CA');
    await maps.searchArea('coverage probe district');

    const entries = await mapsCacheEntries();
    expect(entries.length).toBeGreaterThan(0);

    const shapes = new Set();
    for (const { value } of entries) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item === null || typeof item !== 'object') continue;
        shapes.add(Object.keys(item).sort().join(','));
      }
    }
    // BOTH shapes coexist in the one namespace. The shared adr-invariants audit loop
    // (adr-invariants.test.js:273) asserts the bare shape for every entry, so it fails the
    // moment an envelope entry is present — an order-dependent failure, not a code defect.
    expect(shapes.has('areaLabel,lat,lng')).toBe(true);
    expect(shapes.has('areas')).toBe(true);
  });

  test('the audit loop as written in adr-invariants.test.js:273 throws on the envelope', async () => {
    await maps.searchArea('coverage probe district');
    const entries = await mapsCacheEntries();
    const envelopes = entries.filter(({ value }) => {
      const items = Array.isArray(value) ? value : [value];
      return items.some((i) => i && typeof i === 'object' && Object.keys(i).join(',') === 'areas');
    });
    expect(envelopes.length).toBeGreaterThan(0);

    // Verbatim copy of the assertion the shared ADR test applies to every cached item.
    const applyAuditAssertion = () => {
      for (const { value } of envelopes) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item === null || typeof item !== 'object') continue;
          expect(Object.keys(item).sort()).toEqual(['areaLabel', 'lat', 'lng']);
        }
      }
    };
    expect(applyAuditAssertion).toThrow(); // reproduces the observed suite failure
  });

  test('the envelope CONTENTS are still public precision — ADR-010 itself is not violated', async () => {
    const query = '7863 Girard Ave, La Jolla, CA 92037';
    const result = await maps.searchArea(query);
    expect(Array.isArray(result.areas)).toBe(true);

    const entries = await mapsCacheEntries();
    for (const { key, raw, value } of entries) {
      expect(key).not.toMatch(/girard|92037|coverage probe way/i);
      expect(raw).not.toMatch(/7863/);
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item === null || typeof item !== 'object') continue;
        const areas = Array.isArray(item.areas) ? item.areas : [item];
        for (const area of areas) {
          if (!area || typeof area.lat !== 'number') continue;
          const again = coarsen(area.lat, area.lng);
          expect(again.lat).toBe(area.lat); // already grid-snapped ⇒ public precision
          expect(again.lng).toBe(area.lng);
        }
      }
    }
  });
});

// -------------------------------------------------------------------------------------------
// P2 — exports the cross-reference found unreferenced outside their own file
// -------------------------------------------------------------------------------------------
describe('coverage lane P2 — statically unreferenced exports do real work', () => {
  test('geoPrecision.defaultAreaLabel and METERS_PER_DEGREE_LAT compute real values', () => {
    expect(typeof METERS_PER_DEGREE_LAT).toBe('number');
    expect(METERS_PER_DEGREE_LAT).toBeGreaterThan(110000);
    const label = defaultAreaLabel(32.7157, -117.1611);
    expect(typeof label).toBe('string');
    expect(label.length).toBeGreaterThan(0);
    expect(label).not.toMatch(/\d{3,}\s+\w+\s+(st|ave|blvd)/i);
  });

  test('sanitize.escapeHtml escapes every HTML metacharacter (NFR-11 / AB-06)', () => {
    expect(sanitize.escapeHtml('<script>a&b"c\'d</script>')).toBe(
      '&lt;script&gt;a&amp;b&quot;c&#x27;d&lt;/script&gt;'
    );
  });

  test('resilience.defaultIsRetryable and DEFAULT_RETRIES classify real errors', () => {
    expect(Number.isInteger(resilience.DEFAULT_RETRIES)).toBe(true);
    expect(resilience.DEFAULT_RETRIES).toBeGreaterThan(0);
    // The contract is the typed-error `retryable` flag (src/lib/errors.js), not HTTP status:
    // anything not explicitly marked non-retryable is retried (NFR-09 bounded retries).
    const netErr = Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
    expect(resilience.defaultIsRetryable(netErr)).toBe(true);
    expect(resilience.defaultIsRetryable(undefined)).toBe(true);
    const permanent = Object.assign(new Error('bad request'), { retryable: false });
    expect(resilience.defaultIsRetryable(permanent)).toBe(false);
  });

  test('dispatch.validateHandler rejects malformed handlers and accepts real ones', () => {
    expect(typeof dispatch.DEFAULT_HANDLERS_DIR).toBe('string');
    expect(() => dispatch.validateHandler({ type: 'x.y', handle: async () => {} })).not.toThrow();
    expect(() => dispatch.validateHandler({ type: 'x.y' })).toThrow();
    expect(() => dispatch.validateHandler({ handle: async () => {} })).toThrow();
  });

  test('routes.collectAllowedMethods reports the real methods of a known path', () => {
    const express = require('express');
    const app = express();
    const r = express.Router();
    r.get('/thing', (_q, s) => s.json({}));
    r.post('/thing', (_q, s) => s.json({}));
    app.use('/api/x', r);
    // Signature is (stack, pathname) — it walks an Express router stack, not an app.
    const allowed = [...routeRegistry.collectAllowedMethods(app._router.stack, '/api/x/thing')];
    expect(allowed.map((m) => m.toUpperCase()).sort()).toEqual(['GET', 'POST']);
    expect([...routeRegistry.collectAllowedMethods(app._router.stack, '/api/x/nope')]).toEqual([]);
  });

  test('eligibility.isHostProfileComplete distinguishes complete from incomplete profiles', () => {
    expect(typeof policy.isHostProfileComplete).toBe('function');
    const complete = policy.isHostProfileComplete({
      displayName: 'Ada',
      bio: 'Home cook in North Park.',
      addressLine1: '1 Main St',
      city: 'San Diego',
      state: 'CA',
      postalCode: '92103',
    });
    const incomplete = policy.isHostProfileComplete({ displayName: 'Ada' });
    expect(typeof complete).toBe('boolean');
    expect(typeof incomplete).toBe('boolean');
    expect(complete).not.toBe(incomplete); // the predicate actually discriminates
  });

  test('users/tokens.generateToken + hashToken produce a verifiable, non-reversible pair', () => {
    const a = tokens.generateToken(); // { raw, hash }
    const b = tokens.generateToken();
    expect(typeof a.raw).toBe('string');
    expect(a.raw.length).toBeGreaterThan(20);
    expect(a.raw).not.toBe(b.raw); // real randomness, not a constant
    expect(a.hash).not.toBe(a.raw); // the stored form is not the token
    expect(tokens.hashToken(a.raw)).toBe(a.hash); // deterministic, matches generateToken
    expect(tokens.hashToken(b.raw)).not.toBe(a.hash);
    expect(() => tokens.hashToken('')).toThrow(TypeError);
  });

  test('fcm.pushDisabledError is the ADR-011 gated-channel error, not a generic throw', () => {
    const err = fcm.pushDisabledError();
    expect(err).toBeInstanceOf(Error);
    expect(typeof err.code).toBe('string');
    expect(err.code.length).toBeGreaterThan(0);
  });
});
