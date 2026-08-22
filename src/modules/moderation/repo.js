// src/modules/moderation/repo.js — U4-MODERATION: data access for the FR-08 pipeline —
// MODERATION_DECISION rows, the moderation_queue, the scanned-content projection and the ONE
// place in src/ that flips a content row's moderation_status to approved/rejected
// (db/migrations/0001 moderation_decisions / moderation_queue; 0002 ships the open-item
// uniqueness backstop and the queue/decision lookup indexes).
//
// Requirement traceability (SRS Appendix B):
//   FR-08 (TC-08) — insertDecision() records every pipeline outcome (category, confidence,
//                   outcome, decided_by ∈ {pre_filter, llm, human}, model_id — ADR-007
//                   requires the model id on every LLM decision); insertQueueItem() files
//                   low-confidence/flagged content for the human Moderator; setModerationStatus()
//                   is the publication gate's only writer (approved content becomes publicly
//                   readable; rejected content never does).
//   NFR-11 (ST-04) — parameterized SQL only; the two dynamic WHERE builders interpolate
//                   nothing but `$n` placeholder INDEXES.
//   NFR-13 / ADR-010 — loadContent() selects ONLY what the pipeline needs: the moderated
//                   TEXT fields, the author id and the moderation state. It never selects an
//                   address, coordinates, email or phone column, so nothing the moderator
//                   queue serializes can leak a precise location or §3.4 PII.
//   AB-03          — countRecentByAuthor() measures the pre-filter's per-author submission
//                   rate over the RATE_LIMIT window.
//   RT-02          — insertQueueItem() is idempotent per (content_type, content_id) while an
//                   item is unresolved (0002 moderation_queue_open_content_key + ON CONFLICT DO NOTHING),
//                   so a redelivered scan job can never file duplicate queue entries.
'use strict';

const pool = require('../../db/pool');

/** §3.4 moderation_content_type domain — the surfaces FR-08 moderates in v1.0. */
const CONTENT_TYPES = Object.freeze(['listing', 'review', 'message']);

/** Decision columns that leave this module (never a raw row spread). */
const DECISION_COLS =
  'id, content_type, content_id, category, confidence, outcome, decided_by, decided_by_user_id, model_id, note, created_at';

/** Queue columns that leave this module. */
const QUEUE_COLS =
  'id, content_type, content_id, reason, status, assigned_to, decision_id, created_at, resolved_at';

function runner(client) {
  return client ?? pool;
}

function assertContentType(contentType) {
  if (!CONTENT_TYPES.includes(contentType)) {
    throw new TypeError(
      `moderation repo: contentType must be one of ${CONTENT_TYPES.join(', ')} (got "${contentType}")`
    );
  }
  return contentType;
}

// ---- content projection (FR-08 scan input) ---------------------------------------------------

/**
 * The scanned projection of one content row: the user-authored TEXT the pipeline judges,
 * the author id (rate limit / audit — IDs only) and the current moderation state. Static
 * per-type SQL — the type never reaches the string as an identifier (NFR-11).
 *
 * @param {'listing'|'review'|'message'} contentType
 * @param {string} contentId
 * @param {import('pg').PoolClient} [client]
 * @returns {Promise<{contentType: string, contentId: string, authorId: string|null,
 *                    moderationStatus: string, text: string}|null>} null when the row is gone
 */
async function loadContent(contentType, contentId, client = null) {
  assertContentType(contentType);
  let row;
  if (contentType === 'listing') {
    const { rows } = await runner(client).query(
      `SELECT host_id AS author_id, moderation_status,
              concat_ws(E'\\n', title, description,
                        array_to_string(ingredients, ', '),
                        array_to_string(allergens, ', '),
                        cuisine) AS text
         FROM listings WHERE id = $1`,
      [contentId]
    );
    row = rows[0];
  } else if (contentType === 'review') {
    const { rows } = await runner(client).query(
      `SELECT author_id, moderation_status, coalesce(body, '') AS text FROM reviews WHERE id = $1`,
      [contentId]
    );
    row = rows[0];
  } else {
    const { rows } = await runner(client).query(
      `SELECT sender_id AS author_id, moderation_status, body AS text FROM messages WHERE id = $1`,
      [contentId]
    );
    row = rows[0];
  }
  if (!row) return null;
  return {
    contentType,
    contentId,
    authorId: row.author_id,
    moderationStatus: row.moderation_status,
    text: row.text || '',
  };
}

/**
 * Submissions of `contentType` by `authorId` whose created_at falls inside the trailing
 * window — the pre-filter's rate-limit measurement (ADR-002, AB-03). Includes the row under
 * scan itself, which prefilter.exceedsRateLimit() expects.
 */
