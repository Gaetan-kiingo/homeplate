// tests/coverage/server-shutdown.test.js — COVERAGE lane, COV-W4-04.
//
// src/server.js graceful-shutdown wiring (wireShutdown + its signal/close/timer handlers)
// was the one product-adjacent region of the tree with no instrumentation-visible execution:
// coverage-lane.test.js §4 already proves "SIGTERM on a quiet server drains to exit 0" in a
// REAL process, but child-process execution is invisible to Jest instrumentation, and the
// close-failure (exit 1) and hard-stop-timer paths had never executed anywhere. This file is
// the exercise record for those paths. Traceability: NFR-08 (drain + startup/refusal logging),
// NFR-03 (fail-fast refusal without TLS material).
//
//  §1 exercises wireShutdown IN-PROCESS through its injectable seams (hardStopMs/exit), so
//     lcov finally records the drain, close-failure, hard-stop and signal-wrapper branches.
//     Fake timers make the 10 s default hard stop deterministic and leave no real handle.
//  §2 spawns the REAL entrypoint holding an open keep-alive TLS socket through SIGTERM: the
//     process must still exit 0, via the drain (Node >= 19 close() destroys idle keep-alive
//     connections) and NOT by waiting out the hard stop — the elapsed bound tells the two
//     apart, with SERVER_SHUTDOWN_HARD_STOP_MS shortened so a regression fails in seconds.
//     (Forcing the hard stop itself in a real process would need a request handler that
//     never completes — a test-only hang endpoint in production code — so the timer's own
//     firing is covered in-process in §1 instead.)
//  §3 spawns the CLI refusal path: missing TLS material must log the remediation hint and
//     exit 1, never listen on plain HTTP (NFR-03; same spawn pattern as migrate-cli.test.js).
'use strict';

const path = require('path');
const tls = require('tls');
const { spawn, spawnSync } = require('child_process');

const { wireShutdown } = require('../../src/server');

const ROOT = path.resolve(__dirname, '..', '..');
const SERVER = path.join(ROOT, 'src', 'server.js');

// ---------------------------------------------------------------------------------------------
// §1 — in-process: every wireShutdown branch, instrumentation-visible
// ---------------------------------------------------------------------------------------------

