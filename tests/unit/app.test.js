// U1-HTTP unit tests — Express app factory, HTTPS/TLS enforcement, security headers,
// route registry (NFR-03, NFR-08, NFR-11, AB-05; ST-01).
//
// Sibling-safe by design: assertions never depend on which modules other waves have
// landed in src/modules (registry tests run against a fixture module tree) and 404/405
// body assertions accept any conformant JSON error shape (the shared U1-OBS error
// handler is used when on disk, the built-in fallback otherwise).
'use strict';

const fs = require('fs');
const http = require('http');
const https = require('https');
const os = require('os');
const path = require('path');
const tls = require('tls');
const { once } = require('events');
const { execFileSync } = require('child_process');
const request = require('supertest');

const ROOT = path.join(__dirname, '..', '..');
const baseConfig = require('../../src/config');
const { createApp } = require('../../src/app');
const {
  securityHeaders,
  enforceTls,
  HSTS_MAX_AGE_SECONDS,
} = require('../../src/middleware/security');
const { KNOWN_MODULES, mountModuleRoutes, notFoundHandler } = require('../../src/routes');
const { start, buildTlsOptions } = require('../../src/server');
const { validateEnv } = require('../../src/config/schema');

// ---- helpers ----------------------------------------------------------------------------------

function recordingLogger() {
  const calls = { info: [], warn: [], error: [] };
  const flat = (level) => calls[level].map((args) => args.map(String).join(' ')).join('\n');
  return {
    calls,
    flat,
    info: (...a) => calls.info.push(a),
    warn: (...a) => calls.warn.push(a),
    error: (...a) => calls.error.push(a),
    child() {
      return this;
    },
  };
}

/** Plain-object copy of the frozen config with server-level overrides applied. */
function configWith(serverOverrides, rootOverrides = {}) {
  return {
    ...baseConfig,
    ...rootOverrides,
    server: { ...baseConfig.server, ...serverOverrides },
  };
}

/**
 * Fixture module tree for the route registry. Files are written outside the repo and
 * require express by absolute resolved path (tmpdir is outside the node_modules tree).
 */
function writeFixtureModules() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-routes-'));
  const expressPath = JSON.stringify(require.resolve('express'));
  fs.mkdirSync(path.join(dir, 'auth'));
  fs.writeFileSync(
    path.join(dir, 'auth', 'routes.js'),
    `'use strict';
const express = require(${expressPath});
const router = express.Router();
router.get('/ping', (req, res) => {
  global.__hpAuthPingHits = (global.__hpAuthPingHits || 0) + 1;
  res.json({ ok: true });
});
router.post('/only-post', (req, res) => res.json({ posted: true }));
module.exports = router;
`
  );
  // users exports the { basePath, router } object shape of the registry contract.
  fs.mkdirSync(path.join(dir, 'users'));
  fs.writeFileSync(
    path.join(dir, 'users', 'routes.js'),
    `'use strict';
const express = require(${expressPath});
const router = express.Router();
router.get('/me', (req, res) => res.json({ me: true }));
module.exports = { basePath: '/api/custom-users', router };
`
  );
  return dir;
}

function writeMalformedModule() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hp-badroutes-'));
  fs.mkdirSync(path.join(dir, 'auth'));
  fs.writeFileSync(path.join(dir, 'auth', 'routes.js'), "'use strict';\nmodule.exports = {};\n");
  return dir;
}

function httpsGet(port, pathname, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        rejectUnauthorized: false, // self-signed dev cert
        agent: false,
        headers: { Connection: 'close' },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => {
          body += c;
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body,
            tlsProtocol: res.socket.getProtocol(),
          })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// ---- src/middleware/security.js ---------------------------------------------------------------