async function countRecentByAuthor(contentType, authorId, windowMinutes, client = null) {
  assertContentType(contentType);
  const sqlByType = {
    listing: `SELECT count(*)::int AS n FROM listings
               WHERE host_id = $1 AND created_at > now() - ($2::int * interval '1 minute')`,
    review: `SELECT count(*)::int AS n FROM reviews
              WHERE author_id = $1 AND created_at > now() - ($2::int * interval '1 minute')`,
    message: `SELECT count(*)::int AS n FROM messages
               WHERE sender_id = $1 AND created_at > now() - ($2::int * interval '1 minute')`,
  };
  const { rows } = await runner(client).query(sqlByType[contentType], [authorId, windowMinutes]);
  return rows[0].n;
}

// ---- publication gate (FR-08 — the ONE moderation_status writer) -----------------------------

/**
 * Flip a content row's moderation_status. THE ONLY writer of approved/rejected in src/
 * (build-plan §4A public interface): listings/reviews are born 'pending' at their own INSERT
 * and a material listing edit resets to 'pending' in the listings module, but every
 * transition OUT of 'pending' happens here, on the pipeline's or a human's decision.
 *
 * @param {'listing'|'review'|'message'} contentType
 * @param {string} contentId
 * @param {'approved'|'rejected'} status
 * @param {import('pg').PoolClient} [client]  transaction client (decision + flip commit together)
 * @returns {Promise<boolean>} false when the content row no longer exists
 */
async function setModerationStatus(contentType, contentId, status, client = null) {
  assertContentType(contentType);
  if (status !== 'approved' && status !== 'rejected') {
    throw new TypeError(`moderation repo: cannot set moderation_status "${status}"`);
  }
  const sqlByType = {
    listing: `UPDATE listings SET moderation_status = $2::moderation_status, updated_at = now()
               WHERE id = $1`,
    review: `UPDATE reviews SET moderation_status = $2::moderation_status, updated_at = now()
              WHERE id = $1`,
    message: `UPDATE messages SET moderation_status = $2::moderation_status WHERE id = $1`,
  };
  const result = await runner(client).query(sqlByType[contentType], [contentId, status]);
  return result.rowCount === 1;
}

// ---- MODERATION_DECISION (§3.4) --------------------------------------------------------------

/**
 * Record one moderation decision (FR-08 — every pipeline outcome writes exactly one).
 * @param {import('pg').PoolClient|null} client
 * @param {{contentType: string, contentId: string, category: string,
 *          confidence?: number|null, outcome: 'approved'|'rejected'|'escalated',
 *          decidedBy: 'pre_filter'|'llm'|'human', decidedByUserId?: string|null,
 *          modelId?: string|null, note?: string|null}} decision
 * @returns {Promise<object>} the persisted decision row
 */
async function insertDecision(client, decision) {
  assertContentType(decision.contentType);
  const { rows } = await runner(client).query(
    `INSERT INTO moderation_decisions
       (content_type, content_id, category, confidence, outcome, decided_by,
        decided_by_user_id, model_id, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING ${DECISION_COLS}`,
    [
      decision.contentType,
      decision.contentId,
      decision.category,
      decision.confidence ?? null,
      decision.outcome,
      decision.decidedBy,
      decision.decidedByUserId ?? null,
      decision.modelId ?? null,
      decision.note ?? null,
    ]
  );
  return rows[0];
}

/** Newest-first decisions for one content item (moderator queue context; tests). */
async function listDecisionsForContent(contentType, contentId, client = null) {
  assertContentType(contentType);
  const { rows } = await runner(client).query(
    `SELECT ${DECISION_COLS} FROM moderation_decisions
      WHERE content_type = $1 AND content_id = $2
      ORDER BY created_at DESC, id DESC`,
    [contentType, contentId]
  );
  return rows;
}

// ---- moderation_queue (ADR-002 human review stage) -------------------------------------------

/**
 * File one content item for human review. Idempotent while an unresolved item exists for the
 * same content (RT-02 — 0002's moderation_queue_open_content_key makes a redelivered scan a no-op).
 * @returns {Promise<{item: object, created: boolean}>} the open item either way
 */
async function insertQueueItem(client, { contentType, contentId, reason, decisionId = null }) {
  assertContentType(contentType);
  const inserted = await runner(client).query(
    `INSERT INTO moderation_queue (content_type, content_id, reason, decision_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (content_type, content_id) WHERE status <> 'resolved' DO NOTHING
     RETURNING ${QUEUE_COLS}`,
    [contentType, contentId, reason, decisionId]
  );
  if (inserted.rows.length > 0) {
    return { item: inserted.rows[0], created: true };
  }
  const existing = await runner(client).query(
    `SELECT ${QUEUE_COLS} FROM moderation_queue
      WHERE content_type = $1 AND content_id = $2 AND status <> 'resolved'
      ORDER BY created_at DESC LIMIT 1`,
    [contentType, contentId]
  );
  return { item: existing.rows[0] ?? null, created: false };
}

/** One queue item by id (decision path; 404 detection). */
async function findQueueItem(queueItemId, client = null) {
  const { rows } = await runner(client).query(
    `SELECT ${QUEUE_COLS} FROM moderation_queue WHERE id = $1`,
    [queueItemId]
  );
  return rows[0] ?? null;
}

