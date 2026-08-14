// scripts/worker.js — U2-OUTBOX: standalone outbox worker process (`npm run worker`;
// `npm run dev` runs it next to the API via scripts/dev.js — build-plan §2).
//
// Requirement traceability (SRS Appendix B):
//   FR-13  — this process delivers the transactionally-enqueued notification jobs, outside
//            every request path (ADR-001/003: only worker code calls external adapters).
//   NFR-09 — retry/backoff/dead-letter live in src/outbox/worker.js; this wrapper only wires
//            startup, graceful shutdown and handler discovery.
//   NFR-08 — worker log lines are structured JSON carrying each job's originating
//            correlation ID (LOG_LEVEL=info or lower to see them).
//
// Usage:
//   node scripts/worker.js [--handlers-dir <path>]
// --handlers-dir overrides the handler discovery directory (default src/outbox/handlers) —
// used by tests and by operators running a worker against a curated handler subset.
'use strict';

const { logger } = require('../src/lib/logger');
const { loadHandlers } = require('../src/outbox/dispatch');
const { startWorker } = require('../src/outbox/worker');
const { closePool } = require('../src/db/pool');

function parseArgs(argv) {
  const args = { handlersDir: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--handlers-dir') {
      args.handlersDir = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--handlers-dir=')) {
      args.handlersDir = arg.slice('--handlers-dir='.length);
    } else {
      throw new Error(
        `unknown argument "${arg}" — usage: node scripts/worker.js [--handlers-dir <path>]`
      );
    }
    if (args.handlersDir === undefined || args.handlersDir === '') {
      throw new Error('--handlers-dir requires a path');
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = logger.child({ component: 'outbox-worker', pid: process.pid });

  // Handler discovery at startup (build-plan §1 convention 3). A malformed handler aborts
  // here — better a dead process than a worker silently stranding a job type (NFR-09).
  const registry = loadHandlers({
    ...(args.handlersDir ? { dir: args.handlersDir } : {}),
    log,
  });
  const worker = startWorker({ registry, log });

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ event: 'outbox_worker_shutdown', signal }, 'outbox_worker_shutdown');
    try {
      await worker.stop(); // waits for the in-flight poll: no job is abandoned mid-commit
      await closePool();
      // Handlers may have pulled in the Redis client transitively; close it only if loaded.
      const redisPath = require.resolve('../src/db/redis');
      if (require.cache[redisPath]) {
        await require.cache[redisPath].exports.closeRedis();
      }
      process.exit(0);
    } catch (err) {
      log.error({ event: 'outbox_worker_shutdown_error', err }, 'outbox_worker_shutdown_error');
      process.exit(1);
    }
  }
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  // Startup failure (bad config, unreachable database, malformed handler): fail fast.
  console.error(`outbox worker failed to start: ${err.message}`);
  process.exit(1);
});
