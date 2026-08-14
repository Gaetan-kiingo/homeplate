// U1-HTTP — transport security middleware: HTTPS/TLS enforcement and security headers.
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-03, AB-05 — all traffic over HTTPS/TLS 1.2+; plain HTTP is REFUSED with
//                   403 'HTTPS required' and never served content (ADR-006, ST-01).
//                   The test-mode relaxation flag (config.server.enforceHttps=false)
//                   FAILS CLOSED: constructing the middleware with that flag under
//                   NODE_ENV=production throws instead of starting insecurely.
//   NFR-08        — refusals are structured JSON errors, not opaque hang-ups.
//   NFR-11        — hardening headers (nosniff, frame-deny, restrictive CSP, no
//                   x-powered-by fingerprint) on every response.
//   ST-01         — Strict-Transport-Security max-age >= 15552000 on EVERY response,
//                   including refusals and errors.
//
// The TLS listener itself (minVersion: 'TLSv1.2') lives in src/server.js; this module is
// the request-level guard so that even a mis-bound plain-HTTP listener can never serve
// application content.
'use strict';

const helmet = require('helmet');

// ST-01 floor: 180 days. Asserted literally by tests/unit/app.test.js — do not lower.
const HSTS_MAX_AGE_SECONDS = 15552000;

/**
 * Security headers on every response (helmet, pinned to the Homeplate policy):
 *  - Strict-Transport-Security: max-age=15552000; includeSubDomains  (NFR-03, ST-01)
 *  - X-Content-Type-Options: nosniff                                 (NFR-11)
 *  - X-Frame-Options: DENY                                           (NFR-11)
 *  - Content-Security-Policy: default-src 'none'; frame-ancestors 'none'
 *    (this process serves a JSON API only — the React client is a separate bundle)
 * helmet also removes the X-Powered-By fingerprint; src/app.js additionally disables it
 * at the Express level so the header cannot reappear if middleware order changes.
 */
function securityHeaders() {
  return helmet({
    hsts: { maxAge: HSTS_MAX_AGE_SECONDS, includeSubDomains: true },
    frameguard: { action: 'deny' },
    contentSecurityPolicy: {
      useDefaults: false,
      directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
    },
    // JSON API: cross-origin embedding of responses is never legitimate.
    crossOriginResourcePolicy: { policy: 'same-origin' },
  });
}

/**
 * HTTPS enforcement (NFR-03, AB-05). Returns middleware that refuses any request not
 * carried over TLS with 403 { error: { code: 'HTTPS_REQUIRED', message: 'HTTPS required' } }
 * — before body parsing, before any route, so plain HTTP is never served content.
 *
 * `req.secure` is authoritative: X-Forwarded-Proto is deliberately NOT trusted because
 * v1.0 terminates TLS in-process (src/server.js). If a TLS-terminating proxy is ever put
 * in front, enable Express `trust proxy` in src/app.js as a reviewed change — never by
 * trusting the header unconditionally.
 *
 * Relaxation (Supertest drives the Express app over plain HTTP) is the explicit
 * config flag `server.enforceHttps=false` — and it FAILS CLOSED: under production this
 * factory throws, so an app with relaxed transport can never be constructed
 * (defense in depth with src/config/schema.js, which rejects the same combination
 * at env-validation time).
 */
function enforceTls(config) {
  if (!config || !config.server || typeof config.server.enforceHttps !== 'boolean') {
    throw new Error(
      'enforceTls(config) needs config.server.enforceHttps (src/config contract, NFR-03)'
    );
  }
  const isProduction =
    typeof config.isProduction === 'boolean' ? config.isProduction : config.env === 'production';

  if (!config.server.enforceHttps) {
    if (isProduction) {
      // Fail closed (NFR-03, AB-05): a production process must never start with
      // transport enforcement off.
      throw new Error(
        'Refusing to construct the app: server.enforceHttps=false is not allowed when ' +
          'NODE_ENV=production (NFR-03, AB-05 — HTTPS/TLS 1.2+ fails closed)'
      );
    }
    // Explicit relaxation for local tooling and the automated suite only.
    return function tlsEnforcementDisabled(req, res, next) {
      next();
    };
  }

  return function requireTls(req, res, next) {
    if (req.secure) return next();
    // Refuse — never redirect, never serve content over plain HTTP (ST-01).
    res.status(403).json({ error: { code: 'HTTPS_REQUIRED', message: 'HTTPS required' } });
  };
}

module.exports = { securityHeaders, enforceTls, HSTS_MAX_AGE_SECONDS };