/**
 * Lock one queue item for the human-decision transaction (two moderators deciding the same
 * item concurrently: the second waits, then sees status 'resolved' and gets a 409).
 */
async function lockQueueItem(client, queueItemId) {
  const { rows } = await client.query(
    `SELECT ${QUEUE_COLS} FROM moderation_queue WHERE id = $1 FOR UPDATE`,
    [queueItemId]
  );
  return rows[0] ?? null;
}

/** Resolve a queue item with the human decision that settled it (FR-08). */
async function resolveQueueItem(client, queueItemId, { decisionId, moderatorUserId }) {
  const { rows } = await client.query(
    `UPDATE moderation_queue
        SET status = 'resolved', resolved_at = now(), decision_id = $2, assigned_to = $3
      WHERE id = $1 AND status <> 'resolved'
      RETURNING ${QUEUE_COLS}`,
    [queueItemId, decisionId, moderatorUserId]
  );
  return rows[0] ?? null;
}

/**
 * The moderator queue page (GET /api/moderation/queue): filtered, newest first, paged by the
 * shared capped pagination (NFR-02). WHERE fragments are static strings; only `$n` indexes
 * are interpolated (NFR-11).
 */
async function listQueue({ status, contentType, page = 1, pageSize = 20 } = {}) {
  const params = [];
  const where = [];
  if (status !== undefined) {
    params.push(status);
    where.push(`status = $${params.length}::moderation_queue_status`);
  }
  if (contentType !== undefined) {
    assertContentType(contentType);
    params.push(contentType);
    where.push(`content_type = $${params.length}::moderation_content_type`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  params.push(pageSize, (page - 1) * pageSize);
  const { rows } = await pool.query(
    `SELECT ${QUEUE_COLS} FROM moderation_queue
      ${whereSql}
      ORDER BY created_at DESC, id DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );
  return rows;
}

/** Total queue items matching the filter (pagination metadata). */
async function countQueue({ status, contentType } = {}) {
  const params = [];
  const where = [];
  if (status !== undefined) {
    params.push(status);
    where.push(`status = $${params.length}::moderation_queue_status`);
  }
  if (contentType !== undefined) {
    assertContentType(contentType);
    params.push(contentType);
    where.push(`content_type = $${params.length}::moderation_content_type`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { rows } = await pool.query(
    `SELECT count(*)::int AS count FROM moderation_queue ${whereSql}`,
    params
  );
  return rows[0].count;
}

/**
 * Batched scan-text excerpts for one queue page (NFR-13: the same minimal projection
 * loadContent uses — never an address or coordinate). Returns Map keyed "type:id".
 */
async function loadContentForQueuePage(rows) {
  const byType = new Map();
  for (const row of rows) {
    if (!byType.has(row.content_type)) byType.set(row.content_type, []);
    byType.get(row.content_type).push(row.content_id);
  }
  const out = new Map();
  for (const [contentType, ids] of byType) {
    assertContentType(contentType);
    const sqlByType = {
      listing: `SELECT id, moderation_status,
                       concat_ws(E'\\n', title, description) AS text
                  FROM listings WHERE id = ANY($1::uuid[])`,
      review: `SELECT id, moderation_status, coalesce(body, '') AS text
                 FROM reviews WHERE id = ANY($1::uuid[])`,
      message: `SELECT id, moderation_status, body AS text
                  FROM messages WHERE id = ANY($1::uuid[])`,
    };
    const { rows: contentRows } = await pool.query(sqlByType[contentType], [ids]);
    for (const contentRow of contentRows) {
      out.set(`${contentType}:${contentRow.id}`, {
        moderationStatus: contentRow.moderation_status,
        text: contentRow.text || '',
      });
    }
  }
  return out;
}

/** Latest decision per content item of one queue page, keyed "type:id" (DISTINCT ON). */
async function loadLatestDecisionsForQueuePage(rows) {
  if (rows.length === 0) return new Map();
  const types = rows.map((r) => r.content_type);
  const ids = rows.map((r) => r.content_id);
  const { rows: decisionRows } = await pool.query(
    `SELECT DISTINCT ON (content_type, content_id) ${DECISION_COLS}
       FROM moderation_decisions
      WHERE (content_type, content_id) IN (
              SELECT unnest($1::moderation_content_type[]), unnest($2::uuid[])
            )
      ORDER BY content_type, content_id, created_at DESC, id DESC`,
    [types, ids]
  );
  const out = new Map();
  for (const row of decisionRows) {
    out.set(`${row.content_type}:${row.content_id}`, row);
  }
  return out;
}

module.exports = {
  CONTENT_TYPES,
  loadContent,
  countRecentByAuthor,
  setModerationStatus,
  insertDecision,
  listDecisionsForContent,
  insertQueueItem,
  findQueueItem,
  lockQueueItem,
  resolveQueueItem,
  listQueue,
  countQueue,
  loadContentForQueuePage,
  loadLatestDecisionsForQueuePage,
};
