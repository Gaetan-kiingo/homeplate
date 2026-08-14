// src/middleware/validate.js — the ONE shared request-validation middleware (U1-VALID, wave 1).
//
// Traceability: NFR-11 ("every route declares a schema (body, query, params) enforced by one
// shared validation middleware; type/length/range violations return 422 with field-level
// errors and no stack trace; unknown properties are stripped"), AB-06 (injection payloads are
// either rejected as shape violations or passed on as inert data — parameterized SQL is the
// SQLi defense, so hostile strings must NOT cause a 500 here), ADR-006 (validation at the
// API boundary).
//
// Contract (build-plan "Public interfaces"):
//   validate({ body, query, params }) -> Express middleware
//     - each part is a zod schema; misdeclared routes throw a TypeError at DEFINITION time
//       (i.e. at boot, when the router file is loaded), never at request time;
//     - on success, req.body/req.query/req.params are replaced with the PARSED output
//       (unknown keys stripped by zod object semantics, coercions and defaults applied);
//     - on failure, responds 422 with field-level errors and never calls next();
//     - values of password/secret-like fields are redacted from error output;
//     - no code path ever leaks a stack trace to the client.
//
// Route enumeration support: the returned middleware is marked `isValidator = true` and
// carries its frozen `schemas`, so the NFR-11 conformance lane can walk the Express router
// and fail any route that lacks a declared schema.
'use strict';

const PARTS = ['params', 'query', 'body'];

// Field names whose values (and zod's sometimes value-echoing messages) must never appear
// in a response. Matched against every segment of the issue path, case-insensitively.
const SENSITIVE_KEY_RE = /password|passwd|secret|token|credential|apikey|api_key/i;

const REDACTED_MESSAGE = 'Invalid value';

/** Best-effort structured logging without a hard dependency on the wave-1 sibling logger
 *  (U1-OBS). Falls back to console.error; never throws. */
function logInternalError(err, req) {
  try {
    // eslint-disable-next-line global-require
    const loggerModule = require('../lib/logger');
    const logger = loggerModule && (loggerModule.logger || loggerModule);
    if (logger && typeof logger.error === 'function') {
      logger.error(
        { err, method: req.method, path: req.originalUrl },
        'validate: schema evaluation failed'
      );
      return;
    }
  } catch (_requireFailed) {
    // U1-OBS not on disk yet (parallel wave) or unloadable — fall through to console.
  }
  console.error('validate: schema evaluation failed:', err && err.message);
}

/** Map one zod issue to a client-safe field error. Only path/code/message are exposed —
 *  never the received value, never internals — and messages under sensitive keys are
 *  replaced wholesale (NFR-11 "redacts password fields from error output"). */
function formatIssue(part, issue) {
  const segments = issue.path.map(String);
  const sensitive = segments.some((segment) => SENSITIVE_KEY_RE.test(segment));
  return {
    path: [part, ...segments].join('.'),
    code: issue.code,
    message: sensitive ? REDACTED_MESSAGE : issue.message,
  };
}

/** Replace a request part with its parsed value. Express 4 defines req.query via a
 *  prototype getter, so plain assignment would throw under strict mode — defineProperty
 *  shadows it safely and uniformly for all three parts. */
function setPart(req, part, value) {
  Object.defineProperty(req, part, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

/**
 * validate({ body, query, params }) — build the validation middleware for one route.
 *
 * @param {{body?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny,
 *          params?: import('zod').ZodTypeAny}} schemas at least one part is required
 * @returns {import('express').RequestHandler}
 */
function validate(schemas) {
  // ---- definition-time checks: a misdeclared route must fail at boot, not in production --
  if (schemas === null || typeof schemas !== 'object' || Array.isArray(schemas)) {
    throw new TypeError('validate(schemas): expected an object like { body, query, params }');
  }
  const unknownParts = Object.keys(schemas).filter((key) => !PARTS.includes(key));
  if (unknownParts.length > 0) {
    throw new TypeError(
      `validate(schemas): unknown part(s) ${unknownParts.join(', ')} — ` +
        'only "body", "query" and "params" are validated'
    );
  }
  const declaredParts = PARTS.filter((part) => schemas[part] !== undefined);
  if (declaredParts.length === 0) {
    throw new TypeError(
      'validate(schemas): at least one of { body, query, params } must carry a schema'
    );
  }
  for (const part of declaredParts) {
    const schema = schemas[part];
    if (!schema || typeof schema.safeParse !== 'function') {
      throw new TypeError(
        `validate(schemas): "${part}" must be a zod schema (got ${typeof schema})`
      );
    }
  }

  const middleware = function validateRequest(req, res, next) {
    try {
      const fields = [];
      const parsed = {};
      for (const part of declaredParts) {
        const result = schemas[part].safeParse(req[part]);
        if (result.success) {
          parsed[part] = result.data;
        } else {
          for (const issue of result.error.issues) {
            fields.push(formatIssue(part, issue));
          }
        }
      }
      if (fields.length > 0) {
        // Field-level 422; built exclusively from formatIssue output, so it can never
        // carry a stack trace or a redacted value (NFR-11).
        return res.status(422).json({
          error: {
            code: 'VALIDATION_FAILED',
            message: 'Request validation failed.',
            status: 422,
            fields,
          },
        });
      }
      for (const part of declaredParts) {
        setPart(req, part, parsed[part]);
      }
      return next();
    } catch (err) {
      // A throwing schema is a programming error, not client input; respond generically so
      // no stack trace or internal message can leak (NFR-11), and log server-side.
      logInternalError(err, req);
      if (res.headersSent) {
        return next(err);
      }
      return res.status(500).json({
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred.', status: 500 },
      });
    }
  };

  // Router-enumeration support for the NFR-11 conformance check.
  middleware.isValidator = true;
  middleware.schemas = Object.freeze({ ...schemas });
  return middleware;
}

module.exports = validate;
module.exports.validate = validate;
