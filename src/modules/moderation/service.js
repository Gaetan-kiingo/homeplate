// src/modules/moderation/service.js — U4-MODERATION: the FR-08 two-stage moderation pipeline
// (ADR-002) and the human Moderator queue behind GET /api/moderation/queue and
// POST /api/moderation/queue/:id/decision (SPMP WA-7).
//
// Requirement traceability (SRS Appendix B):
//   FR-08 (TC-08, IT-03) — processScan() is the pipeline the 'moderation.scan' worker job
//                   runs: deterministic pre-filter (./prefilter — blocklist/regex/rate limit)
//                   first, then the provider-agnostic LLM classifier INJECTED by the handler
//                   (src/outbox/handlers/moderationScan.js — this module itself imports NO
//                   adapter, so the request path stays adapter-free, ADR-001/003). Routing:
//                   blocklist hit → rejected (decided_by 'pre_filter', zero LLM calls);
//                   benign at/above config.moderation.confidenceThreshold → approved;
//                   flagged (violating category) or low-confidence → moderation_queue item,
//                   content stays 'pending'. Every outcome writes a MODERATION_DECISION row.
//                   decide() is the human stage: approve/reject flips the content's
//                   moderation_status, resolves the queue item and records the human decision.
//   ADR-002        — publication policy: public content (listings, reviews) stays 'pending'
//                   until approved; messages were already delivered and are scanned
//                   asynchronously; a provider failure RETHROWS the typed retryable error so
//                   the outbox worker retries/dead-letters while the content stays pending —
//                   an outage can never publish unreviewed content.
//   ADR-007        — live classification is gated on the RATIFIED data-use review AND the
//                   content (prefilter.liveContentGate): personal-shaped content never
//                   reaches the live provider and escalates to the human queue instead. The
//                   model id of every LLM decision is recorded (MODERATION_DECISION.model_id).
//   NFR-08 (MT-01) — every scan outcome and every human decision writes ONE structured audit
//                   record through the request/job-scoped logger: correlation ID, actor
//                   (moderator user id, or the system worker), content type + id, outcome —
//                   IDs, categories and rule names only; NEVER the content text (§3.4).
//   NFR-09 (RT-01) — the pre-filter is pure local work; only stage 2 can fail with the
//                   provider, and that failure defers the job rather than deciding anything.
//   NFR-10 (IT-03) — the same pipeline path (prefilter.check → classify) is what
//                   scripts/it03-eval.js scores against the ADR-008 set; PROMPT_VERSION below
//                   is recorded with every run so a measurement is tied to the prompt.
//   NFR-11 / AB-06 — all HTTP input is validated by src/schemas/moderation.js at the routes.
//   AB-01/AB-03/AB-04/AB-08 — fake/spam/abusive content is filtered or human-reviewed before
//                   publication, and the moderator surface is Moderator-role-only.
'use strict';

const config = require('../../config');
const { withTransaction } = require('../../db/tx');
const { ConflictError, ForbiddenError, NotFoundError } = require('../../lib/errors');
const { logger, audit } = require('../../lib/logger');
const outbox = require('../../outbox/outbox');
const prefilter = require('./prefilter');
const repo = require('./repo');

/** Outbox job type of the scan pipeline. Producers enqueue THIS STRING (build-plan §7):
 *  wave 3 (listings) already does; reviews/messaging depend on the string only. */
const JOB_TYPE = 'moderation.scan';

/** The role SRS §2.3 gives the human review stage. */
const MODERATOR_ROLE = 'moderator';

/** Version tag of the classifier prompt embedded in src/adapters/llmModeration.js
 *  (SAFETY_POLICY_PROMPT). Recorded with every IT-03 run (ADR-008); bump it in the same
 *  change as any edit to that prompt so a measurement can never silently span two prompts. */
const PROMPT_VERSION = 'moderation-prompt-v1';

/** Queue reasons (moderation_queue.reason vocabulary). */
const QUEUE_REASONS = Object.freeze({
  lowConfidence: 'low_confidence',
  flagged: 'flagged',
  rateLimited: 'rate_limited',
  dataUseGate: 'data_use_gate',
});

/** Decision category recorded when content was escalated WITHOUT a classification
 *  (data-use gate): the taxonomy would be a lie, so the row says so explicitly. */
const UNCLASSIFIED = 'unclassified';

/** Max characters of scanned text a queue entry exposes to the moderator view. */
const EXCERPT_MAX_CHARS = 500;

function logFor(opts = {}) {
  return opts.log || logger;
}

// ---- enqueue helper (wave-4B producers) ------------------------------------------------------

