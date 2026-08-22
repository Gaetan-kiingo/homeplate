// scripts/backup.js — U4-PRIVACY: the NFR-12 data-lifecycle maintenance CLI (ST-05's
// executable backup-expiry object; closes findings STS-W3-03 / F-03).
//
// NFR-12: "Database backups containing deleted data shall expire within 30 days." Dumps are
// produced by the operator or the storage provider (this free-tier deployment schedules none
// itself); THIS script makes the retention policy executable rather than documented-only:
// run it from the same cron that takes the dumps and every file in the backup directory
// older than BACKUP_RETENTION_DAYS (config.backup.retentionDays, default 30 — never inlined
// here) is deleted. Managed stores need the equivalent provider-side setting (README.md,
// "Deployment — data at rest").
//
// It also carries the NFR-12 24-month inactivity sweep (--sweep-inactivity): flagging is a
// periodic operator concern exactly like backup pruning, so the one lifecycle cron entry
// runs both. The sweep only writes data_requests rows + outbox jobs; the notice email and
// the erasure themselves run in the outbox worker (ADR-001/003).
//
// Requirement traceability (SRS Appendix B):
//   NFR-12 (ST-05) — prune: backups older than the validated retention window expire;
//                    --sweep-inactivity: accounts stale for config.privacy.inactivityMonths
//                    are flagged for notice + erasure.
//   NFR-08         — every pruned file and flagged account is logged as a structured line
//                    (file name / user id only — no PII).
//
// Usage:
//   node scripts/backup.js --dir /var/backups/homeplate [--dry-run]
//   node scripts/backup.js --sweep-inactivity [--limit 100]
//
// Concurrency note (tests/helpers/env.js CONCURRENCY RULE): run this against the DEV/PROD
// database (DATABASE_URL / .env). Never point it at a lane's *_test database while a Jest
// run holds the 'homeplate_test_suite' advisory lock — the suite sweeps in-process instead.
'use strict';

const fs = require('fs');
const path = require('path');

/* istanbul ignore next -- .env loading is CLI-only; the suite pins NODE_ENV=test */
if (process.env.NODE_ENV !== 'test') {
  require('dotenv').config({ path: path.join(__dirname, '..', '.env') });
}

const DAY_MS = 24 * 3600 * 1000;

/** Parse CLI arguments. Exported for tests; throws on anything unknown (fail fast). */
function parseArgs(argv) {
  const args = { dir: undefined, dryRun: false, sweepInactivity: false, limit: 100 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dir') {
      args.dir = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--dir=')) {
      args.dir = arg.slice('--dir='.length);
    } else if (arg === '--limit') {
      args.limit = Number(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--limit=')) {
      args.limit = Number(arg.slice('--limit='.length));
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--sweep-inactivity') {
      args.sweepInactivity = true;
    } else {
      throw new Error(
        `unknown argument "${arg}" — usage: node scripts/backup.js ` +
          '(--dir <backup dir> [--dry-run] | --sweep-inactivity [--limit N])'
      );
    }
  }
  if (!args.sweepInactivity && (typeof args.dir !== 'string' || args.dir.length === 0)) {
    throw new Error('backup: pass --dir <backup dir> (prune mode) or --sweep-inactivity');
  }
  if (!Number.isInteger(args.limit) || args.limit < 1 || args.limit > 10000) {
    throw new Error('backup: --limit must be an integer in 1..10000');
  }
  return args;
}

/**
 * Delete every regular file in `dir` whose mtime is older than `retentionDays` days before
 * `now` (NFR-12 backup expiry). Pure with respect to its inputs — `now` is the
 * clock-injection seam ST-05 uses, and `retentionDays` comes from config.backup at the call
 * site so no policy number lives here.
 *
 * @param {{dir: string, retentionDays: number, now?: Date, dryRun?: boolean, log?: Function}} opts
 * @returns {{pruned: string[], kept: string[], cutoff: Date}} file basenames by outcome
 */
function pruneBackups({ dir, retentionDays, now = new Date(), dryRun = false, log = () => {} }) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new TypeError('pruneBackups: dir is required');
  }
  if (!Number.isInteger(retentionDays) || retentionDays < 1) {
    throw new TypeError('pruneBackups: retentionDays must be a positive integer');
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new Error(`pruneBackups: "${dir}" is not a directory`);
  }

  const cutoff = new Date(now.getTime() - retentionDays * DAY_MS);
  const pruned = [];
  const kept = [];

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue; // never recurse; a backup dir holds flat dump files
    const full = path.join(dir, entry.name);
    const { mtime } = fs.statSync(full);
    if (mtime < cutoff) {
      if (!dryRun) fs.unlinkSync(full);
      pruned.push(entry.name);
      log({
        event: 'backup_pruned',
        file: entry.name,
        mtime: mtime.toISOString(),
        cutoff: cutoff.toISOString(),
        dryRun,
      });
    } else {
      kept.push(entry.name);
    }
  }

  return { pruned, kept, cutoff };
}

/* istanbul ignore next -- CLI entry; the exported functions above are what the suite runs */
async function main() {
  const args = parseArgs(process.argv.slice(2));
  // Lazy: config validation (and the DB pool for the sweep) load only when actually running.
  const config = require('../src/config');
  const jsonLine = (fields) => console.log(JSON.stringify(fields));

  if (args.sweepInactivity) {
    const privacyService = require('../src/modules/privacy/service');
    const { closePool } = require('../src/db/pool');
    const { closeRedis } = require('../src/db/redis');
    try {
      const { flagged } = await privacyService.runInactivitySweep({ limit: args.limit });
      jsonLine({
        event: 'inactivity_sweep_done',
        flagged: flagged.length,
        userIds: flagged.map((f) => f.userId),
      });
    } finally {
      await closePool();
      await closeRedis();
    }
    return;
  }

  const { pruned, kept, cutoff } = pruneBackups({
    dir: args.dir,
    retentionDays: config.backup.retentionDays,
    dryRun: args.dryRun,
    log: jsonLine,
  });
  jsonLine({
    event: 'backup_prune_done',
    dir: args.dir,
    retentionDays: config.backup.retentionDays,
    cutoff: cutoff.toISOString(),
    pruned: pruned.length,
    kept: kept.length,
    dryRun: args.dryRun,
  });
}

/* istanbul ignore next */
if (require.main === module) {
  main().catch((err) => {
    console.error(`backup: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, pruneBackups };
