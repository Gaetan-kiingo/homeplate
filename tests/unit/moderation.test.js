// tests/unit/moderation.test.js — U4-MODERATION unit lane: the FR-08 two-stage pipeline
// (ADR-002), the ADR-007 data-use gate, the moderator queue service and the moderation.scan
// handler contract, exercised against the REAL *_test database with an INJECTED classifier
// (no adapter is needed by the pipeline itself — the handler injects it, ADR-001/003).
//
// Requirement traceability (SRS Appendix B):
//   FR-08 (TC-08)  — blocklist reject / benign auto-approve / flagged + low-confidence
//                    escalation / human decide; every outcome writes a MODERATION_DECISION.
//   NFR-08 (MT-01) — the human decision writes ONE audit record (asserted on a capturing
//                    logger); records carry IDs and categories only, never content text.
//   NFR-09 (RT-01) — an injected provider failure propagates untouched (the worker's retry
//                    contract) and decides NOTHING; content stays pending.
//   NFR-10 (IT-03) — PROMPT_VERSION is published for the scoring harness.
//   NFR-11         — schemas exist for both routes (shape pinned here; HTTP 422s in tc08).
//   NFR-13/ADR-007 — liveContentGate refuses personal-shaped content in live mode; the
//                    ratified sign-off constants are pinned.
//   AB-01/AB-03/AB-04 — fraud/spam/offensive samples land on the right side of the gate;
//                    the per-author rate limit escalates a flood to human review.
//   RT-02          — redelivered/duplicate escalation files at most ONE open queue item
//                    (0002's partial unique index) and a scan never overrides a decision.
'use strict';

const crypto = require('crypto');

const config = require('../../src/config');
const prefilter = require('../../src/modules/moderation/prefilter');
const repo = require('../../src/modules/moderation/repo');
const service = require('../../src/modules/moderation/service');
const moderationSchemas = require('../../src/schemas/moderation');
const {
  query,
  withTransaction,
  makeUser,
  makeListing,
  makeBooking,
  insertRow,
  closeDb,
} = require('../helpers/db');

const MODEL = 'unit-injected-model';
const quietLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  child() {
    return this;
  },
};

/** A classifier stub returning a fixed result and counting its calls. */
function classifier(result) {
  const fn = jest.fn(async () => ({ model: MODEL, ...result }));
  return fn;
}

/** A capturing logger for audit assertions (audit() calls log.info(fields, event)). */
function captureLog() {
  const events = [];
  return {
    events,
    log: {
      info: (fields, msg) => events.push({ ...fields, msg }),
      warn: () => {},
      error: () => {},
      child() {
        return this;
      },
    },
  };
}

const scanDeps = (classify, overrides = {}) => ({
  classify,
  mode: 'mock',
  ctx: { log: quietLog },
  ...overrides,
});

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------------------------
// prefilter — stage 1 (deterministic; zero provider involvement)
// ---------------------------------------------------------------------------------------------
describe('prefilter — blocklist / regex (FR-08 stage 1, AB-01/AB-03/AB-04)', () => {
  test('obvious violations block with the right category and a named rule', () => {
    expect(prefilter.check('You should go die, nobody wants your cooking.')).toEqual({
      verdict: 'blocked',
      category: 'offensive',
      rule: 'offensive.direct-threat',
    });
    expect(prefilter.check('these people are subhuman trash')).toMatchObject({
      verdict: 'blocked',
      category: 'offensive',
    });
    expect(
      prefilter.check('crypto giveaway!! join now for the crypto giveaway of the year')
    ).toMatchObject({ verdict: 'blocked', category: 'spam' });
    expect(prefilter.check('pay me via western union before the meal and save 20%')).toMatchObject({
      verdict: 'blocked',
      category: 'fraudulent',
    });
    expect(
      prefilter.check('send $200 now and I will refund you after the dinner, promise')
    ).toMatchObject({ verdict: 'blocked', category: 'fraudulent' });
  });

  test('link farming: three links block as spam, two pass to stage 2', () => {
    const twoLinks = 'my menu https://a.example and photos https://b.example';
    const threeLinks = `${twoLinks} plus https://c.example`;
    expect(prefilter.check(twoLinks)).toEqual({ verdict: 'pass' });
    expect(prefilter.check(threeLinks)).toMatchObject({ verdict: 'blocked', category: 'spam' });
  });

  test('ordinary marketplace text passes; non-strings throw', () => {
    expect(prefilter.check('Homemade tamales, six seats, Saturday evening.')).toEqual({
      verdict: 'pass',
    });
    expect(() => prefilter.check(null)).toThrow(TypeError);
  });

  test('the blocklist does NOT overlap the deterministic mock fixtures (stage-2 probes stay reachable)', () => {
    // "wire transfer" / "click here" / the sentinels belong to the ADR-007 mock classifier;
    // if a blocklist rule swallowed them, no test could drive the LLM stage deterministically.
    for (const stage2Probe of [
      'wire transfer only please',
      'click here for a discount',
      'meal [[LOW_CONFIDENCE]] probe',
      'meal [[LLM_OUTAGE]] probe',
    ]) {
      expect(prefilter.check(stage2Probe)).toEqual({ verdict: 'pass' });
    }
  });

  test('rate-limit predicate: boundary at maxSubmissionsPerWindow (ADR-002/AB-03)', () => {
    expect(prefilter.RATE_LIMIT.windowMinutes).toBeGreaterThan(0);
    expect(prefilter.exceedsRateLimit(prefilter.RATE_LIMIT.maxSubmissionsPerWindow)).toBe(false);
    expect(prefilter.exceedsRateLimit(prefilter.RATE_LIMIT.maxSubmissionsPerWindow + 1)).toBe(true);
    expect(() => prefilter.exceedsRateLimit(-1)).toThrow(TypeError);
  });
});

