// src/middleware/errorHandler.js — U1-OBS terminal Express error middleware
// (build-plan wave 1).
//
// Requirement traceability (SRS Appendix B):
//   NFR-08 (MT-01) — every error is logged as structured JSON with message, stack, HTTP
//                    status, machine-readable code and the request's correlationId (via
//                    req.log). The HTTP response is a JSON error envelope
//                    { error: { code, message, correlationId, details? } } and NEVER
//                    contains a stack trace or internal message text for unexpected errors.
//   SRS §3.4 PII register — unexpected (non-AppError) messages are replaced with a generic
//                    string in the response; the logger pipeline scrubs emails from logged
//                    messages/stacks as defence in depth.
//
// Usage (U1-HTTP): app.use(errorHandler)             — defaults
//                  app.use(errorHandler({ logger })) — injected logger (tests)
// NOTE: the export keeps arity 4 so Express recognises it as error middleware.
'use strict';

const { AppError } = require('../lib/errors');
const { logger: baseLogger } = require('../lib/logger');

function makeErrorHandler({ logger = baseLogger } = {}) {
  return function errorHandlerMiddleware(err, req, res, next) {
    const log = (req && req.log) || logger;
    const correlationId = req && req.correlationId;
    const isOperational = err instanceof AppError;
    const status = isOperational && Number.isInteger(err.status) ? err.status : 500;
    const code = isOperational && err.code ? err.code : 'INTERNAL_ERROR';

    // Full detail into the logs (NFR-08): message + stack + correlationId + status.
    // The `err` serializer in src/lib/logger.js emits { type, message, stack, ... }.
    const level = status >= 500 ? 'error' : 'warn';
    log[level](
      { event: 'request_error', status, code, correlationId, err },
      err && err.message ? err.message : 'request failed'
    );

    if (res.headersSent) {
      // Response already streaming — delegate to Express' default teardown.
      return next(err);
    }

    // Operational errors expose their (PII-free) message; unexpected errors never leak
    // internals — stable generic message, stack stays in the logs only.
    const message = isOperational ? err.message : 'Internal server error';
    const bodyError = { code, message, correlationId };
    if (isOperational && err.details !== undefined) bodyError.details = err.details;
    res.status(status).json({ error: bodyError });
  };
}

/**
 * Dual-mode export with arity 4: usable directly (`app.use(errorHandler)`) or as a
 * factory (`app.use(errorHandler({ logger }))`).
 */
module.exports = function errorHandler(errOrOptions, req, res, next) {
  if (typeof next === 'function') {
    return makeErrorHandler()(errOrOptions, req, res, next);
  }
  return makeErrorHandler(errOrOptions || {});
};

module.exports.middleware = makeErrorHandler;