describe('U1-HTTP security middleware (NFR-03, NFR-11, AB-05)', () => {
  test('ST-01: HSTS floor constant is at least 15552000 seconds (180 days)', () => {
    expect(HSTS_MAX_AGE_SECONDS).toBeGreaterThanOrEqual(15552000);
  });

  test('transport relaxation FAILS CLOSED: enforceTls throws under production (NFR-03)', () => {
    expect(() =>
      enforceTls(configWith({ enforceHttps: false }, { isProduction: true, env: 'production' }))
    ).toThrow(/production/i);
  });

  test('transport relaxation fails closed at the config layer too (src/config/schema.js)', () => {
    // Same invariant one layer down: an env that relaxes transport in production is
    // rejected before a config object can even exist.
    expect(() =>
      validateEnv({
        NODE_ENV: 'production',
        ENFORCE_HTTPS: 'false',
        DATABASE_URL: 'postgres://x/x',
        REDIS_URL: 'redis://x',
        FIELD_ENCRYPTION_KEY: 'deadbeef'.repeat(8),
        OBJECT_STORAGE_ENDPOINT: 'http://x',
        OBJECT_STORAGE_BUCKET: 'b',
        OBJECT_STORAGE_ACCESS_KEY: 'k',
        OBJECT_STORAGE_SECRET_KEY: 's',
        NOTIFICATIONS_TRANSPORT: 'sendgrid',
        SENDGRID_API_KEY: 'k',
        SENDGRID_FROM_EMAIL: 'x@x',
        MAPS_MODE: 'live',
        MAPS_API_KEY: 'k',
        LLM_MODERATION_MODE: 'live',
        LLM_MODERATION_BASE_URL: 'https://x',
        LLM_MODERATION_API_KEY: 'k',
        MODERATION_MODEL: 'm',
      })
    ).toThrow(/ENFORCE_HTTPS/);
  });

  test('createApp refuses to construct with relaxed transport in production (fail closed)', () => {
    const logger = recordingLogger();
    expect(() =>
      createApp({
        logger,
        config: configWith({ enforceHttps: false }, { isProduction: true, env: 'production' }),
      })
    ).toThrow(/production/i);
  });

  test('enforceTls demands the config contract instead of defaulting open', () => {
    expect(() => enforceTls(undefined)).toThrow(/enforceHttps/);
    expect(() => enforceTls({ server: {} })).toThrow(/enforceHttps/);
  });

  test('securityHeaders() returns mountable middleware', () => {
    expect(typeof securityHeaders()).toBe('function');
  });
});

// ---- plain-HTTP refusal through the full app --------------------------------------------------

describe('U1-HTTP plain-HTTP refusal (NFR-03, AB-05, ST-01)', () => {
  let app;
  let fixtureDir;

  beforeAll(() => {
    fixtureDir = writeFixtureModules();
    app = createApp({
      logger: recordingLogger(),
      config: configWith({ enforceHttps: true }),
      modulesDir: fixtureDir,
    });
  });

  test("plain HTTP is refused 403 'HTTPS required' and never served content", async () => {
    global.__hpAuthPingHits = 0;
    const res = await request(app).get('/api/auth/ping');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: { code: 'HTTPS_REQUIRED', message: 'HTTPS required' } });
    // The mounted route handler must never run for an insecure request.
    expect(global.__hpAuthPingHits).toBe(0);
  });

  test('the refusal itself carries HSTS with max-age >= 15552000 (ST-01: every response)', async () => {
    const res = await request(app).get('/anything');
    expect(res.status).toBe(403);
    const hsts = res.headers['strict-transport-security'];
    expect(hsts).toBeDefined();
    const maxAge = Number(/max-age=(\d+)/.exec(hsts)[1]);
    expect(maxAge).toBeGreaterThanOrEqual(15552000);
  });
});

// ---- security headers on every response -------------------------------------------------------

describe('U1-HTTP security headers (NFR-11, ST-01)', () => {
  let app;

  beforeAll(() => {
    // Relaxed transport (test-mode flag) so requests traverse the full stack.
    app = createApp({
      logger: recordingLogger(),
      config: configWith({ enforceHttps: false }),
      modulesDir: writeFixtureModules(),
    });
  });

  test.each([
    ['200 on a mounted route', '/api/auth/ping', 200],
    ['404 on an unknown path', '/definitely/not/a/route', 404],
  ])('%s: nosniff, frame-deny, HSTS present; x-powered-by absent', async (_label, url, status) => {
    const res = await request(app).get(url);
    expect(res.status).toBe(status);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-powered-by']).toBeUndefined();
    // Correlation id on every response (NFR-08 — requestContext mounted first).
    expect(res.headers['x-correlation-id']).toBeTruthy();
    const hsts = res.headers['strict-transport-security'];
    expect(Number(/max-age=(\d+)/.exec(hsts)[1])).toBeGreaterThanOrEqual(15552000);
  });
});