describe('prefilter — ADR-007 data-use gate (NFR-13)', () => {
  test('the ratified sign-off is recorded: signature + countersignature, never a bare file reference', () => {
    expect(prefilter.DATA_USE_REVIEW).toMatchObject({
      ratified: true,
      signedBy: 'Gaetan Rieben',
      signedOn: '2026-08-18',
      countersignedBy: 'Nam Tran',
      countersignedOn: '2026-08-21',
    });
    expect(Object.isFrozen(prefilter.DATA_USE_REVIEW)).toBe(true);
  });

  test('personal-shaped content is refused for live classification; clean synthetic text passes', () => {
    expect(prefilter.liveContentGate('write me at chef@example.com').allowed).toBe(false);
    expect(prefilter.liveContentGate('text +14155550123 to book').allowed).toBe(false);
    expect(prefilter.liveContentGate('call 415-555-0123 anytime').allowed).toBe(false);
    // ISO dates are not phone numbers; ordinary text is fine.
    expect(prefilter.liveContentGate('available 2030-06-01 in the evening').allowed).toBe(true);
    expect(prefilter.liveContentGate('six seats of homemade pozole').allowed).toBe(true);
    // Reasons never quote the content (NFR-13).
    const gate = prefilter.liveContentGate('reach chef@example.com');
    expect(gate.reasons.join(' ')).not.toContain('chef@example.com');
  });
});

