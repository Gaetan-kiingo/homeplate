// src/outbox/handlers/moderationScan.js — U4-MODERATION: the 'moderation.scan' outbox
// handler — the ONLY place the ADR-007 moderation LLM adapter meets the FR-08 pipeline.
//
// Requirement traceability (SRS Appendix B):
//   FR-08 (TC-08, IT-03) — consumes the wave-3 payload contract {contentType, contentId}
//            (producers: listings create/material-edit since wave 3; reviews/messaging in
//            wave 4B/4C) and runs src/modules/moderation/service.processScan — deterministic
//            pre-filter first, then the injected classifier, then decision/queue routing.
//   ADR-001/003 — WORKER-ONLY adapter use: this handler is the sole importer of
//            src/adapters/llmModeration on the moderation path; request handlers never call
//            the classifier inline (adr-conformance lane enforces it).
//   ADR-002 / NFR-09 — a provider failure (ModerationProviderError, retryable) propagates to
//            the outbox worker, which backs off, retries and finally dead-letters — while the
//            content's moderation_status stays 'pending': public content is NEVER published
//            unreviewed, and messages (already delivered) simply stay unscanned until retry.
//            Dead-lettered scans are re-opened with scripts/requeue-dead-letters.js.
//   NFR-08 — ctx.log carries the ORIGINATING request's correlation ID (stamped on the outbox
//            row at enqueue), so every scan decision's audit record ties back to the request
//            that created the content (MT-01 both-sides tracing).
'use strict';

const llm = require('../../adapters/llmModeration');
const service = require('../../modules/moderation/service');

module.exports = {
  type: service.JOB_TYPE, // 'moderation.scan'
  /**
   * @param {{contentType: 'listing'|'review'|'message', contentId: string}} payload
   * @param {{log: object}} ctx  worker job context (correlation-scoped logger)
   */
  async handle(payload, ctx) {
    await service.processScan(payload, {
      classify: (text) => llm.classify(text),
      mode: llm.mode,
      ctx,
    });
  },
};
