// tests/helpers/httpHarness.js — the st-security lane's deterministic Supertest harness,
// in one place.
//
// DETERMINISM (verification round 2 — finding STS-R2-01)
// Supertest's default `request(expressApp)` binds a throwaway server to the WILDCARD address
// ('::') and then connects to 127.0.0.1. The loopback ephemeral-port space is machine-global,
// and a SPECIFIC 127.0.0.1 bind shadows a wildcard one for 127.0.0.1 clients, so whenever any
// other process on the host already holds 127.0.0.1:<the port jest was handed> — a sibling
// verifier lane, tests/rt-lt-resilience/lt01-race.test.js / lt01-run.js (both bind
// '127.0.0.1'), an editor helper, a local model server — the request silently lands on THAT
// server. Observed in the st-security lane on unchanged code: `read ECONNRESET`, a 200 whose
// body has no `user`, and a registration that created no row. Binding the specific loopback
// address ourselves is unshadowable (a second 127.0.0.1 bind gets EADDRINUSE, so the port is
// never handed out twice), so every request goes over a socket that can only reach OUR app.
'use strict';

const http = require('http');

/** A logger with the app's logger shape that emits nothing (keeps test output readable). */
function quietLogger() {
  const noop = () => {};
  const l = { info: noop, warn: noop, error: noop, debug: noop, child: () => l, audit: noop };
  return l;
}

/**
 * Tracks every server it binds so the owning test file can close them all in ONE afterAll.
 * Usage:
 *   const binder = serverBinder();
 *   afterAll(() => binder.closeAll());
 *   const listener = binder.bind(app);          // pass `listener` to supertest's request()
 */
function serverBinder() {
  const bound = [];
  return {
    bind(target) {
      const server = http.createServer(target).listen(0, '127.0.0.1');
      bound.push(server);
      return server;
    },
    async closeAll() {
      for (const s of bound) await new Promise((resolve) => s.close(resolve));
    },
  };
}

module.exports = { quietLogger, serverBinder };