// ---- route registry ---------------------------------------------------------------------------

describe('U1-HTTP route registry (build-plan §1 convention 2; NFR-08)', () => {
  test('the known module list is the full plan across all waves', () => {
    expect(KNOWN_MODULES).toHaveLength(14);
    for (const name of ['auth', 'users', 'eligibility', 'listings', 'bookings', 'privacy']) {
      expect(KNOWN_MODULES).toContain(name);
    }
  });

  test('mounts each module that exists, warns for each that does not', () => {
    const logger = recordingLogger();
    const app = createApp({
      logger,
      config: configWith({ enforceHttps: false }),
      modulesDir: writeFixtureModules(),
    });

    const { mounted, missing } = app.locals.routes;
    expect(mounted.map((m) => m.name).sort()).toEqual(['auth', 'users']);
    expect(missing.sort()).toEqual(
      KNOWN_MODULES.filter((n) => n !== 'auth' && n !== 'users').sort()
    );
    // One startup warning per absent module, naming its routes file (NFR-08).
    for (const name of missing) {
      expect(logger.flat('warn')).toContain(`src/modules/${name}/routes.js`);
    }
  });

  test('mounted routes serve; default and { basePath } mount points both work', async () => {
    const app = createApp({
      logger: recordingLogger(),
      config: configWith({ enforceHttps: false }),
      modulesDir: writeFixtureModules(),
    });
    const ping = await request(app).get('/api/auth/ping');
    expect(ping.status).toBe(200);
    expect(ping.body).toEqual({ ok: true });
    const me = await request(app).get('/api/custom-users/me');
    expect(me.status).toBe(200);
    expect(me.body).toEqual({ me: true });
  });

  test('a present-but-malformed routes module fails the boot, never a silent skip', () => {
    expect(() =>
      createApp({
        logger: recordingLogger(),
        config: configWith({ enforceHttps: false }),
        modulesDir: writeMalformedModule(),
      })
    ).toThrow(/must export an Express router/);
  });

  test('mountModuleRoutes is callable directly against any app (registry contract)', () => {
    const express = require('express');
    const app = express();
    const logger = recordingLogger();
    const summary = mountModuleRoutes(app, { logger, modulesDir: writeFixtureModules() });
    expect(summary.mounted.map((m) => m.basePath)).toEqual(['/api/auth', '/api/custom-users']);
    expect(typeof notFoundHandler({ buildError: () => new Error('x') })).toBe('function');
  });
});

// ---- 404 / 405 as JSON ------------------------------------------------------------------------

describe('U1-HTTP 404/405 JSON errors (NFR-08)', () => {
  let app;

  beforeAll(() => {
    app = createApp({
      logger: recordingLogger(),
      config: configWith({ enforceHttps: false }),
      modulesDir: writeFixtureModules(),
    });
  });

  test('unknown path -> 404 JSON error envelope with NOT_FOUND code', async () => {
    const res = await request(app).get('/api/auth/nope');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toMatch(/not.?found/i);
  });

  test('known path, wrong method -> 405 with Allow header (RFC 9110)', async () => {
    const res = await request(app).post('/api/auth/ping');
    expect(res.status).toBe(405);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('METHOD_NOT_ALLOWED');
    const allow = res.headers.allow.split(/,\s*/);
    expect(allow).toContain('GET');
    expect(allow).toContain('HEAD');
    expect(allow).not.toContain('POST');
  });

  test('GET-only route still serves HEAD (Express semantics, not 405)', async () => {
    const res = await request(app).head('/api/auth/ping');
    expect(res.status).toBe(200);
  });

  test('POST-only route rejects GET with Allow: POST', async () => {
    const res = await request(app).get('/api/auth/only-post');
    expect(res.status).toBe(405);
    expect(res.headers.allow).toBe('POST');
  });

  test('malformed JSON body -> 400 MALFORMED_JSON, not a 500 or HTML page (NFR-11)', async () => {
    const res = await request(app)
      .post('/api/auth/only-post')
      .set('Content-Type', 'application/json')
      .send('{"broken":');
    expect(res.status).toBe(400);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.body.error.code).toBe('MALFORMED_JSON');
  });
});