/**
 * Enqueue a moderation scan for freshly written content ON THE CALLER'S TRANSACTION CLIENT
 * (ADR-001/003 — the content row and its scan job commit together). Reviews/messaging may
 * call this or enqueue the JOB_TYPE string themselves; both meet the same contract.
 *
 * @param {import('pg').PoolClient} client  the transaction client the content INSERT used
 * @param {'listing'|'review'|'message'} contentType
 * @param {string} contentId
 * @returns {Promise<{job: object, deduped: boolean}>}
 */
async function submitForReview(client, contentType, contentId) {
  if (!repo.CONTENT_TYPES.includes(contentType)) {
    throw new TypeError(
      `submitForReview: contentType must be one of ${repo.CONTENT_TYPES.join(', ')}`
    );
  }
  return outbox.enqueue(client, {
    type: JOB_TYPE,
    payload: { contentType, contentId }, // IDs only (ADR-003)
  });
}

// ---- the scan pipeline (worker path — FR-08 / ADR-002) ---------------------------------------

/** One audit record per scan outcome (NFR-08). System actor, mirroring booking.promoted. */
function auditScan(log, fields) {
  audit(log, {
    event: 'moderation.scanned',
    actorUserId: null,
    actor: 'system:moderation',
    ...fields,
  });
}

/**
 * Execute the FR-08 pipeline for one enqueued scan job. Called ONLY by the moderation.scan
 * outbox handler, which injects the resolved ADR-007 adapter — so this module never imports
 * one and the request path stays adapter-free (ADR-001/003).
 *
 * @param {{contentType: string, contentId: string}} payload  the wave-3 job contract
 * @param {object} deps
 * @param {(text: string) => Promise<{category: string, confidence: number, model: string}>}
 *        deps.classify  the ADR-007 adapter's classifier (throws ModerationProviderError on
 *                       provider failure — rethrown so the worker retries and the content
 *                       stays pending, ADR-002)
 * @param {'mock'|'live'} deps.mode  resolved adapter mode (gates the ADR-007 content check)
 * @param {{log?: object}} [deps.ctx]  worker job context (correlation-scoped logger, NFR-08)
 * @returns {Promise<{outcome: string, decisionId?: string}>}
 */
