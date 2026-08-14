// src/outbox/dispatch.js — U2-OUTBOX: handler discovery and the dispatch registry.
//
// Requirement traceability (SRS Appendix B):
//   FR-13  — deferred booking/notification work is executed by handlers discovered here and
//            invoked by the worker, never inline in a request handler (ADR-001/003).
//   NFR-09 — per-service adapters are reached ONLY through these handlers, so a provider
//            outage is absorbed by the worker's retry/backoff instead of failing requests.
//
// Discovery contract (build-plan §1 convention 3): every src/outbox/handlers/*.js exports
//   { type: 'some.jobType', handle: async (payload, ctx) => {} }
// Feature units own individual handler files, so no shared registry file is ever edited by
// two units. ctx carries { jobId, type, attempt, correlationId, idempotencyKey, log } — the
// correlationId is the originating request's (NFR-08), and idempotencyKey is what makes a
// redelivered job safe to handle twice (RT-02).
//
// Handlers (and ONLY handlers/worker code) may import src/adapters/* — request handlers never
// do (ADR-001/003; enforced by the adr-conformance lane).
//
// Public interface (build-plan wave-2 contract):
//   loadHandlers({ dir, log })  → registry (reads *.js from src/outbox/handlers by default)
//   createRegistry(handlers)    → registry from in-memory handler objects (tests, embedding)
//   registry.get(type) / has(type) / types() / size
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_HANDLERS_DIR = path.join(__dirname, 'handlers');

/** Validates the { type, handle } handler shape; `source` names the offender in errors. */
function validateHandler(handler, source) {
  if (!handler || typeof handler !== 'object') {
    throw new TypeError(`outbox handler ${source}: module.exports must be { type, handle }`);
  }
  if (typeof handler.type !== 'string' || !/^[a-z][a-z0-9_.-]{0,199}$/i.test(handler.type)) {
    throw new TypeError(
      `outbox handler ${source}: "type" must be a short identifier string (got ${JSON.stringify(
        handler.type
      )})`
    );
  }
  if (typeof handler.handle !== 'function') {
    throw new TypeError(`outbox handler ${source}: "handle" must be a function(payload, ctx)`);
  }
  return handler;
}

/**
 * Build an immutable dispatch registry from handler objects. Duplicate types are a
 * configuration error and throw at startup — never a silent last-one-wins.
 */
function createRegistry(handlers = []) {
  if (!Array.isArray(handlers)) {
    throw new TypeError('createRegistry: handlers must be an array of { type, handle }');
  }
  const byType = new Map();
  for (const handler of handlers) {
    validateHandler(handler, `"${handler && handler.type}"`);
    if (byType.has(handler.type)) {
      throw new Error(`duplicate outbox handler for type "${handler.type}"`);
    }
    byType.set(handler.type, handler);
  }
  return Object.freeze({
    get: (type) => byType.get(type),
    has: (type) => byType.has(type),
    types: () => [...byType.keys()].sort(),
    size: byType.size,
  });
}

/**
 * Discover handlers from `dir` (default src/outbox/handlers) at startup. Every *.js file is
 * required and validated; a malformed or unloadable handler ABORTS startup — a worker running
 * with a silently dropped handler would strand its jobs until dead-letter (NFR-09).
 * An empty directory is valid: wave 2 ships the mechanism before most feature handlers exist.
 */
function loadHandlers({ dir = DEFAULT_HANDLERS_DIR, log } = {}) {
  const files = fs.existsSync(dir)
    ? fs
        .readdirSync(dir)
        .filter((f) => f.endsWith('.js') && !f.endsWith('.test.js'))
        .sort()
    : [];
  const handlers = files.map((file) => {
    const fullPath = path.join(dir, file);
    let mod;
    try {
      mod = require(fullPath);
    } catch (err) {
      const wrapped = new Error(`outbox handler ${file} failed to load: ${err.message}`);
      wrapped.cause = err;
      throw wrapped;
    }
    return validateHandler(mod, file);
  });
  const registry = createRegistry(handlers);
  if (log && typeof log.info === 'function') {
    log.info(
      { event: 'outbox_handlers_loaded', count: registry.size, types: registry.types() },
      'outbox_handlers_loaded'
    );
  }
  return registry;
}

module.exports = { loadHandlers, createRegistry, validateHandler, DEFAULT_HANDLERS_DIR };