// ---------------------------------------------------------------------------------------------
// processScan — the pipeline (FR-08 / ADR-002) against the real database
// ---------------------------------------------------------------------------------------------
describe('service.processScan — routing and the publication gate', () => {
  test('blocklist hit → rejected, decided_by=pre_filter, ZERO classifier calls', async () => {
    const listing = await makeListing({ title: 'Go die probe listing' });
    const classify = classifier({ category: 'benign', confidence: 0.99 });
    const out = await service.processScan(
      { contentType: 'listing', contentId: listing.id },
      scanDeps(classify)
    );
    expect(out.outcome).toBe('rejected');
    expect(classify).not.toHaveBeenCalled(); // ADR-002: instant, free, no provider
    const decisions = await repo.listDecisionsForContent('listing', listing.id);
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({
      outcome: 'rejected',
      decided_by: 'pre_filter',
      category: 'offensive',
      model_id: null,
    });
    const { rows } = await query(`SELECT moderation_status FROM listings WHERE id = $1`, [
      listing.id,
    ]);
    expect(rows[0].moderation_status).toBe('rejected');
  });

  test('benign at/above the threshold → approved, decided_by=llm, model id recorded', async () => {
    const listing = await makeListing({});
    const classify = classifier({
      category: 'benign',
      confidence: config.moderation.confidenceThreshold, // exact boundary approves (>=)
    });
    const out = await service.processScan(
      { contentType: 'listing', contentId: listing.id },
      scanDeps(classify)
    );
    expect(out.outcome).toBe('approved');
    const [decision] = await repo.listDecisionsForContent('listing', listing.id);
    expect(decision).toMatchObject({
      outcome: 'approved',
      decided_by: 'llm',
      category: 'benign',
      model_id: MODEL,
    });
    expect(Number(decision.confidence)).toBeCloseTo(config.moderation.confidenceThreshold, 3);
    const { rows } = await query(`SELECT moderation_status FROM listings WHERE id = $1`, [
      listing.id,
    ]);
    expect(rows[0].moderation_status).toBe('approved');
  });

  test('flagged (violating category) → escalated to the human queue; content stays PENDING', async () => {
    const listing = await makeListing({});
    const out = await service.processScan(
      { contentType: 'listing', contentId: listing.id },
      scanDeps(classifier({ category: 'fraudulent', confidence: 0.93 }))
    );
    expect(out.outcome).toBe('escalated');
    const [decision] = await repo.listDecisionsForContent('listing', listing.id);
    expect(decision).toMatchObject({ outcome: 'escalated', decided_by: 'llm' });
    const { rows: items } = await query(
      `SELECT reason, status FROM moderation_queue WHERE content_type = 'listing' AND content_id = $1`,
      [listing.id]
    );
    expect(items).toEqual([{ reason: 'flagged', status: 'open' }]);
    const { rows } = await query(`SELECT moderation_status FROM listings WHERE id = $1`, [
      listing.id,
    ]);
    expect(rows[0].moderation_status).toBe('pending'); // never published unreviewed
  });

  test('low confidence (below threshold) → escalated with reason low_confidence', async () => {
    const listing = await makeListing({});
    const out = await service.processScan(
      { contentType: 'listing', contentId: listing.id },
      scanDeps(classifier({ category: 'benign', confidence: 0.4 }))
    );
    expect(out.outcome).toBe('escalated');
    const { rows: items } = await query(
      `SELECT reason FROM moderation_queue WHERE content_type = 'listing' AND content_id = $1`,
      [listing.id]
    );
    expect(items).toEqual([{ reason: 'low_confidence' }]);
  });

  test('RT-02: a redelivered escalation files at most ONE open queue item; decisions append', async () => {
    const listing = await makeListing({});
    const deps = scanDeps(classifier({ category: 'spam', confidence: 0.95 }));
    await service.processScan({ contentType: 'listing', contentId: listing.id }, deps);
    await service.processScan({ contentType: 'listing', contentId: listing.id }, deps);
    const { rows: open } = await query(
      `SELECT count(*)::int AS n FROM moderation_queue
        WHERE content_type = 'listing' AND content_id = $1 AND status <> 'resolved'`,
      [listing.id]
    );
    expect(open[0].n).toBe(1); // the 0002 partial unique index held
    const decisions = await repo.listDecisionsForContent('listing', listing.id);
    expect(decisions).toHaveLength(2); // the decision log appends (every outcome recorded)
  });

  test('provider failure propagates UNTOUCHED and decides nothing (ADR-002/NFR-09)', async () => {
    const listing = await makeListing({});
    const outage = Object.assign(new Error('Moderation provider unavailable (unit outage)'), {
      code: 'MODERATION_PROVIDER_UNAVAILABLE',
      retryable: true,
    });
    const classify = jest.fn(async () => {
      throw outage;
    });
    await expect(
      service.processScan({ contentType: 'listing', contentId: listing.id }, scanDeps(classify))
    ).rejects.toBe(outage); // the exact error — retryability preserved for the worker
    expect(await repo.listDecisionsForContent('listing', listing.id)).toEqual([]);
    const { rows } = await query(`SELECT moderation_status FROM listings WHERE id = $1`, [
      listing.id,
    ]);
    expect(rows[0].moderation_status).toBe('pending');
  });

  test('content deleted before the scan → skipped, delivered, no decision row', async () => {
    const gone = crypto.randomUUID();
    const out = await service.processScan(
      { contentType: 'listing', contentId: gone },
      scanDeps(classifier({ category: 'benign', confidence: 0.99 }))
    );
    expect(out.outcome).toBe('skipped_missing');
    expect(await repo.listDecisionsForContent('listing', gone)).toEqual([]);
  });

  test('already-decided content → skipped; a scan can NEVER override a decision (RT-02)', async () => {
    const listing = await makeListing({ moderation_status: 'approved' });
    const classify = classifier({ category: 'offensive', confidence: 0.97 });
    const out = await service.processScan(
      { contentType: 'listing', contentId: listing.id },
      scanDeps(classify)
    );
    expect(out.outcome).toBe('skipped_decided');
    expect(classify).not.toHaveBeenCalled();
    const { rows } = await query(`SELECT moderation_status FROM listings WHERE id = $1`, [
      listing.id,
    ]);
    expect(rows[0].moderation_status).toBe('approved');
  });

  test('messages scan asynchronously: flagged stays pending+queued, benign marks approved — the row itself is untouched', async () => {
    const booking = await makeBooking({});
    const sender = await makeUser({});
    const flaggedMsg = await insertRow('messages', {
      booking_id: booking.id,
      sender_id: sender.id,
      body: 'wire transfer only please', // mock-taxonomy fraud probe (stage 2, not blocklist)
    });
    const out = await service.processScan(
      { contentType: 'message', contentId: flaggedMsg.id },
      scanDeps(classifier({ category: 'fraudulent', confidence: 0.93 }))
    );
    expect(out.outcome).toBe('escalated');
    const { rows: msg } = await query(
      `SELECT moderation_status, body FROM messages WHERE id = $1`,
      [flaggedMsg.id]
    );
    expect(msg[0].moderation_status).toBe('pending'); // scan state — delivery was never gated
    expect(msg[0].body).toBe('wire transfer only please'); // the delivered message is intact
    const { rows: items } = await query(
      `SELECT content_type FROM moderation_queue WHERE content_id = $1`,
      [flaggedMsg.id]
    );
    expect(items).toEqual([{ content_type: 'message' }]);

    const benignMsg = await insertRow('messages', {
      booking_id: booking.id,
      sender_id: sender.id,
      body: 'see you at seven, bringing dessert',
    });
    await service.processScan(
      { contentType: 'message', contentId: benignMsg.id },
      scanDeps(classifier({ category: 'benign', confidence: 0.99 }))
    );
    const { rows: clean } = await query(`SELECT moderation_status FROM messages WHERE id = $1`, [
      benignMsg.id,
    ]);
    expect(clean[0].moderation_status).toBe('approved');
  });

  test('per-author submission flood → escalated as rate_limited BEFORE any classifier call (AB-03)', async () => {
    const host = await makeUser({ can_publish_listing: true });
    let last;
    for (let i = 0; i < prefilter.RATE_LIMIT.maxSubmissionsPerWindow + 1; i += 1) {
      last = await makeListing({ host_id: host.id });
    }
    const classify = classifier({ category: 'benign', confidence: 0.99 });
    const out = await service.processScan(
      { contentType: 'listing', contentId: last.id },
      scanDeps(classify)
    );
    expect(out.outcome).toBe('escalated');
    expect(classify).not.toHaveBeenCalled();
    const { rows: items } = await query(
      `SELECT reason FROM moderation_queue WHERE content_type = 'listing' AND content_id = $1`,
      [last.id]
    );
    expect(items).toEqual([{ reason: 'rate_limited' }]);
    const [decision] = await repo.listDecisionsForContent('listing', last.id);
    expect(decision).toMatchObject({ decided_by: 'pre_filter', category: 'spam' });
  });

  test('ADR-007 gate: in LIVE mode personal-shaped content never reaches the classifier — escalated instead', async () => {
    const listing = await makeListing({
      description: 'DM me at synthetic.person@example.com for the address',
    });
    const classify = classifier({ category: 'benign', confidence: 0.99 });
    const out = await service.processScan(
      { contentType: 'listing', contentId: listing.id },
      scanDeps(classify, { mode: 'live' })
    );
    expect(out.outcome).toBe('escalated');
    expect(classify).not.toHaveBeenCalled(); // nothing personal-shaped may reach the provider
    const { rows: items } = await query(
      `SELECT reason FROM moderation_queue WHERE content_type = 'listing' AND content_id = $1`,
      [listing.id]
    );
    expect(items).toEqual([{ reason: 'data_use_gate' }]);
    const [decision] = await repo.listDecisionsForContent('listing', listing.id);
    expect(decision).toMatchObject({ decided_by: 'pre_filter', category: 'unclassified' });
    const { rows } = await query(`SELECT moderation_status FROM listings WHERE id = $1`, [
      listing.id,
    ]);
    expect(rows[0].moderation_status).toBe('pending');
  });

  test('the gate binds LIVE mode only: the deterministic mock never leaves the process (ADR-007)', async () => {
    const listing = await makeListing({
      description: 'DM me at synthetic.person@example.com for the address',
    });
    const classify = classifier({ category: 'benign', confidence: 0.99 });
    const out = await service.processScan(
      { contentType: 'listing', contentId: listing.id },
      scanDeps(classify, { mode: 'mock' })
    );
    expect(out.outcome).toBe('approved');
    expect(classify).toHaveBeenCalledTimes(1);
  });

  test('malformed payloads and a missing classifier are refused loudly', async () => {
    await expect(
      service.processScan(
        { contentType: 'nonsense', contentId: crypto.randomUUID() },
        scanDeps(classifier({}))
      )
    ).rejects.toThrow(TypeError);
    await expect(
      service.processScan({ contentType: 'listing', contentId: 'x' }, {})
    ).rejects.toThrow(/classify/);
  });
});