async function processScan(payload, { classify, mode, ctx = {} } = {}) {
  if (typeof classify !== 'function') {
    throw new TypeError('processScan: deps.classify is required (the handler injects it)');
  }
  const log = ctx.log || logFor();
  const { contentType, contentId } = payload || {};
  if (!repo.CONTENT_TYPES.includes(contentType) || typeof contentId !== 'string') {
    // A malformed payload can never succeed: let the worker retry-then-dead-letter it with
    // an explicit reason (NFR-09 visibility) rather than silently swallowing it.
    throw new TypeError(
      `moderation.scan: payload must be {contentType: ${repo.CONTENT_TYPES.join('|')}, contentId}`
    );
  }

  const content = await repo.loadContent(contentType, contentId);
  if (!content) {
    // Content deleted between enqueue and scan — nothing to decide (deliver, don't retry).
    auditScan(log, {
      outcome: 'skipped',
      reason: 'CONTENT_MISSING',
      entityType: contentType,
      entityId: contentId,
    });
    return { outcome: 'skipped_missing' };
  }
  if (content.moderationStatus !== 'pending') {
    // Stale or redelivered scan: the content was already decided (possibly by a human).
    // Never re-open or override a decision from a scan job (RT-02 idempotent redelivery).
    auditScan(log, {
      outcome: 'skipped',
      reason: 'ALREADY_DECIDED',
      entityType: contentType,
      entityId: contentId,
      moderationStatus: content.moderationStatus,
    });
    return { outcome: 'skipped_decided' };
  }

  // ---- stage 1: deterministic pre-filter (zero LLM calls — ADR-002) --------------------------
  const blocked = prefilter.check(content.text);
  if (blocked.verdict === 'blocked') {
    const decision = await withTransaction(async (client) => {
      const row = await repo.insertDecision(client, {
        contentType,
        contentId,
        category: blocked.category,
        confidence: 1,
        outcome: 'rejected',
        decidedBy: 'pre_filter',
        note: blocked.rule,
      });
      await repo.setModerationStatus(contentType, contentId, 'rejected', client);
      return row;
    });
    auditScan(log, {
      outcome: 'rejected',
      entityType: contentType,
      entityId: contentId,
      decisionId: decision.id,
      decidedBy: 'pre_filter',
      category: blocked.category,
      rule: blocked.rule,
    });
    return { outcome: 'rejected', decisionId: decision.id };
  }

  // Escalation writer shared by every route-to-human outcome below: decision + queue item
  // commit together; the content's moderation_status is NOT touched (stays 'pending' for
  // public content — never published unreviewed; messages were already delivered).
  const escalate = async ({
    category,
    confidence = null,
    decidedBy,
    modelId = null,
    reason,
    note = null,
  }) => {
    const { decision, queued } = await withTransaction(async (client) => {
      const row = await repo.insertDecision(client, {
        contentType,
        contentId,
        category,
        confidence,
        outcome: 'escalated',
        decidedBy,
        modelId,
        note,
      });
      const { item } = await repo.insertQueueItem(client, {
        contentType,
        contentId,
        reason,
        decisionId: row.id,
      });
      return { decision: row, queued: item };
    });
    auditScan(log, {
      outcome: 'escalated',
      entityType: contentType,
      entityId: contentId,
      decisionId: decision.id,
      queueItemId: queued ? queued.id : null,
      decidedBy,
      category,
      confidence,
      reason,
    });
    return { outcome: 'escalated', decisionId: decision.id };
  };

  // ---- stage 1b: per-author submission rate limit (ADR-002, AB-03) ---------------------------
  if (content.authorId) {
    const recent = await repo.countRecentByAuthor(
      contentType,
      content.authorId,
      prefilter.RATE_LIMIT.windowMinutes
    );
    if (prefilter.exceedsRateLimit(recent)) {
      return escalate({
        category: 'spam',
        decidedBy: 'pre_filter',
        reason: QUEUE_REASONS.rateLimited,
        note: `rate_limit:${recent} submissions in ${prefilter.RATE_LIMIT.windowMinutes}m`,
      });
    }
  }

  // ---- ADR-007 data-use gate (live provider only) --------------------------------------------
  if (mode === 'live') {
    const gate = prefilter.liveContentGate(content.text);
    if (!gate.allowed) {
      // The "would have called the LLM" path routes to the human queue instead (ADR-007).
      return escalate({
        category: UNCLASSIFIED,
        decidedBy: 'pre_filter',
        reason: QUEUE_REASONS.dataUseGate,
        note: gate.reasons.join('; '),
      });
    }
  }

  // ---- stage 2: LLM classification (ADR-007 adapter, injected by the handler) ----------------
  // A provider failure throws the typed retryable ModerationProviderError: rethrown as-is so
  // the outbox worker backs off/dead-letters and the content stays pending (ADR-002, NFR-09).
  const result = await classify(content.text);

  if (result.category === 'benign' && result.confidence >= config.moderation.confidenceThreshold) {
    const decision = await withTransaction(async (client) => {
      const row = await repo.insertDecision(client, {
        contentType,
        contentId,
        category: result.category,
        confidence: result.confidence,
        outcome: 'approved',
        decidedBy: 'llm',
        modelId: result.model,
      });
      await repo.setModerationStatus(contentType, contentId, 'approved', client);
      return row;
    });
    auditScan(log, {
      outcome: 'approved',
      entityType: contentType,
      entityId: contentId,
      decisionId: decision.id,
      decidedBy: 'llm',
      category: result.category,
      confidence: result.confidence,
      modelId: result.model,
    });
    return { outcome: 'approved', decisionId: decision.id };
  }

  // Flagged (violating category) or low-confidence: human review (ADR-002 routing).
  const flagged = result.category !== 'benign';
  return escalate({
    category: result.category,
    confidence: result.confidence,
    decidedBy: 'llm',
    modelId: result.model,
    reason: flagged ? QUEUE_REASONS.flagged : QUEUE_REASONS.lowConfidence,
  });
}

// ---- moderator queue read model (FR-08 human stage; also consumed by U4-SAFETY) --------------

function requireModerator(auth) {
  const roles = Array.isArray(auth && auth.roles) ? auth.roles : [];
  if (!roles.includes(MODERATOR_ROLE)) {
    throw new ForbiddenError('Only a moderator may use the moderation queue.', {
      code: 'NOT_MODERATOR',
    });
  }
}

/** Explicit allowlist serialization of one queue entry (NFR-13: text excerpt + IDs only —
 *  never an address, coordinate or author identity beyond the id). */
function serializeQueueEntry(row, content, latestDecision) {
  return {
    id: row.id,
    contentType: row.content_type,
    contentId: row.content_id,
    reason: row.reason,
    status: row.status,
    assignedTo: row.assigned_to,
    decisionId: row.decision_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    contentStatus: content ? content.moderationStatus : null,
    excerpt: content ? content.text.slice(0, EXCERPT_MAX_CHARS) : null,
    latestDecision: latestDecision
      ? {
          id: latestDecision.id,
          category: latestDecision.category,
          confidence: latestDecision.confidence === null ? null : Number(latestDecision.confidence),
          outcome: latestDecision.outcome,
          decidedBy: latestDecision.decided_by,
          modelId: latestDecision.model_id,
          createdAt: latestDecision.created_at,
        }
      : null,
  };
}

