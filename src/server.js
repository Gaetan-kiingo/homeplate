// U1-HTTP — HTTPS entrypoint. Binds the Express app (src/app.js) to a TLS listener that
// accepts TLS 1.2+ ONLY; there is no plain-HTTP listener anywhere in this process, so a
// plain-HTTP client either fails its handshake here or is refused 403 'HTTPS required'
// by the transport middleware — it is never served content.
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-03, AB-05 — HTTPS/TLS 1.2+ only (ADR-006). The literal below is asserted by
//                   tests/unit/app.test.js reading these options (ST-01):
//                       minVersion: 'TLSv1.2'
//   NFR-08        — startup logs the mounted/missing module summary and the bound port;
//                   SIGTERM/SIGINT drain connections before exit.
//
// Local TLS material comes from scripts/gen-dev-certs.sh (git-ignored certs/); paths are
// configuration (TLS_CERT_PATH / TLS_KEY_PATH — src/config, U1-CONFIG).
'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');
const { createApp, resolveLogger } = require('./app');

const ROOT = path.join(__dirname, '..');

/**
 * TLS listener options: TLS 1.2 minimum (NFR-03, AB-05, ST-01) plus the configured
 * certificate/key. Throws with a remediation hint when the material is missing.
 */
function buildTlsOptions(config) {
  const certPath = path.resolve(ROOT, config.server.tls.certPath);
  const keyPath = path.resolve(ROOT, config.server.tls.keyPath);
  for (const [what, p] of [
    ['certificate', certPath],
    ['private key', keyPath],
  ]) {
    if (!fs.existsSync(p)) {
      throw new Error(
        `TLS ${what} not found at ${p} — for local development run scripts/gen-dev-certs.sh ` +
          '(certs/ is git-ignored; NFR-03 forbids serving without TLS)'
      );
    }
  }
  return {
    minVersion: 'TLSv1.2', // NFR-03 / ST-01 — do not lower; asserted literally by tests
    cert: fs.readFileSync(certPath),
    key: fs.readFileSync(keyPath),
  };
}

/**
 * Create, bind and return the HTTPS server. `listening` has not necessarily fired when
 * this returns; callers await the event (scripts and tests do).
 */
function start({ config = require('./config'), logger: injectedLogger } = {}) {
  const logger = resolveLogger(injectedLogger);
  const app = createApp({ config, logger });
  const server = https.createServer(buildTlsOptions(config), app);

  server.listen(config.server.port, () => {
    const { mounted, missing } = app.locals.routes;
    logger.info(
      `server: HTTPS listening on port ${server.address().port} (TLS >= 1.2); ` +
        `modules mounted: [${mounted.map((m) => m.name).join(', ') || 'none'}]; ` +
        `awaiting later waves: [${missing.join(', ') || 'none'}]`
    );
  });

  return server;
}

// Hard-stop delay for shutdown drains that hang (e.g. a socket held open past close()).
// Default 10 s — well under orchestrator kill windows. SERVER_SHUTDOWN_HARD_STOP_MS (a
// positive integer of milliseconds) tunes it per deployment; it is an operational knob of
// this entrypoint — not an ADR-009 product cap, and not a secret — so like LOG_LEVEL
// (src/lib/logger.js) it is read here rather than through src/config/schema.js. The
// coverage lane's spawn test shortens it to keep the real-process hard-stop drill fast.
const DEFAULT_HARD_STOP_MS = 10000;
const envHardStop = Number.parseInt(process.env.SERVER_SHUTDOWN_HARD_STOP_MS ?? '', 10);
const HARD_STOP_MS =
  Number.isInteger(envHardStop) && envHardStop > 0 ? envHardStop : DEFAULT_HARD_STOP_MS;

/**
 * Graceful drain: stop accepting, let in-flight requests finish, then exit (NFR-08).
 * Repeated signals are idempotent (first one wins). `hardStopMs`/`exit` are injectable so
 * tests/coverage/server-shutdown.test.js can exercise the drain, close-failure (exit 1)
 * and hard-stop paths in-process without terminating the test runner; production callers
 * pass neither. Returns the shutdown function for the same reason.
 */
function wireShutdown(server, logger, { hardStopMs = HARD_STOP_MS, exit = process.exit } = {}) {
  let closing = false;
  const shutdown = (signal) => {
    if (closing) return;
    closing = true;
    logger.info(`server: received ${signal} — draining connections`);
    server.close((err) => {
      if (err) {
        logger.error(`server: close failed: ${err.message}`);
        exit(1);
        return;
      }
      exit(0);
    });
    // Hard stop if drains hang (keep-alive sockets), well under orchestrator kill windows.
    setTimeout(() => exit(0), hardStopMs).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return shutdown;
}

if (require.main === module) {
  const logger = resolveLogger();
  try {
    const server = start({ logger });
    wireShutdown(server, logger);
  } catch (err) {
    // Fail-fast surface: invalid env (U1-CONFIG), production+relaxed transport (NFR-03),
    // or missing TLS material all land here with an actionable message.
    logger.error(`server: refusing to start — ${err.message}`);
    process.exit(1);
  }
}

module.exports = { start, buildTlsOptions, wireShutdown };
