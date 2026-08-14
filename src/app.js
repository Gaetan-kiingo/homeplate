// U1-HTTP — Express app factory. `createApp()` returns the fully configured app that
// src/server.js binds to the TLS listener and that Supertest drives directly in the suite.
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-03, AB-05 — transport enforcement mounted before parsing and routing: plain HTTP
//                   is refused 403 'HTTPS required'; the relaxation flag fails closed in
//                   production (src/middleware/security.js, ST-01).
//   NFR-08        — correlation ids on every request (src/middleware/requestContext.js,
//                   U1-OBS), every error — including 404/405 and malformed bodies — leaves
//                   as a structured JSON envelope through the shared error handler
//                   (src/middleware/errorHandler.js, U1-OBS); never an HTML error page.
//   NFR-11        — JSON body limit at the boundary, hardening headers, x-powered-by
//                   disabled; field-level input validation happens in module routes via
//                   the U1-VALID layer.
//   ADR-001       — nothing reachable from a request handler imports src/adapters/*.
//
// Middleware order (deliberate, tested):
//   requestContext -> securityHeaders -> enforceTls -> GET /health (liveness, NFR-09)
//   -> parsers -> module routes -> 404/405 -> boundary-error conversion -> errorHandler
'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const { securityHeaders, enforceTls } = require('./middleware/security');
const requestContext = require('./middleware/requestContext');
const validate = require('./middleware/validate');
const { noInput } = require('./schemas/auth');
const errorHandler = require('./middleware/errorHandler');
const { AppError, NotFoundError } = require('./lib/errors');
const { logger: baseLogger } = require('./lib/logger');
const { mountModuleRoutes, notFoundHandler } = require('./routes');

// Request bodies are JSON only and small (NFR-11 boundary hardening; media bytes go to
// object storage through the media service, never through this parser — ADR-004).
const JSON_BODY_LIMIT = '1mb';

/** Shared U1-OBS logger unless a test injects a recorder. */
function resolveLogger(injected) {
  return injected || baseLogger;
}

/**
 * Error factory for the terminal 404/405 handler (src/routes/index.js): produces
 * U1-OBS AppError instances so the shared error handler renders them as operational
 * JSON errors with their status and code (NFR-08).
 */
function buildError(status, code, message) {
  if (status === 404) return new NotFoundError(message);
  return new AppError(message, { status, code, retryable: false });
}

// Machine-readable codes for the body-parser failures this app's own boundary can raise.
const BOUNDARY_ERROR_CODES = {
  'entity.parse.failed': 'MALFORMED_JSON',
  'entity.too.large': 'PAYLOAD_TOO_LARGE',
  'encoding.unsupported': 'UNSUPPORTED_ENCODING',
  'charset.unsupported': 'UNSUPPORTED_CHARSET',
  'request.aborted': 'REQUEST_ABORTED',
  'parameters.too.many': 'TOO_MANY_PARAMETERS',
};

/**
 * Converts the 4xx errors raised by the parsers THIS factory mounts (express.json —
 * http-errors marked `expose: true`) into AppError instances, so a malformed body is a
 * structured 4xx JSON error, not a generic 500 (NFR-08, NFR-11). Anything else passes
 * through untouched for the shared handler to classify.
 */
function boundaryErrorConverter() {
  return function convertBoundaryError(err, req, res, next) {
    if (err instanceof AppError) return next(err);
    const status = Number(err && (err.status || err.statusCode));
    if (err && err.expose === true && Number.isInteger(status) && status >= 400 && status < 500) {
      const code = BOUNDARY_ERROR_CODES[err.type] || 'BAD_REQUEST';
      return next(new AppError(err.message, { status, code, retryable: false, cause: err }));
    }
    return next(err);
  };
}

/**
 * Build the configured Express app.
 * @param {object} [options]
 * @param {object} [options.config]     injected config (tests); defaults to src/config,
 *                                      whose loader fails fast on an invalid environment
 * @param {object} [options.logger]     injected logger (tests); defaults to the shared
 *                                      U1-OBS logger
 * @param {string} [options.modulesDir] module root override for registry tests only
 * @returns {import('express').Application}
 */
function createApp(options = {}) {
  // Lazy so that test injection never forces an env load.
  const config = options.config || require('./config');
  const logger = resolveLogger(options.logger);

  const app = express();
  app.disable('x-powered-by'); // NFR-11 — no stack fingerprinting
  app.set('etag', false); // JSON API — caching is Redis's job (SRS §2.4), not conditional GETs

  // 1. Correlation ids first so even refusals are traceable (NFR-08).
  app.use(requestContext({ logger }));

  // 2. Hardening headers on EVERY response, then transport enforcement (NFR-03, ST-01).
  app.use(securityHeaders());
  app.use(enforceTls(config)); // throws here if production + relaxed (fails closed)

  // 3. Liveness probe (NFR-09; load-test smoke target for NFR-01/NFR-02 — LT-01/LT-02,
  //    tests/load/smoke.js). Unauthenticated and dependency-free: it must answer from the
  //    process alone — no PostgreSQL, no Redis, no adapter (ADR-001) — so it reports HTTP
  //    liveness, not dependency readiness. Mounted after enforceTls on purpose: plain HTTP
  //    is refused even here (NFR-03, ST-01). Input-less like GET /me and POST /logout, so
  //    it declares the shared noInput query schema — the NFR-11 route enumeration
  //    (st-security) requires EVERY mounted route to carry a U1-VALID validator, the
  //    dependency-free liveness probe included.
  app.get('/health', validate({ query: noInput }), (req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  // 4. Boundary parsing — only after the transport guard.
  app.use(express.json({ limit: JSON_BODY_LIMIT }));
  app.use(cookieParser());

  // 5. Module routes via the registry (missing modules warned, never fatal).
  const routes = mountModuleRoutes(app, { logger, modulesDir: options.modulesDir });
  app.locals.routes = routes;

  // 6. Terminal 404/405 -> shared error handler: everything leaves as JSON (NFR-08).
  app.use(notFoundHandler({ buildError }));
  app.use(boundaryErrorConverter());
  app.use(errorHandler({ logger }));

  return app;
}

module.exports = { createApp, resolveLogger };
