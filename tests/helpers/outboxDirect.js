// tests/helpers/outboxDirect.js — run a REAL outbox handler for specific rows WITHOUT the
// worker claim path, in one place.
//
// handler.handle(payload, ctx) is invoked directly, so the shared outbox_jobs table is
// neither claimed nor mutated: nothing here depends on — or disturbs — another suite's queue
// state (tests/helpers/env.js CONCURRENCY RULE), and rows a handler enqueues in its OWN
// transaction keep their xmin (the worker's retry UPDATE would rewrite it and destroy the
// same-transaction evidence several FR-13/ADR-001 tests assert).
'use strict';

const dispatch = require('../../src/outbox/dispatch');
const mockTransport = require('../../src/adapters/mockTransport');
const { logger } = require('../../src/lib/logger');

/** The ctx the worker would build for a first delivery attempt of this row. */
function ctxFor(job) {
  return {
    jobId: job.id,
    type: job.type,
    attempt: 1,
    correlationId: job.correlation_id,
    idempotencyKey: job.dedupe_key,
    log: logger.child({ correlationId: job.correlation_id }),
  };
}

/**
 * Run the real handler for each outbox row, one at a time, in the given order.
 * Throws exactly where the worker would record a failure — callers that assert the
 * failure path should catch.
 *
 * @param {object[]} rows full outbox_jobs rows (payload, type, correlation_id, dedupe_key)
 * @returns {Promise<object[]>} each handler's result
 */
async function runJobs(rows) {
  const handlers = dispatch.loadHandlers({ log: logger });
  const results = [];
  for (const row of rows) {
    const handler = handlers.get(row.type);
    results.push(await handler.handle(row.payload, ctxFor(row)));
  }
  return results;
}

/**
 * Run the real 'email.verification' handler while the ADR-011 mock adapter stands in for a
 * body-composing adapter: it declares requiresRenderContext exactly as
 * src/adapters/sendgrid.js does, so the transport resolves the render context, and what the
 * adapter received is captured for the caller to compose the message a real recipient would
 * get. Nothing about the transport, handler or auth service is stubbed — the seam is the
 * adapter itself, the lowest one that exists.
 *
 * @param {object} job a full 'email.verification' outbox_jobs row
 * @returns {Promise<{result: object, received: object[]}>}
 */
async function drainCapturingDelivery(job) {
  const handler = dispatch.loadHandlers({ log: logger }).get('email.verification');
  const realDeliver = mockTransport.adapter.deliver;
  const received = [];
  mockTransport.adapter.requiresRenderContext = true;
  mockTransport.adapter.deliver = async (input) => {
    received.push(input);
    return realDeliver(input);
  };
  try {
    const result = await handler.handle(job.payload, ctxFor(job));
    return { result, received };
  } finally {
    mockTransport.adapter.deliver = realDeliver;
    delete mockTransport.adapter.requiresRenderContext;
  }
}

module.exports = { ctxFor, runJobs, drainCapturingDelivery };