// ---------------------------------------------------------------------------------------------
// submitForReview — the wave-4B producer helper (ADR-001/003)
// ---------------------------------------------------------------------------------------------
describe('service.submitForReview — transactional enqueue of the scan job', () => {
  test('enqueues moderation.scan with the IDs-only wave-3 payload contract on the caller client', async () => {
    const contentId = crypto.randomUUID();
    const { job, deduped } = await withTransaction((client) =>
      service.submitForReview(client, 'review', contentId)
    );
    try {
      expect(deduped).toBe(false);
      expect(job.type).toBe('moderation.scan');
      expect(job.payload).toEqual({ contentType: 'review', contentId });
    } finally {
      await query(`DELETE FROM outbox_jobs WHERE id = $1`, [job.id]); // leave no due row behind
    }
    await expect(
      withTransaction((client) => service.submitForReview(client, 'profile', contentId))
    ).rejects.toThrow(TypeError);
  });
});

// ---------------------------------------------------------------------------------------------
// listQueue / decide — the human stage (FR-08, NFR-08, AB-08)
// ---------------------------------------------------------------------------------------------
describe('service.listQueue / service.decide — the Moderator surface', () => {
  const moderatorAuth = (id) => ({ userId: id, roles: ['user', 'moderator'] });

  async function escalatedListing(overrides = {}) {
    const listing = await makeListing(overrides);
    await service.processScan(
      { contentType: 'listing', contentId: listing.id },
      scanDeps(classifier({ category: 'spam', confidence: 0.95 }))
    );
    const { rows } = await query(
      `SELECT id FROM moderation_queue
        WHERE content_type = 'listing' AND content_id = $1 AND status = 'open'`,
      [listing.id]
    );
    return { listing, queueItemId: rows[0].id };
  }

  test('both surfaces are Moderator-only (AB-08 / SRS §2.3)', async () => {
    const ordinary = await makeUser({});
    await expect(
      service.listQueue({ userId: ordinary.id, roles: ['user'] }, { page: 1, pageSize: 20 })
    ).rejects.toMatchObject({ status: 403, code: 'NOT_MODERATOR' });
    await expect(
      service.decide({ userId: ordinary.id, roles: [] }, crypto.randomUUID(), {
        decision: 'approve',
        category: 'benign',
      })
    ).rejects.toMatchObject({ status: 403, code: 'NOT_MODERATOR' });
  });

  test('listQueue serves the item with an excerpt and the latest decision; filters work', async () => {
    const moderator = await makeUser({ roles: ['user', 'moderator'] });
    const { listing, queueItemId } = await escalatedListing({
      title: 'Queue Read Model Meal',
      description: 'The excerpt should surface this text to the moderator.',
    });
    const page = await service.listQueue(moderatorAuth(moderator.id), {
      page: 1,
      pageSize: 100,
      status: 'open',
      contentType: 'listing',
    });
    const entry = page.items.find((i) => i.id === queueItemId);
    expect(entry).toBeDefined();
    expect(entry.contentType).toBe('listing');
    expect(entry.contentId).toBe(listing.id);
    expect(entry.reason).toBe('flagged');
    expect(entry.contentStatus).toBe('pending');
    expect(entry.excerpt).toContain('Queue Read Model Meal');
    expect(entry.latestDecision).toMatchObject({
      category: 'spam',
      outcome: 'escalated',
      decidedBy: 'llm',
      modelId: MODEL,
    });
    expect(entry.latestDecision.confidence).toBeCloseTo(0.95, 3);
    expect(page.total).toBeGreaterThanOrEqual(1);
    // NFR-13/ADR-010: the moderator read model carries NO location or author identity keys.
    for (const banned of ['addressLine1', 'address_line1', 'lat', 'lng', 'authorId', 'hostId']) {
      expect(Object.keys(entry)).not.toContain(banned);
    }
    // The resolved filter excludes the open item.
    const resolvedOnly = await service.listQueue(moderatorAuth(moderator.id), {
      page: 1,
      pageSize: 100,
      status: 'resolved',
    });
    expect(resolvedOnly.items.map((i) => i.id)).not.toContain(queueItemId);
  });

  test('approve resolves the item, records the human decision + note, flips the gate, audits ONCE', async () => {
    const moderator = await makeUser({ roles: ['user', 'moderator'] });
    const { listing, queueItemId } = await escalatedListing({});
    const { events, log } = captureLog();
    const result = await service.decide(
      moderatorAuth(moderator.id),
      queueItemId,
      { decision: 'approve', category: 'benign', note: 'looks like an ordinary dinner' },
      { log }
    );
    expect(result.item.status).toBe('resolved');
    expect(result.decision).toMatchObject({
      outcome: 'approved',
      decidedBy: 'human',
      decidedByUserId: moderator.id,
    });
    const { rows } = await query(`SELECT moderation_status FROM listings WHERE id = $1`, [
      listing.id,
    ]);
    expect(rows[0].moderation_status).toBe('approved');
    const { rows: noteRow } = await query(`SELECT note FROM moderation_decisions WHERE id = $1`, [
      result.decision.id,
    ]);
    expect(noteRow[0].note).toBe('looks like an ordinary dinner');
    // NFR-08: exactly one success audit record; IDs and categories only — the note and the
    // content text stay OUT of the log stream.
    const audits = events.filter((e) => e.audit === true && e.event === 'moderation.decision');
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      outcome: 'success',
      actorUserId: moderator.id,
      entityType: 'listing',
      entityId: listing.id,
      queueItemId,
      decision: 'approved',
    });
    expect(JSON.stringify(audits[0])).not.toContain('ordinary dinner');
  });

  test('reject NEVER publishes; a second decision on the same item is a 409; unknown item 404', async () => {
    const moderator = await makeUser({ roles: ['user', 'moderator'] });
    const { listing, queueItemId } = await escalatedListing({});
    await service.decide(
      moderatorAuth(moderator.id),
      queueItemId,
      { decision: 'reject', category: 'spam' },
      { log: quietLog }
    );
    const { rows } = await query(`SELECT moderation_status FROM listings WHERE id = $1`, [
      listing.id,
    ]);
    expect(rows[0].moderation_status).toBe('rejected');
    await expect(
      service.decide(
        moderatorAuth(moderator.id),
        queueItemId,
        { decision: 'approve', category: 'benign' },
        { log: quietLog }
      )
    ).rejects.toMatchObject({ status: 409, code: 'QUEUE_ITEM_RESOLVED' });
    await expect(
      service.decide(
        moderatorAuth(moderator.id),
        crypto.randomUUID(),
        { decision: 'approve', category: 'benign' },
        { log: quietLog }
      )
    ).rejects.toMatchObject({ status: 404, code: 'QUEUE_ITEM_NOT_FOUND' });
  });
});

