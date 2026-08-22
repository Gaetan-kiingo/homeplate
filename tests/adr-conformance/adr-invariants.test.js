// tests/adr-conformance/adr-invariants.test.js — ADR conformance lane (verifier-owned).
//
// Executable audit of the binding architecture invariants for the wave-0..2 surface:
//   ADR-001/003 — no adapter on any request path; business row + outbox row in ONE
//                 transaction (no dual writes); outbox payloads carry IDs only.
//   ADR-002     — schema substrate: public content defaults moderation_status='pending'
//                 (the pipeline itself is wave 4 and is reported not_implemented).
//   ADR-004     — media referenced by storage key; per-object deletion (deleteForUser
//                 calls deleteByKey per owned key against real MinIO).
//   ADR-005/010 — maps results cached in Redis at PUBLIC precision only; repeat lookup
//                 served from cache; coarsening deterministic and idempotent.
//   ADR-006     — exactly one eligibility-policy implementation; sessions + login rate
//                 limiting behave per NFR-05/AB-05.
//   ADR-007     — no provider/model/key hardcoded; test suite resolves the mock adapter.
//   W3-ADR-02   — NODE_ENV=test REFUSES a live adapter (env pinning + config refusal),
//                 re-executed in a child process so no jest-side pinning masks a regression.
//   ADR-009     — caps come from config; DB backstop refuses a second listing on the same
//                 America/Los_Angeles day across UTC-day boundaries.
//   ADR-011     — push gated off by default; every send persists a NOTIFICATION_ATTEMPT
//                 row; nothing leaves the process in the automated suite.
//   Redis role  — every key in the test keyspace is session / rate-limit / cache only.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const request = require('supertest');

const dbHelper = require('../helpers/db');
const { pollOnlyThese } = require('../helpers/outboxScope');
const { localDateFor } = require('../../scripts/seed');

const ROOT = path.join(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

/** Recursively list .js files under a directory. */
function listJsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(p));
    else if (entry.isFile() && p.endsWith('.js')) out.push(p);
  }
  return out;
}

const EMAIL_SHAPE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;

let app; // created once in the ADR-001 describe, reused by later behavioural tests

afterAll(async () => {
  const { closeRedis } = require('../../src/db/redis');
  await dbHelper.closeDb();
  await closeRedis();
});

