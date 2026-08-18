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

const config = require('../config');
const { logger } = require('../lib/logger');
const { UpstreamServiceError } = require('../lib/errors');

// TRUE only in `npm run dev` — never under NODE_ENV=test, never in production (where the mock
// transport is refused outright by config validation). See the requiresRenderContext note on
// the adapter below.
const IS_DEV_LOOP = config.env === 'development';

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
    // DEV LOOP ONLY (finding TCBV2-03). A real adapter composes a body; the mock does not, so
    // in `npm run dev` the FR-10 verification link went nowhere and a developer could not
    // finish registration through the product at all. Here — and only here — the resolved
    // render context is kept on the IN-MEMORY record and printed once, so the link is
    // clickable from the dev console. It still never reaches the NOTIFICATION_ATTEMPT row or
    // the outbox payload (transport.js keeps renderContext out of everything it persists),
    // and under NODE_ENV=test neither branch runs: what the suite observes is byte-identical
    // to before, so the ADR-003 "IDs only in rows" assertions stay exactly as strict.
    if (IS_DEV_LOOP && input.renderContext) {
      record.renderContext = input.renderContext;
      logger.info(
        {
          event: 'mock_transport_delivery',
          recipientUserId: input.userId,
          template: input.template,
          renderContext: input.renderContext,
        },
        'mock transport: no email was sent — use the link below to continue locally'
      );
    }
    state.deliveries.push(record);
    return { providerMessageId: `mock-${state.deliveries.length}` };
  },
};

// ADR-011 / FR-10 — dev loop only. Declaring this makes src/modules/notifications/transport.js
// resolve the per-send render context (the single-use verification link) exactly as it does
// for SendGrid, which is the only way a developer running the mock transport can complete
// registration locally. The property is ABSENT under NODE_ENV=test (and in production, where
// this adapter is never selected), so the automated suite keeps its stronger property: on the
// mock path no credential is minted at all unless a test explicitly opts in by setting this
// flag itself.
if (IS_DEV_LOOP) {
  adapter.requiresRenderContext = true;
}

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