// ---- createApp() no-arg contract (scripts/check-build.js boots it this way) -------------------

describe('U1-HTTP createApp() default boot', () => {
  test('boots with no arguments against the test environment', async () => {
    const app = createApp();
    expect(typeof app.use).toBe('function');
    // Path chosen so the assertion holds no matter which sibling modules have landed.
    const res = await request(app).get('/__u1_http_no_such_route__');
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
  });
});

// ---- src/server.js — TLS listener (NFR-03, AB-05, ST-01) --------------------------------------

describe('U1-HTTP TLS entrypoint (NFR-03, AB-05, ST-01)', () => {
  beforeAll(() => {
    // Idempotent: writes certs/ only when absent. Also proves the script runs clean.
    execFileSync('sh', [path.join(ROOT, 'scripts', 'gen-dev-certs.sh')], { cwd: ROOT });
  });

  test('gen-dev-certs.sh wrote the self-signed material into git-ignored certs/', () => {
    expect(fs.existsSync(path.join(ROOT, 'certs', 'dev-cert.pem'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'certs', 'dev-key.pem'))).toBe(true);
    const gitignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    expect(gitignore).toMatch(/^certs\/$/m);
  });

  test("TLS options pin minVersion: 'TLSv1.2' — object and source literal (ST-01)", () => {
    const options = buildTlsOptions(configWith({}));
    expect(options.minVersion).toBe('TLSv1.2');
    expect(Buffer.isBuffer(options.cert)).toBe(true);
    expect(Buffer.isBuffer(options.key)).toBe(true);
    const source = fs.readFileSync(path.join(ROOT, 'src', 'server.js'), 'utf8');
    expect(source).toMatch(/minVersion:\s*'TLSv1\.2'/);
  });

  test('missing TLS material refuses to start with a remediation hint', () => {
    expect(() =>
      buildTlsOptions(
        configWith({ tls: { certPath: 'certs/nope.pem', keyPath: 'certs/nope-key.pem' } })
      )
    ).toThrow(/gen-dev-certs/);
  });

  describe('live HTTPS server', () => {
    let server;
    let port;

    beforeAll(async () => {
      server = start({
        logger: recordingLogger(),
        config: configWith({ enforceHttps: true, port: 0 }),
      });
      await once(server, 'listening');
      port = server.address().port;
    });

    afterAll(async () => {
      if (server && server.listening) {
        await new Promise((resolve) => server.close(resolve));
      }
    });

    test('serves JSON over TLS >= 1.2 with HSTS on the wire', async () => {
      const res = await httpsGet(port, '/__u1_http_no_such_route__');
      expect(res.status).toBe(404);
      expect(['TLSv1.2', 'TLSv1.3']).toContain(res.tlsProtocol);
      expect(res.headers['content-type']).toMatch(/application\/json/);
      const hsts = res.headers['strict-transport-security'];
      expect(Number(/max-age=(\d+)/.exec(hsts)[1])).toBeGreaterThanOrEqual(15552000);
    });

    test('a plain-HTTP client gets no HTTP response at all from the TLS port', async () => {
      await expect(
        new Promise((resolve, reject) => {
          const req = http.request(
            { host: '127.0.0.1', port, path: '/', agent: false, headers: { Connection: 'close' } },
            (res) => resolve(`unexpected HTTP ${res.statusCode}`)
          );
          req.setTimeout(4000, () => req.destroy(new Error('timeout — no response, as required')));
          req.on('error', reject);
          req.end();
        })
      ).rejects.toThrow();
    });

    test('a TLS 1.1 handshake is refused (minVersion TLSv1.2)', async () => {
      await expect(
        new Promise((resolve, reject) => {
          const socket = tls.connect(
            {
              host: '127.0.0.1',
              port,
              minVersion: 'TLSv1',
              maxVersion: 'TLSv1.1',
              rejectUnauthorized: false,
            },
            () => {
              const proto = socket.getProtocol();
              socket.destroy();
              resolve(proto);
            }
          );
          socket.setTimeout(4000, () => socket.destroy(new Error('timeout')));
          socket.on('error', reject);
        })
      ).rejects.toThrow();
    });
  });
});
