// src/adapters/mockTransport.js — U2-ADAPTERS-COMMS: the ADR-011 mock notification transport.
//
// Dev and the ENTIRE automated test suite run on this adapter: nothing ever leaves the
// process, and the transport layer (src/modules/notifications/transport.js) records a
// NOTIFICATION_ATTEMPT row for every send exactly as it does for the live adapters, so
// tests assert on persisted rows — never on a third party's behaviour (ADR-011).
//
// Requirement traceability (SRS Appendix B):
//   FR-13, FR-14, FR-07 — the notification channel those flows deliver through in dev/test
//   NFR-09 (RT-01)      — injectFailures()/injectHangs() simulate a provider outage or a
//                         hung provider so the resilience path (timeout, bounded retries,
//                         failed-result-without-throw) is testable deterministically
//   NFR-08 (MT-01)      — deliveries() exposes what "went out" for log/row cross-checks
//
// Worker-only, like every file under src/adapters/ (ADR-001/003): request handlers must
// never import this module — only src/outbox/handlers/* and worker code may.
'use strict';

const { UpstreamServiceError } = require('../lib/errors');

const state = {
  deliveries: [], // successful mock "sends", in order
  failures: [], // queue of Errors thrown by upcoming deliver() calls
  hangs: 0, // number of upcoming deliver() calls that never settle (timeout tests)
};

const adapter = {
  name: 'mock',
  channels: ['email', 'push'],
  // The mock needs no recipient lookup — rows carry user IDs only and nothing is sent.
  requiresRecipientEmail: false,

  /**
   * "Delivers" a notification by recording it in memory. Deterministic (ADR-011):
   * succeeds unless a failure/hang was explicitly injected by a test.
   * @param {object} input { userId, channel, template, params, idempotencyKey, attempt }
   * @returns {Promise<{providerMessageId: string}>}
   */
  async deliver(input) {
    if (state.hangs > 0) {
      state.hangs -= 1;
      // Never settles: the withResilience per-attempt timeout must fire (NFR-09).
      return new Promise(() => {});
    }
    if (state.failures.length > 0) {
      throw state.failures.shift();
    }
    const record = {
      userId: input.userId,
      channel: input.channel,
      template: input.template,
      params: input.params,
      idempotencyKey: input.idempotencyKey ?? null,
      attempt: input.attempt ?? 1,
      deliveredAt: new Date(),
    };
    state.deliveries.push(record);
    return { providerMessageId: `mock-${state.deliveries.length}` };
  },
};

/**
 * Queue `count` injected provider failures: the next `count` deliver() calls throw a
 * retryable UpstreamServiceError (or a caller-supplied error), simulating an outage.
 */
function injectFailures(count = 1, message = 'mock transport: injected provider failure', error) {
  for (let i = 0; i < count; i += 1) {
    state.failures.push(error ?? new UpstreamServiceError(message, { upstreamStatus: null }));
  }
}

/** Queue `count` deliver() calls that hang forever, so the per-attempt timeout fires. */
function injectHangs(count = 1) {
  state.hangs += count;
}

/** Snapshot of everything the mock "sent" (successful deliver() calls, in order). */
function deliveries() {
  return [...state.deliveries];
}

/** Clear recorded deliveries and any un-consumed injected failures/hangs. */
function reset() {
  state.deliveries.length = 0;
  state.failures.length = 0;
  state.hangs = 0;
}

module.exports = { adapter, injectFailures, injectHangs, deliveries, reset };