/**
 * GET /api/moderation/queue — the human review queue, Moderator role only (SRS §2.3, AB-08).
 * @param {{userId: string, roles?: string[]}} auth  req.auth
 * @param {{page: number, pageSize: number, status?: string, contentType?: string}} query
 */
async function listQueue(auth, { page, pageSize, status, contentType } = {}) {
  requireModerator(auth);
  const [rows, total] = await Promise.all([
    repo.listQueue({ status, contentType, page, pageSize }),
    repo.countQueue({ status, contentType }),
  ]);
  const [contentByKey, decisionsByKey] = await Promise.all([
    repo.loadContentForQueuePage(rows),
    repo.loadLatestDecisionsForQueuePage(rows),
  ]);
  return {
    items: rows.map((row) => {
      const key = `${row.content_type}:${row.content_id}`;
      return serializeQueueEntry(row, contentByKey.get(key), decisionsByKey.get(key));
    }),
    page,
    pageSize,
    total,
  };
}

/**
 * POST /api/moderation/queue/:id/decision — the human decision (FR-08, MT-01 action 4).
 * ONE transaction: human MODERATION_DECISION row → content moderation_status flip →
 * queue item resolved. Then one NFR-08 audit record with the request correlation ID.
 *
 * @param {{userId: string, roles?: string[]}} auth  req.auth (Moderator role required)
 * @param {string} queueItemId
 * @param {{decision: 'approve'|'reject', category: string, note?: string}} input  validated body
 * @param {{log?: object}} [opts]  request-scoped logger (NFR-08)
 * @returns {Promise<object>} { item, decision } — the resolved entry and the recorded decision
 * @throws {ForbiddenError} non-moderator
 * @throws {NotFoundError} unknown queue item
 * @throws {ConflictError} the item is already resolved
 */
async function decide(auth, queueItemId, { decision, category, note } = {}, opts = {}) {
  requireModerator(auth);
  const log = logFor(opts);
  const newStatus = decision === 'approve' ? 'approved' : 'rejected';

  const refuse = (err, reason) => {
    audit(log, {
      event: 'moderation.decision',
      outcome: 'failure',
      actorUserId: auth.userId,
      entityType: 'moderation_queue',
      entityId: queueItemId,
      reason,
    });
    return err;
  };

  const { item, row, contentExists } = await withTransaction(async (client) => {
    const locked = await repo.lockQueueItem(client, queueItemId);
    if (!locked) {
      throw refuse(
        new NotFoundError('Moderation queue item not found', { code: 'QUEUE_ITEM_NOT_FOUND' }),
        'QUEUE_ITEM_NOT_FOUND'
      );
    }
    if (locked.status === 'resolved') {
      throw refuse(
        new ConflictError('This queue item is already resolved.', {
          code: 'QUEUE_ITEM_RESOLVED',
        }),
        'QUEUE_ITEM_RESOLVED'
      );
    }
    const decisionRow = await repo.insertDecision(client, {
      contentType: locked.content_type,
      contentId: locked.content_id,
      category,
      outcome: newStatus,
      decidedBy: 'human',
      decidedByUserId: auth.userId,
      note: note ?? null,
    });
    // The publication gate (FR-08): approve → publicly readable; reject → never. A content
    // row deleted since escalation flips nothing — the decision is still recorded.
    const flipped = await repo.setModerationStatus(
      locked.content_type,
      locked.content_id,
      newStatus,
      client
    );
    const resolved = await repo.resolveQueueItem(client, queueItemId, {
      decisionId: decisionRow.id,
      moderatorUserId: auth.userId,
    });
    return { item: resolved, row: decisionRow, contentExists: flipped };
  });

  // NFR-08 / MT-01: the moderation-decision audit record — IDs and categories only.
  audit(log, {
    event: 'moderation.decision',
    outcome: 'success',
    actorUserId: auth.userId,
    entityType: item.content_type,
    entityId: item.content_id,
    queueItemId: item.id,
    decisionId: row.id,
    decision: newStatus,
    category,
    contentExists,
  });

  return {
    item: serializeQueueEntry(item, null, row),
    decision: {
      id: row.id,
      contentType: row.content_type,
      contentId: row.content_id,
      category: row.category,
      outcome: row.outcome,
      decidedBy: row.decided_by,
      decidedByUserId: row.decided_by_user_id,
      createdAt: row.created_at,
    },
  };
}

module.exports = {
  JOB_TYPE,
  MODERATOR_ROLE,
  PROMPT_VERSION,
  QUEUE_REASONS,
  UNCLASSIFIED,
  submitForReview,
  processScan,
  listQueue,
  decide,
  // exported for the unit tests that pin the NFR-13 allowlist
  serializeQueueEntry,
};