// ---------------------------------------------------------------------------------------------
// repo depth — the branches the service paths above do not reach
// ---------------------------------------------------------------------------------------------
describe('repo — remaining contract branches', () => {
  test('findQueueItem returns the row and null for an unknown id', async () => {
    const listing = await makeListing({});
    const { item } = await withTransaction((client) =>
      repo.insertQueueItem(client, {
        contentType: 'listing',
        contentId: listing.id,
        reason: 'flagged',
      })
    );
    const found = await repo.findQueueItem(item.id);
    expect(found).toMatchObject({ id: item.id, content_type: 'listing', status: 'open' });
    expect(await repo.findQueueItem(crypto.randomUUID())).toBeNull();
  });

  test('setModerationStatus refuses anything but approved/rejected; unknown content flips nothing', async () => {
    await expect(
      repo.setModerationStatus('listing', crypto.randomUUID(), 'pending')
    ).rejects.toThrow(TypeError);
    expect(await repo.setModerationStatus('listing', crypto.randomUUID(), 'approved')).toBe(false);
  });

  test('resolveQueueItem is idempotent-safe: an already-resolved item resolves to null', async () => {
    const listing = await makeListing({});
    const { item } = await withTransaction((client) =>
      repo.insertQueueItem(client, {
        contentType: 'listing',
        contentId: listing.id,
        reason: 'flagged',
      })
    );
    const moderator = await makeUser({});
    const first = await withTransaction((client) =>
      repo.resolveQueueItem(client, item.id, { decisionId: null, moderatorUserId: moderator.id })
    );
    expect(first.status).toBe('resolved');
    const second = await withTransaction((client) =>
      repo.resolveQueueItem(client, item.id, { decisionId: null, moderatorUserId: moderator.id })
    );
    expect(second).toBeNull(); // never re-stamps a resolution (RT-02 direction)
  });

  test('the queue-page loaders serve review and message content and tolerate an empty page', async () => {
    const booking = await makeBooking({});
    const author = await makeUser({});
    const review = await insertRow('reviews', {
      booking_id: booking.id,
      author_id: author.id,
      target_user_id: booking.guest_id,
      rating: 4,
      body: 'A review body for the excerpt loader.',
    });
    const message = await insertRow('messages', {
      booking_id: booking.id,
      sender_id: author.id,
      body: 'A message body for the excerpt loader.',
    });
    const rows = [
      { content_type: 'review', content_id: review.id },
      { content_type: 'message', content_id: message.id },
    ];
    const contentByKey = await repo.loadContentForQueuePage(rows);
    expect(contentByKey.get(`review:${review.id}`).text).toContain('review body');
    expect(contentByKey.get(`message:${message.id}`).text).toContain('message body');
    expect(await repo.loadLatestDecisionsForQueuePage([])).toEqual(new Map());
    expect((await repo.loadContentForQueuePage([])).size).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// contracts — handler shape, schemas, published constants
// ---------------------------------------------------------------------------------------------
describe('published contracts (build-plan §4A / §7)', () => {
  test('the moderation.scan handler exports the worker contract and injects the adapter', () => {
    const handler = require('../../src/outbox/handlers/moderationScan');
    expect(handler.type).toBe('moderation.scan');
    expect(typeof handler.handle).toBe('function');
    expect(service.JOB_TYPE).toBe('moderation.scan');
  });

  test('route schemas exist and enforce the decision vocabulary (NFR-11)', () => {
    expect(moderationSchemas.queueQuery.safeParse({}).success).toBe(true);
    expect(
      moderationSchemas.decisionBody.safeParse({ decision: 'approve', category: 'benign' }).success
    ).toBe(true);
    expect(
      moderationSchemas.decisionBody.safeParse({ decision: 'publish', category: 'benign' }).success
    ).toBe(false);
    expect(
      moderationSchemas.decisionBody.safeParse({ decision: 'approve', category: 'okayish' }).success
    ).toBe(false);
    // AB-06: the note is sanitized — markup cannot survive validation.
    const parsed = moderationSchemas.decisionBody.safeParse({
      decision: 'reject',
      category: 'spam',
      note: '<script>alert(1)</script> spammy',
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data.note).not.toContain('<script');
  });

  test('PROMPT_VERSION is published for the IT-03 harness (ADR-008)', () => {
    expect(typeof service.PROMPT_VERSION).toBe('string');
    expect(service.PROMPT_VERSION.length).toBeGreaterThan(0);
  });
});
