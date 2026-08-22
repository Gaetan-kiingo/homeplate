// scripts/requeue-dead-letters.js — U4-MODERATION: operator tool that re-opens dead-lettered
// outbox jobs after the underlying fault is fixed (NFR-09 recovery leg of ADR-001/003).
//
// Why it exists NOW: wave 3 enqueued 'moderation.scan' jobs with no handler (commit 3136b91
// onward), so every scan retried and dead-lettered — failing SAFE (content stayed pending,
// ADR-002) but stranding the backlog. U4-MODERATION lands the handler; this script re-opens
// those dead letters via outbox.requeueDeadLetter (fresh retry budget, available now) so the
// running worker drains them through the real pipeline. The drain itself is proven by
// execution in tests/tc-booking/tc08-moderation-substrate.test.js.
//
// Requirement traceability (SRS Appendix B):
//   FR-08  — the wave-3 scan backlog reaches a MODERATION_DECISION once requeued.
//   NFR-09 — dead-letter visibility + operator requeue is the documented recovery path.
//   NFR-08 — every requeue is logged as a structured line with the job id and type only.
//
// Usage:
//   node scripts/requeue-dead-letters.js --type moderation.scan [--limit 500] [--dry-run]
//   node scripts/requeue-dead-letters.js --all              # every dead job, any type
//
// Concurrency note (tests/helpers/env.js CONCURRENCY RULE): run this against the DEV/PROD
// database (DATABASE_URL / .env). Never point it at a lane's *_test database while a Jest
// run holds the 'homeplate_test_suite' advisory lock — the suite requeues in-process instead.
'use strict';

const path = require('path');

/* istanbul ignore next -- .env loading is CLI-only; the suite pins NODE_ENV=test */
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const outbox = require('../src/outbox/outbox');
const { closePool } = require('../src/db/pool');

/** Parse CLI arguments. Exported for tests; throws on anything unknown (fail fast). */
function parseArgs(argv) {
  const args = { type: undefined, all: false, limit: 500, dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--type') {
      args.type = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--type=')) {
      args.type = arg.slice('--type='.length);
    } else if (arg === '--limit') {
      args.limit = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--limit=')) {
      args.limit = Number(arg.slice('--limit='.length));
    } else if (arg === '--all') {
      args.all = true;
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else {
      throw new Error(
        `unknown argument "${arg}" — usage: node scripts/requeue-dead-letters.js ` +
          '(--type <jobType> | --all) [--limit N] [--dry-run]'
      );
    }
  }
  if (!args.all && (typeof args.type !== 'string' || args.type.length === 0)) {
    throw new Error('requeue-dead-letters: pass --type <jobType> (e.g. moderation.scan) or --all');
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 1000) {
    throw new Error('requeue-dead-letters: --limit must be an integer in 1..1000');
  }
  return args;
}

/**
 * Re-open dead-lettered jobs (optionally of one type) with a fresh retry budget.
 * @param {{type?: string, limit?: number, dryRun?: boolean, log?: object}} options
 * @returns {Promise<{deadListed: number, matched: number, requeued: object[]}>}
 */
async function requeueDeadLetters({ type, limit = 500, dryRun = false, log = console } = {}) {
  // listDeadLetters caps at 1000 per call; page until we've seen them all or hit `limit`.
  const dead = await outbox.listDeadLetters({ limit: 1000 });
  const matched = dead.filter((job) => !type || job.type === type).slice(0, limit);
  const requeued = [];
  for (const job of matched) {
    if (dryRun) {
      log.log(`[dry-run] would requeue #${job.id} (${job.type})`);
      continue;
    }
    const row = await outbox.requeueDeadLetter(job.id);
    if (row) {
      requeued.push(row);
      // NFR-08: structured, ID-only line — payloads/errors are already on the row itself.
      log.log(
        JSON.stringify({
          event: 'outbox_dead_letter_requeued',
          jobId: String(row.id),
          type: row.type,
        })
      );
    }
  }
  return { deadListed: dead.length, matched: matched.length, requeued };
}

/**
 * CLI entry. `argv`/`io` are injectable so the operator surface itself is testable
 * in-process (the suite must not spawn a child against the lane database — it would contend
 * on the suite advisory lock; tests/helpers/env.js concurrency rule).
 */
async function main(argv = process.argv.slice(2), io = console) {
  const args = parseArgs(argv);
  const result = await requeueDeadLetters({
    type: args.all ? undefined : args.type,
    limit: args.limit,
    dryRun: args.dryRun,
    log: io,
  });
  io.log(
    `dead letters listed: ${result.deadListed}; matched: ${result.matched}; ` +
      `requeued: ${result.requeued.length}${args.dryRun ? ' (dry run)' : ''}`
  );
  io.log(
    'requeued jobs are pending and available now — the running worker (npm run worker) drains them.'
  );
  return result;
}

/* istanbul ignore next -- process wiring (pool close + exit codes), exercised only when run
   as a CLI; the suite covers main() in-process (tc08) */
if (require.main === module) {
  main()
    .then(async () => {
      await closePool();
      process.exit(0);
    })
    .catch(async (err) => {
      console.error(`requeue-dead-letters failed: ${err.message}`);
      try {
        await closePool();
      } catch (_closeErr) {
        // the original failure is the story; a close error must not mask it
      }
      process.exit(1);
    });
}

module.exports = { parseArgs, requeueDeadLetters, main };
