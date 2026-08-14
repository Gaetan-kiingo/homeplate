// src/middleware/requestContext.js — U1-OBS correlation-ID assignment and propagation
// (build-plan wave 1).
//
// Requirement traceability (SRS Appendix B):
//   NFR-08 (MT-01) — every request gets a correlation ID (honouring a well-formed incoming
//                    X-Correlation-Id / X-Request-Id, else a fresh UUID), echoed back in the
//                    X-Correlation-Id response header, bound into `req.log` via
//                    logger.child({ correlationId }) and stored in AsyncLocalStorage so any
//                    code on the request path — including the outbox enqueue (U2-OUTBOX) —
//                    can read the SAME ID and carry it into worker log lines. Each response
//                    also emits one structured completion line (method, path, status,
//                    durationMs, userId) — IDs only, query string stripped (SRS §3.4).
//
// Usage (U1-HTTP): app.use(requestContext)             — defaults
//                  app.use(requestContext({ logger })) — injected logger (tests)
// Worker code:     requestContext.run({ correlationId, log }, fn) to scope a job;
//                  requestContext.getCorrelationId() anywhere below.
'use strict';

const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const { logger: baseLogger } = require('../lib/logger');

const CORRELATION_HEADER = 'x-correlation-id';
const FALLBACK_HEADER = 'x-request-id';
// Accept only safe, bounded IDs from the wire; anything else is replaced, never trusted.
const CORRELATION_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;

const storage = new AsyncLocalStorage();

function makeMiddleware({ logger = baseLogger } = {}) {
  return function requestContextMiddleware(req, res, next) {
    const incoming = req.headers[CORRELATION_HEADER] || req.headers[FALLBACK_HEADER];
    const correlationId =
      typeof incoming === 'string' && CORRELATION_ID_PATTERN.test(incoming)
        ? incoming
        : crypto.randomUUID();

    req.correlationId = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);
    req.log = logger.child({ correlationId });

    const startedAt = process.hrtime.bigint();
    res.on('finish', () => {
      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      req.log.info(
        {
          event: 'http_request',
          method: req.method,
          // Path only — query strings may carry personal data (SRS §3.4 PII register).
          path: (req.originalUrl || req.url || '').split('?')[0],
          status: res.statusCode,
          durationMs: Math.round(durationMs * 1000) / 1000,
          userId: req.auth && req.auth.userId,
        },
        'http_request'
      );
    });

    storage.run({ correlationId, log: req.log }, next);
  };
}

/**
 * Dual-mode export: usable directly as middleware (`app.use(requestContext)`) or as a
 * factory (`app.use(requestContext({ logger }))`).
 */
function requestContext(reqOrOptions, res, next) {
  if (typeof next === 'function') {
    return makeMiddleware()(reqOrOptions, res, next);
  }
  return makeMiddleware(reqOrOptions || {});
}

/** The current request/job context ({ correlationId, log }) or undefined outside one. */
requestContext.getContext = function getContext() {
  return storage.getStore();
};

/** Correlation ID for the active request/job — outbox payload stamping (NFR-08). */
requestContext.getCorrelationId = function getCorrelationId() {
  const store = storage.getStore();
  return store ? store.correlationId : undefined;
};

/** Context-bound logger, falling back to the shared instance outside a request. */
requestContext.getLogger = function getLogger() {
  const store = storage.getStore();
  return (store && store.log) || baseLogger;
};

/** Establishes a context for non-HTTP work (outbox worker jobs — ADR-003). */
requestContext.run = function run(context, fn) {
  const correlationId = (context && context.correlationId) || crypto.randomUUID();
  const log = (context && context.log) || baseLogger.child({ correlationId });
  return storage.run({ correlationId, log }, fn);
};

requestContext.CORRELATION_HEADER = CORRELATION_HEADER;
requestContext.middleware = makeMiddleware;

module.exports = requestContext;