describe('coverage lane — wireShutdown branches in-process (COV-W4-04)', () => {
  const SIGNALS = ['SIGINT', 'SIGTERM'];
  let listenersBefore;

  const makeLogger = () => ({ info: jest.fn(), error: jest.fn() });
  const addedListeners = (signal) =>
    process.listeners(signal).filter((l) => !listenersBefore[signal].includes(l));

  beforeEach(() => {
    jest.useFakeTimers();
    listenersBefore = Object.fromEntries(SIGNALS.map((s) => [s, process.listeners(s)]));
  });

  afterEach(() => {
    // wireShutdown registers real SIGINT/SIGTERM listeners on the shared Jest process;
    // remove exactly the ones each test added so nothing leaks across suites.
    try {
      for (const s of SIGNALS) {
        for (const l of addedListeners(s)) process.removeListener(s, l);
      }
    } finally {
      jest.useRealTimers();
    }
  });

  test('the SIGTERM wrapper drains once and exits 0; a second signal is a no-op', () => {
    const exit = jest.fn();
    const logger = makeLogger();
    const server = { close: jest.fn((cb) => cb()) };
    wireShutdown(server, logger, { exit });

    const term = addedListeners('SIGTERM');
    const int = addedListeners('SIGINT');
    expect(term).toHaveLength(1);
    expect(int).toHaveLength(1);

    term[0](); // invoke the registered `() => shutdown('SIGTERM')` wrapper directly
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(0);
    expect(
      logger.info.mock.calls.some(([msg]) => String(msg).includes('received SIGTERM'))
    ).toBe(true);

    int[0](); // second signal while closing: the `closing` guard must not drain again
    expect(server.close).toHaveBeenCalledTimes(1);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  test('a close() failure logs the cause and exits 1, not 0', () => {
    const exit = jest.fn();
    const logger = makeLogger();
    const server = { close: (cb) => cb(new Error('boom')) };
    const shutdown = wireShutdown(server, logger, { exit });

    shutdown('SIGINT');
    expect(exit).toHaveBeenCalledTimes(1); // hard stop not yet due — the error path alone ran
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(logger.error.mock.calls[0][0])).toContain('close failed: boom');
  });

  test('a drain that never completes is hard-stopped at the default 10 s with exit 0', () => {
    const exit = jest.fn();
    const logger = makeLogger();
    const server = { close: jest.fn() }; // never calls back — a hung drain
    const shutdown = wireShutdown(server, logger, { exit });

    shutdown('SIGTERM');
    expect(exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(9999);
    expect(exit).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1); // 10 000 ms — the documented default boundary
    expect(exit).toHaveBeenCalledWith(0);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// §2 — real process: SIGTERM with a held keep-alive socket still exits 0, via the drain
// ---------------------------------------------------------------------------------------------

describe('coverage lane — real-process shutdown with a held keep-alive socket (COV-W4-04)', () => {
  const PORT = 8445; // coverage-lane.test.js §4 owns 8444
  const HARD_STOP_MS = 3000; // shortened so a drain regression fails in seconds, not 10 s
  let child;
  let sock;

  afterAll(() => {
    try {
      if (sock && !sock.destroyed) sock.destroy();
    } finally {
      // Never orphan a spawned server against the shared dev box (globalTeardown policy).
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  });

  test(
    'SIGTERM exits 0 before the hard stop even while a keep-alive socket is held open',
    async () => {
      child = spawn(process.execPath, [SERVER], {
        env: {
          ...process.env,
          PORT: String(PORT),
          LOG_LEVEL: 'info', // NODE_ENV=test defaults the logger to silent; the listen line is the sync point
          SERVER_SHUTDOWN_HARD_STOP_MS: String(HARD_STOP_MS),
        },
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');

      // 1. Wait for the NFR-08 startup line before touching the port.
      await new Promise((resolve, reject) => {
        let out = '';
        const timer = setTimeout(() => {
          done(new Error(`server never logged the listen line; output so far:\n${out}`));
        }, 10000);
        const onData = (chunk) => {
          out += chunk;
          if (out.includes('HTTPS listening on port')) done();
        };
        const onGone = (codeOrErr) => {
          done(new Error(`server ended before listening (${codeOrErr}); output:\n${out}`));
        };
        function done(err) {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          child.stderr.off('data', onData);
          child.off('exit', onGone);
          child.off('error', onGone);
          if (err) reject(err);
          else resolve();
        }
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.on('exit', onGone);
        child.on('error', onGone);
      });

      // 2. Complete one real request over TLS and HOLD the keep-alive socket open.
      sock = await new Promise((resolve, reject) => {
        const s = tls.connect({ host: '127.0.0.1', port: PORT, rejectUnauthorized: false }, () => {
          s.write('GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n\r\n');
        });
        s.setEncoding('utf8');
        let buf = '';
        s.on('data', (chunk) => {
          buf += chunk;
          if (buf.includes('\r\n\r\n')) resolve(s); // response headers arrived; socket stays open
        });
        s.on('error', reject);
      });

      // 3. SIGTERM while the socket is held. The drain must win (close() destroys the idle
      //    keep-alive connection) — exit 0 well BEFORE the hard stop, or the elapsed bound
      //    catches a server that only died because the timer saved it.
      const t0 = Date.now();
      const code = await new Promise((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error('server did not exit within 8 s of SIGTERM')),
          8000
        );
        child.once('exit', (c) => {
          clearTimeout(timer);
          resolve(c);
        });
        child.kill('SIGTERM');
      });
      const elapsed = Date.now() - t0;

      expect(code).toBe(0);
      expect(elapsed).toBeLessThan(HARD_STOP_MS - 500);
    },
    20000
  );
});

// ---------------------------------------------------------------------------------------------
// §3 — real process: missing TLS material refuses to start with exit 1 (NFR-03)
// ---------------------------------------------------------------------------------------------

describe('coverage lane — CLI refusal path without TLS material (COV-W4-04)', () => {
  test('a missing certificate logs the remediation hint and exits 1', () => {
    const res = spawnSync(process.execPath, [SERVER], {
      env: {
        ...process.env,
        LOG_LEVEL: 'error',
        TLS_CERT_PATH: 'certs/does-not-exist.pem', // buildTlsOptions must throw, never listen
      },
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 15000,
    });
    expect(res.status).toBe(1);
    expect(res.stdout + res.stderr).toContain('refusing to start');
  });
});