// ------------------------------------------------------------------------------------------
// ADR-001 / ADR-003 — modular monolith, worker-only adapters, transactional outbox
// ------------------------------------------------------------------------------------------
describe('ADR-001/003 — request path never touches an adapter; outbox is transactional', () => {
  test('booting the full HTTP app loads NO module from src/adapters/*', () => {
    // Evidence by execution: require the real app factory (which mounts every module
    // routes.js on disk) and inspect the module registry. Any adapter reachable at
    // module scope from a request handler would appear in require.cache here.
    const { createApp } = require('../../src/app');
    app = createApp();
    const adapterModules = Object.keys(require.cache).filter((p) =>
      p.includes(`${path.sep}src${path.sep}adapters${path.sep}`)
    );
    expect(adapterModules).toEqual([]);
  });

  test('static scan: no module-scope adapter require ANYWHERE in src/ outside the worker layer', () => {
    // Belt-and-braces over the runtime check: scan the WHOLE of src/ (not just the
    // request-reachable directories — a helper in lib/ or db/ pulled in at module scope
    // would load the adapter for every consumer) for a top-level (brace-depth-0) require
    // of src/adapters. The only sanctioned module-scope importers are the worker layer:
    // src/outbox/handlers/* and the notifications delivery transport (whose importers are
    // themselves pinned to outbox handlers by the next test). Call-time requires inside
    // documented worker-only functions (media/service.deleteForUser) are exempt because
    // they never run on a request; the runtime check above proves they did not load.
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

  test('the worker-only transport is imported only from outbox handler / notifications code', () => {
    const importers = [];
    for (const file of listJsFiles(SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      if (/require\(['"][^'"]*notifications\/transport['"]\)/.test(text)) {
        importers.push(path.relative(SRC, file));
      }
    }
    // ADR-001/003: ONLY outbox handlers (worker-only code) may consume the delivery
    // transport. Wave 3 added bookingNotifications.js, wave 4 safetyAlert.js and
    // accountErasure.js (the NFR-12 inactivity notice) — outbox handlers, i.e. exactly the
    // sanctioned location class. Anything outside src/outbox/handlers/ is a violation.
    expect(importers.sort()).toEqual([
      path.join('outbox', 'handlers', 'accountErasure.js'),
      path.join('outbox', 'handlers', 'bookingNotifications.js'),
      path.join('outbox', 'handlers', 'emailVerification.js'),
      path.join('outbox', 'handlers', 'safetyAlert.js'),
    ]);
    for (const importer of importers) {
      expect(importer.startsWith(path.join('outbox', 'handlers') + path.sep)).toBe(true);
    }
  });

  test('register commits USER row + outbox row together, payload is IDs only', async () => {
    const email = `adrconf.atomic.${Date.now()}@adrlane.homeplate.invalid`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'correct-horse-battery' });
    expect(res.status).toBe(201);

    const { rows: users } = await dbHelper.query('SELECT * FROM users WHERE email = $1', [email]);
    expect(users).toHaveLength(1);

    const { rows: jobs } = await dbHelper.query(
      `SELECT * FROM outbox_jobs WHERE type = 'email.verification'
       AND payload->>'userId' = $1`,
      [users[0].id]
    );
    expect(jobs).toHaveLength(1);
    // ADR-003: IDs/digests only — exactly {userId, tokenHash}, nothing email/phone-shaped.
    expect(Object.keys(jobs[0].payload).sort()).toEqual(['tokenHash', 'userId']);
    expect(JSON.stringify(jobs[0].payload)).not.toMatch(EMAIL_SHAPE);
  });

  test('no dual write: outbox enqueue failure rolls back the USER row too', async () => {
    const outbox = require('../../src/outbox/outbox');
    const spy = jest
      .spyOn(outbox, 'enqueue')
      .mockRejectedValue(new Error('adr-conformance: injected enqueue failure'));
    const email = `adrconf.rollback.${Date.now()}@adrlane.homeplate.invalid`;
    try {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email, password: 'correct-horse-battery' });
      expect(res.status).toBeGreaterThanOrEqual(500);
    } finally {
      spy.mockRestore();
    }
    const { rows } = await dbHelper.query('SELECT id FROM users WHERE email = $1', [email]);
    expect(rows).toEqual([]); // both writes rolled back — no dual write
  });

  test('outbox.enqueue REFUSES the pool (a dual write cannot even be expressed)', async () => {
    // ADR-001/003: the outbox row must ride the SAME transaction as the business row, so
    // enqueue only accepts a checked-out transaction client — handing it the pool (which
    // would autocommit a second, independent transaction) is a type error, not a foot-gun.
    // (PII-shape rejection for enqueue payloads is exercised exhaustively in
    // tests/unit/outbox.test.js, "enqueue — IDs-only payload guard (ADR-003)".)
    const outbox = require('../../src/outbox/outbox');
    const pool = require('../../src/db/pool');
    await expect(
      outbox.enqueue(pool, { type: 'adrconf.probe', payload: { id: crypto.randomUUID() } })
    ).rejects.toThrow(/TRANSACTION client|checked-out pg client/);
    await expect(
      outbox.enqueue(pool.pool, { type: 'adrconf.probe', payload: { id: crypto.randomUUID() } })
    ).rejects.toThrow(/TRANSACTION client|checked-out pg client/);
  });

  test('audit: every persisted outbox payload is free of email/phone-shaped values', async () => {
    const { rows } = await dbHelper.query('SELECT id, payload FROM outbox_jobs');
    const offenders = rows.filter((r) => EMAIL_SHAPE.test(JSON.stringify(r.payload)));
    expect(offenders).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------
// ADR-002 — moderation substrate (pipeline itself is wave 4)
// ------------------------------------------------------------------------------------------
describe('ADR-002 — public content is born PENDING (schema substrate)', () => {
  test('a listing inserted without moderation_status defaults to pending', async () => {
    const listing = await dbHelper.makeListing();
    expect(listing.moderation_status).toBe('pending');
  });

  test('a review inserted without moderation_status defaults to pending', async () => {
    const booking = await dbHelper.makeBooking();
    const { rows } = await dbHelper.query(
      `INSERT INTO reviews (booking_id, author_id, target_user_id, rating, body)
       SELECT b.id, b.guest_id, l.host_id, 5, 'adr-conformance review'
       FROM bookings b JOIN listings l ON l.id = b.listing_id WHERE b.id = $1
       RETURNING moderation_status`,
      [booking.id]
    );
    expect(rows[0].moderation_status).toBe('pending');
  });
});

// ------------------------------------------------------------------------------------------
// ADR-004 — media by key, per-object deletion (real MinIO)
// ------------------------------------------------------------------------------------------
describe('ADR-004 — media stored by key; erasure deletes per object', () => {
  test('media_objects stores a storage KEY (never bytes) and the URL is derived locally', async () => {
    const { rows } = await dbHelper.query(
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

  test('deleteForUser is wired to EXACTLY the worker-only erasure handler (NFR-12 landed)', () => {
    // Converted from the wave-3 "WIRING GAP" probe when U4-PRIVACY landed: the NFR-12
    // erasure job now calls the ADR-004 primitive — but ONLY from the outbox handler, which
    // injects it into the privacy service (the request path stays adapter-free, ADR-001/003,
    // and no second caller may reimplement or shortcut the delete-by-key contract).
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
    expect(callers).toEqual([path.join('outbox', 'handlers', 'accountErasure.js')]);
    // The privacy module is on disk (build-plan §4D) and its request-reachable files never
    // touch the media service or an adapter — the erasure hook arrives by injection only.
    expect(fs.existsSync(path.join(SRC, 'modules', 'privacy'))).toBe(true);
    for (const f of ['service.js', 'routes.js', 'repo.js']) {
      const src = fs.readFileSync(path.join(SRC, 'modules', 'privacy', f), 'utf8');
      expect(src).not.toMatch(/require\(['"][^'"]*media\/service['"]\)/);
      expect(src).not.toMatch(/require\(['"][^'"]*adapters\//);
    }
  });

  test('attach records the key; deleteForUser deletes each object then its row', async () => {
    const objectStorage = require('../../src/adapters/objectStorage');
    const mediaService = require('../../src/modules/media/service');
    const user = await dbHelper.makeUser();
    const k1 = `listing/${user.id}/adrconf-a-${Date.now()}.jpg`;
    const k2 = `listing/${user.id}/adrconf-b-${Date.now()}.jpg`;
    await objectStorage.put(k1, Buffer.from('adrconf-object-1'), { contentType: 'image/jpeg' });
    await objectStorage.put(k2, Buffer.from('adrconf-object-2'), { contentType: 'image/jpeg' });
    await mediaService.attach(user.id, k1, 'listing');
    await mediaService.attach(user.id, k2, 'listing');

    // PostgreSQL references the object BY KEY (ADR-004), never inline bytes.
    const { rows } = await dbHelper.query(
      'SELECT storage_key FROM media_objects WHERE owner_user_id = $1 ORDER BY created_at',
      [user.id]
    );
    expect(rows.map((r) => r.storage_key)).toEqual([k1, k2]);

    const spy = jest.spyOn(objectStorage, 'deleteByKey');
    const result = await mediaService.deleteForUser(user.id);
    expect(result).toMatchObject({ deletedObjects: 2, deletedRows: 2, total: 2 });
    expect(spy.mock.calls.map((c) => c[0]).sort()).toEqual([k1, k2]); // one call PER key
    spy.mockRestore();

    await expect(objectStorage.get(k1)).rejects.toMatchObject({ code: 'MEDIA_NOT_FOUND' });
    const { rows: after } = await dbHelper.query(
      'SELECT id FROM media_objects WHERE owner_user_id = $1',
      [user.id]
    );
    expect(after).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------
// ADR-005 / ADR-010 — maps cache is public-precision only; repeat lookups hit cache
// ------------------------------------------------------------------------------------------
describe('ADR-005/010 — Redis maps cache holds ONLY coarse public precision', () => {
  test('repeat geocode is served from cache; cached values are coarse and label-only', async () => {
    const maps = require('../../src/adapters/maps');
    const { coarsen } = require('../../src/lib/geoPrecision');
    const { redis } = require('../../src/db/redis');

    const address = '4076 Adr Conformance St, San Diego, CA 92103';
    const first = await maps.geocode(address);
    const second = await maps.geocode(address);
    expect(second.source).toBe('cache'); // NFR-01/ADR-005: zero provider work on repeat
    expect(second.lat).toBe(first.lat);
    expect(second.lng).toBe(first.lng);
    expect(second.precise).toBeUndefined(); // never a precise pair without the explicit opt-in

    // The returned default projection is ALREADY coarse: coarsening it again is a no-op.
    const recoarsened = coarsen(first.lat, first.lng);
    expect(recoarsened.lat).toBe(first.lat);
    expect(recoarsened.lng).toBe(first.lng);

    // Audit EVERY maps cache key/value in Redis: hashed keys (no address text), values
    // limited to coarse lat/lng + area label — a cache read cannot leak an exact location.
    const keys = await redis.keys('hp:cache:maps:*');
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).not.toMatch(/adr|conformance|st,|street|92103/i);
      const raw = await redis.get(key);
      const value = JSON.parse(raw);
      // The maps namespace holds TWO cached shapes (src/adapters/maps.js, cachedLookup writes
      // `publicValue` verbatim under hp:cache:maps:<kind>:<digest>[:stale]): a geocode entry
      // { lat, lng, areaLabel } and a searchArea envelope { areas: [ …geocode entries ] }.
      // Flatten both so this audit stays valid whichever lookups ran earlier in the suite —
      // asserting only the geocode shape made the test order-dependent (it went red as soon as
      // any earlier test performed a location search) AND left the searchArea coordinates —
      // exactly where location SEARCH results live — never audited at all (COV-02).
      const items = [];
      for (const entry of Array.isArray(value) ? value : [value]) {
        if (entry === null || typeof entry !== 'object') continue; // negative cache entries
        if (Array.isArray(entry.areas)) {
          // An envelope carries `areas` and NOTHING else: any sibling field would ride into
          // Redis unaudited, which is precisely how an exact coordinate would leak (ADR-010).
          expect(Object.keys(entry).sort()).toEqual(['areas']);
          items.push(...entry.areas);
        } else {
          items.push(entry);
        }
      }
      for (const item of items) {
        if (item === null || typeof item !== 'object') continue;
        expect(Object.keys(item).sort()).toEqual(['areaLabel', 'lat', 'lng']);
        const again = coarsen(item.lat, item.lng);
        expect(again.lat).toBe(item.lat); // already grid-snapped ⇒ public precision
        expect(again.lng).toBe(item.lng);
        expect(String(item.areaLabel)).not.toMatch(/\d{3,}\s+\w+\s+(st|ave|road|rd|blvd)/i);
      }
    }
  });

  test('exact precision is an explicit opt-in and is never written to the cache', async () => {
    const maps = require('../../src/adapters/maps');
    const { redis } = require('../../src/db/redis');
    const address = '999 Exact Precision Way, San Diego, CA';
    const exact = await maps.geocode(address, { precision: 'exact' });
    expect(exact.precise).toBeDefined();
    // The default public projection is genuinely COARSER than the precise pair — if
    // coarsening were the identity, "public precision only" would be vacuous (ADR-010).
    expect(exact.lat).not.toBe(exact.precise.lat);
    // Neither the precise coordinates nor the street text may appear ANYWHERE in Redis —
    // the whole keyspace is scanned, not just the maps namespace, so a leak through some
    // other cache path cannot hide.
    const leaks = [];
    for (const key of await redis.keys('*')) {
      if (key.includes('Exact Precision Way')) leaks.push(`key ${key} carries the street`);
      if ((await redis.type(key)) !== 'string') continue;
      const raw = await redis.get(key);
      if (!raw) continue;
      if (raw.includes(String(exact.precise.lat)) || raw.includes(String(exact.precise.lng))) {
        leaks.push(`value at ${key} carries precise coordinates`);
      }
      if (raw.includes('Exact Precision Way')) leaks.push(`value at ${key} carries the street`);
    }
    expect(leaks).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------
// ADR-006 — one eligibility policy; sessions + rate limiting
// ------------------------------------------------------------------------------------------
describe('ADR-006 — single eligibility policy, session lifecycle, login rate limit', () => {
  test('canReserveSeat / canPublishListing are implemented ONLY in eligibility/policy.js', () => {
    // Union of two independently-derived definition shapes (round-1 + round-2 verifiers):
    // `function canX`, `canX: fn` / `canX = fn` / `canX = (`, and `const|let canX =` with
    // ANY right-hand side (arrow functions without parens included).
    const definitions = [
      /(function\s+can(ReserveSeat|PublishListing)\b)|(\bcan(ReserveSeat|PublishListing)\s*[:=]\s*(async\s*)?(function\b|\())/,
      /(function|const|let)\s+(canReserveSeat|canPublishListing)\s*[=(]/,
    ];
    const offenders = [];
    for (const file of listJsFiles(SRC)) {
      if (file.endsWith(path.join('eligibility', 'policy.js'))) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (definitions.some((d) => d.test(text))) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  test('login issues an opaque cookie session; logout kills it server-side (AB-05)', async () => {
    const passwords = require('../../src/modules/auth/passwords');
    const hash = await passwords.hashPassword('adrconf-password-1');
    const user = await dbHelper.makeUser({ password_hash: hash });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'adrconf-password-1' });
    expect(login.status).toBe(200);
    const cookie = login.headers['set-cookie'];
    expect(cookie).toBeDefined();
    expect(cookie.join(';')).toMatch(/HttpOnly/i);

    const me = await request(app).get('/api/users/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    // NFR-13/ADR-010 allowlist serializer: no password/hash material leaves the API.
    expect(JSON.stringify(me.body)).not.toMatch(/password|hash|argon2/i);

    const out = await request(app).post('/api/auth/logout').set('Cookie', cookie).send({});
    expect(out.status).toBeLessThan(300);
    const meAfter = await request(app).get('/api/users/me').set('Cookie', cookie);
    expect(meAfter.status).toBe(401); // Redis record destroyed — token unusable
  });

  test('6th login attempt in the window is 429 even with correct credentials (ST-03)', async () => {
    const passwords = require('../../src/modules/auth/passwords');
    const hash = await passwords.hashPassword('adrconf-password-2');
    const user = await dbHelper.makeUser({ password_hash: hash });

    for (let i = 0; i < 5; i += 1) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: user.email, password: 'wrong-password-attempt' });
      expect(res.status).toBe(401);
    }
    const sixth = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'adrconf-password-2' });
    expect(sixth.status).toBe(429);
    expect(sixth.headers['retry-after']).toBeDefined();
  });
});

// ------------------------------------------------------------------------------------------
// ADR-007 — provider-agnostic LLM adapter, mock in the automated suite
// ------------------------------------------------------------------------------------------
describe('ADR-007 — no hardcoded provider/model/key; suite runs the mock', () => {
  test('adapter sources contain no provider name, model id or API key literal', () => {
    const files = [
      path.join(SRC, 'adapters', 'llmModeration.js'),
      path.join(SRC, 'adapters', 'llmModeration.mock.js'),
    ];
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toMatch(/gemini|generativelanguage|googleapis|AIza[0-9A-Za-z_-]{10}/i);
      expect(text).not.toMatch(/api[_-]?key\s*[:=]\s*['"][A-Za-z0-9]/i);
    }
  });

  test('NODE_ENV=test resolves the deterministic mock adapter', async () => {
    const config = require('../../src/config');
    expect(config.moderation.mode).toBe('mock');
    const llm = require('../../src/adapters/llmModeration');
    expect(llm.mode).toBe('mock'); // the resolved ADAPTER agrees with config, not just config
    const adapter = llm.getAdapter ? llm.getAdapter() : llm;
    const a = await adapter.classify('hello, a perfectly benign message');
    const b = await adapter.classify('hello, a perfectly benign message');
    expect(a).toEqual(b); // deterministic
    expect(a.model).toMatch(/mock/i); // never a live model id in the suite
    expect(['offensive', 'spam', 'fraudulent', 'benign']).toContain(a.category);
    expect(a.confidence).toBeGreaterThanOrEqual(0);
    expect(a.confidence).toBeLessThanOrEqual(1);
  });

  test('base URL, key and model id are all environment-driven and documented in .env.example', () => {
    const schema = fs.readFileSync(path.join(SRC, 'config', 'schema.js'), 'utf8');
    for (const v of ['LLM_MODERATION_BASE_URL', 'LLM_MODERATION_API_KEY', 'MODERATION_MODEL']) {
      expect(schema).toContain(v);
      expect(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8')).toContain(v);
    }
    expect(require('../../src/config').moderation.mode).toBe('mock');
  });
});

// ------------------------------------------------------------------------------------------
// W3-ADR-02 — NODE_ENV=test refuses a live adapter (ADR-005/007/011)
// ------------------------------------------------------------------------------------------
// The ORIGINAL W3-ADR-02 failure scenario, re-executed in a child process: a leftover shell
// export must not be able to flip the automated suite onto a live provider. The in-process
// schema-level refusals live in tests/unit/config.test.js ("U1-CONFIG test environment
// refuses live adapters"); these probes additionally prove the tests/helpers/env.js PINNING
// works in a fresh node process, where no jest-side setup can mask a regression.
describe('W3-ADR-02 re-verification — NODE_ENV=test refuses a live adapter', () => {
  const probe = (extraEnv) => {
    const script =
      "require('./tests/helpers/env');" +
      "const c=require('./src/config');" +
      'console.log(JSON.stringify({moderation:c.moderation.mode,maps:c.maps.mode,transport:c.notifications.transport}));';
    try {
      const out = execFileSync(process.execPath, ['-e', script], {
        cwd: ROOT,
        env: { ...process.env, ...extraEnv },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return { ok: true, out: out.trim() };
    } catch (err) {
      return { ok: false, out: `${err.stdout || ''}${err.stderr || ''}` };
    }
  };

  test('a leftover LLM_MODERATION_MODE=live shell cannot flip the suite onto the live provider', () => {
    const res = probe({
      LLM_MODERATION_MODE: 'live',
      LLM_MODERATION_BASE_URL: 'https://example.invalid/v1',
      LLM_MODERATION_API_KEY: 'not-a-real-key',
      MODERATION_MODEL: 'some-model-id',
      ALLOW_LIVE_ADAPTERS_IN_TESTS: '',
    });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.out).moderation).toBe('mock');
  });

  test('a leftover MAPS_MODE=live shell cannot flip the suite onto the live provider', () => {
    const res = probe({
      MAPS_MODE: 'live',
      MAPS_API_KEY: 'not-a-real-key',
      ALLOW_LIVE_ADAPTERS_IN_TESTS: '',
    });
    expect(res.ok).toBe(true);
    expect(JSON.parse(res.out).maps).toBe('mock');
  });

  test('NOTIFICATIONS_TRANSPORT=sendgrid is still refused outright under NODE_ENV=test', () => {
    const res = probe({
      NOTIFICATIONS_TRANSPORT: 'sendgrid',
      SENDGRID_API_KEY: 'SG.not-real',
      SENDGRID_FROM_EMAIL: 'no@example.invalid',
    });
    // env.js pins the transport to mock, so the value never reaches config; either outcome is
    // conformant as long as no live transport is selected.
    if (res.ok) expect(JSON.parse(res.out).transport).toBe('mock');
    else expect(res.out).toMatch(/NOTIFICATIONS_TRANSPORT must be mock/);
  });

  test('the config layer itself refuses a live adapter under NODE_ENV=test (defence in depth)', () => {
    // Beyond the refusal itself (unit/config.test.js), the error must NAME the documented
    // IT-03 escape hatch so an operator knows the refusal is deliberate and how to opt in.
    const script =
      "process.env.NODE_ENV='test';" +
      'delete process.env.ALLOW_LIVE_ADAPTERS_IN_TESTS;' +
      "process.env.LLM_MODERATION_MODE='live';" +
      "process.env.LLM_MODERATION_BASE_URL='https://example.invalid/v1';" +
      "process.env.LLM_MODERATION_API_KEY='k';" +
      "process.env.MODERATION_MODEL='m';" +
      "const {validateEnv}=require('./src/config/schema');" +
      "try{validateEnv(process.env);console.log('ACCEPTED');}catch(e){console.log('REFUSED: '+e.message);}";
    const out = execFileSync(process.execPath, ['-e', script], {
      cwd: ROOT,
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL,
        REDIS_URL: process.env.REDIS_URL,
      },
      encoding: 'utf8',
    });
    expect(out).toMatch(/REFUSED/);
    expect(out).toMatch(/ALLOW_LIVE_ADAPTERS_IN_TESTS/);
  });
});

// ------------------------------------------------------------------------------------------
// ADR-009 — caps from config; America/Los_Angeles day boundary (DB backstop)
// ------------------------------------------------------------------------------------------
describe('ADR-009 — MEHKO caps in config; LA-day uniqueness backstop', () => {
  test('caps are configuration with the mandated values', () => {
    const config = require('../../src/config');
    expect(config.mehko).toMatchObject({
      listingsPerHostPerDay: 1,
      maxMealsPerDay: 30,
      maxMealsPerWeek: 90,
      timezone: 'America/Los_Angeles',
    });
    // ...and the locale module (the single source config reads from) agrees — the ADR-009
    // California table lives in ONE place, not in two places that could drift apart.
    const locale = require('../../src/config/locale');
    expect(locale.timezone).toBe('America/Los_Angeles');
    expect(locale.mehko).toEqual({
      maxListingsPerHostPerDay: 1,
      maxMealsPerHostPerDay: 30,
      maxMealsPerHostPerWeek: 90,
    });
  });

  test('second listing on the same LA day is refused across UTC-day boundaries', async () => {
    const host = await dbHelper.makeUser();
    // 2027-03-10T21:00Z = 13:00 America/Los_Angeles on Mar 10 (PST, pre-DST).
    const t1 = new Date('2027-03-10T21:00:00Z');
    // 2027-03-11T07:30Z = 23:30 America/Los_Angeles on Mar 10 — a DIFFERENT UTC day and a
    // different date for, e.g., a client in Tokyo, but the SAME LA calendar day.
    const t2 = new Date('2027-03-11T07:30:00Z');
    // 2027-03-11T08:10Z = 00:10 LA on Mar 11 — the SAME UTC day as t2 but the NEXT LA day.
    const t3 = new Date('2027-03-11T08:10:00Z');

    expect(localDateFor(t1)).toBe('2027-03-10');
    expect(localDateFor(t2)).toBe('2027-03-10'); // same LA day, different UTC day
    expect(localDateFor(t3)).toBe('2027-03-11'); // next LA day, same UTC day as t2

    await dbHelper.makeListing({ host_id: host.id, scheduled_start: t1 });
    // Refused: one listing per host per LA calendar day (FR-11 / AB-07 / ADR-009).
    await expect(
      dbHelper.makeListing({ host_id: host.id, scheduled_start: t2 })
    ).rejects.toMatchObject({ code: '23505' });
    // Allowed: just after LA midnight it is a new LA day even though UTC day is unchanged.
    await expect(
      dbHelper.makeListing({ host_id: host.id, scheduled_start: t3 })
    ).resolves.toMatchObject({ local_date: expect.anything() });
  });
});

// ------------------------------------------------------------------------------------------
// ADR-010 — mounted-surface audit (wave-3 scope: core marketplace mounted, wave 4 absent)
// ------------------------------------------------------------------------------------------
describe('ADR-010 — mounted surface audit (wave-3 scope)', () => {
  test('wave-4 modules are NOT mounted; /api/search stays 404 (search lives under /api/listings/search)', async () => {
    for (const p of [
      '/api/reviews',
      '/api/messaging',
      '/api/moderation',
      '/api/safety',
      '/api/privacy',
    ]) {
      const res = await request(app).get(p);
      expect(res.status).toBe(404); // wave-4 surface must not exist yet
    }
    // Build-plan §6.5: the search module mounts at /api/listings/search only.
    const search = await request(app).get('/api/search');
    expect(search.status).toBe(404);
  });

  test('every mounted wave-3 read path refuses unauthenticated access (AB-08 — never data)', async () => {
    const listing = await dbHelper.makeListing();
    for (const p of [
      `/api/listings/${listing.id}`,
      '/api/listings/search',
      `/api/hosts/${listing.host_id}`,
      `/api/hosts/${listing.host_id}/reviews`,
      '/api/bookings',
    ]) {
      const res = await request(app).get(p);
      expect(res.status).toBe(401); // session required — no listing/host data unauthenticated
      expect(JSON.stringify(res.body)).not.toMatch(/address|"lat"|"lng"|street/i);
    }
  });

  test('profile serializer allowlist carries no location or credential fields', async () => {
    const passwords = require('../../src/modules/auth/passwords');
    const hash = await passwords.hashPassword('adrconf-password-3');
    const user = await dbHelper.makeUser({ password_hash: hash });
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: user.email, password: 'adrconf-password-3' });
    const me = await request(app).get('/api/users/me').set('Cookie', login.headers['set-cookie']);
    expect(me.status).toBe(200);
    const body = JSON.stringify(me.body);
    expect(body).not.toMatch(/address|street|latitude|longitude|"lat"|"lng"/i);
  });
});

// ------------------------------------------------------------------------------------------
// ADR-011 — push default-false; every attempt persists a NOTIFICATION_ATTEMPT row
// ------------------------------------------------------------------------------------------
describe('ADR-011 — email channel, gated push, persisted attempts, mock in suite', () => {
  test('notifications.push.enabled defaults to FALSE with no env override', () => {
    const { validateEnv } = require('../../src/config/schema');
    const cfg = validateEnv({
      NODE_ENV: 'development',
      DATABASE_URL: 'postgres://u:p@localhost:5432/homeplate',
      REDIS_URL: 'redis://localhost:6379/0',
      FIELD_ENCRYPTION_KEY: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      OBJECT_STORAGE_ENDPOINT: 'http://localhost:9000',
      OBJECT_STORAGE_BUCKET: 'b',
      OBJECT_STORAGE_ACCESS_KEY: 'a',
      OBJECT_STORAGE_SECRET_KEY: 's',
    });
    expect(cfg.notifications.push.enabled).toBe(false);
    expect(cfg.notifications.transport).toBe('mock'); // dev/test default (ADR-011)
  });

  test('an email send persists a NOTIFICATION_ATTEMPT row (mock transport, no live send)', async () => {
    const config = require('../../src/config');
    expect(config.notifications.transport).toBe('mock'); // the suite never leaves process
    const transport = require('../../src/modules/notifications/transport');
    const user = await dbHelper.makeUser();
    const key = `adrconf-email-${Date.now()}`;
    const result = await transport.send({
      userId: user.id,
      channel: 'email',
      template: 'email.verification',
      params: { userId: user.id },
      idempotencyKey: key,
    });
    expect(result.status).toBe('sent');
    const { rows } = await dbHelper.query(
      'SELECT * FROM notification_attempts WHERE idempotency_key = $1',
      [key]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      recipient_user_id: user.id,
      channel: 'email',
      status: 'sent',
    });
    // The row carries the recipient's ID only — never an email address (ADR-003/§3.4).
    expect(JSON.stringify(rows[0].params)).not.toMatch(EMAIL_SHAPE);
  });

  test('a push send is REFUSED under the default-false gate and recorded as failed', async () => {
    const transport = require('../../src/modules/notifications/transport');
    const user = await dbHelper.makeUser();
    const key = `adrconf-push-${Date.now()}`;
    const result = await transport.send({
      userId: user.id,
      channel: 'push',
      template: 'email.verification',
      params: { userId: user.id },
      idempotencyKey: key,
    });
    // The refusal is TYPED (reason names the gate) and the persisted row records why.
    expect(result).toMatchObject({ status: 'failed', reason: 'push_disabled' });
    const { rows } = await dbHelper.query(
      'SELECT status, last_error FROM notification_attempts WHERE idempotency_key = $1',
      [key]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failed');
    expect(rows[0].last_error).toMatch(/push channel refused/);
  });

  test('end-to-end FR-10: register → worker poll → persisted email attempt', async () => {
    const dispatch = require('../../src/outbox/dispatch');
    const email = `adrconf.e2e.${Date.now()}@adrlane.homeplate.invalid`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'correct-horse-battery' });
    expect(res.status).toBe(201);
    const { rows: users } = await dbHelper.query('SELECT id FROM users WHERE email = $1', [email]);

    const registry = dispatch.loadHandlers();
    // DETERMINISM (verification-report F-01): run the worker scoped to THIS registration's
    // verification job instead of draining the shared table on a fixed pass budget. The old
    // `guard < 10` loop covered at most 100 rows, oldest-first across the WHOLE outbox table,
    // so whether this job was ever claimed depended on how many pending rows sibling suites
    // happened to leave behind — and the attempt assertion below would then fail with a story
    // about notifications while the cause was scheduling.
    const { rows: ownJobs } = await dbHelper.query(
      `SELECT id FROM outbox_jobs
        WHERE type = 'email.verification' AND payload->>'userId' = $1 AND status = 'pending'`,
      [users[0].id]
    );
    expect(ownJobs).toHaveLength(1); // registration enqueued exactly one verification job
    await pollOnlyThese(
      ownJobs.map((j) => j.id),
      registry
    );

    const { rows: attempts } = await dbHelper.query(
      `SELECT channel, status FROM notification_attempts WHERE recipient_user_id = $1`,
      [users[0].id]
    );
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({ channel: 'email', status: 'sent' });
  });
});

// ------------------------------------------------------------------------------------------
// Redis role — sessions, rate-limit counters and cache ONLY (no business state)
// ------------------------------------------------------------------------------------------
describe('Redis holds sessions / rate-limit counters / cache only', () => {
  test('every key created by the exercised flows is in an approved namespace', async () => {
    const { redis } = require('../../src/db/redis');
    const keys = await redis.keys('*');
    expect(keys.length).toBeGreaterThan(0); // sessions + cache + counters were created above
    const offenders = keys.filter((k) => !/^hp:(session|ratelimit|cache):/.test(k));
    expect(offenders).toEqual([]);
  });
});
