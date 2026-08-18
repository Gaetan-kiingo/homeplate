// tests/helpers/globalTeardown.js — deliberate design decision, not an omission:
// the seeded test database and test Redis DB are LEFT IN PLACE after a run so failures can be
// inspected post-mortem. Reproducibility is provided at the START of every run by
// globalSetup (schema reset + migrate + seed + Redis flush), which is what the SRS §4.1
// "reproducible seed/teardown" protocol requires. Docker containers keep running; stop them
// with `docker compose down` when done.
//
// Two things MUST happen here, in this order:
//
//   1. RELEASE THE SUITE ADVISORY LOCK taken by globalSetup (verification-report F-1). Ending the
//      session frees the lock so a waiting run can start.
//
//   2. LEAVE THE EVENT LOOP EMPTY (finding ADRC2-02, NFR-02). This is the run's last-resort
//      cleanup boundary and the only code that can fill that role — see below.
//
// WHY THE RUN NEEDS A LAST-RESORT BOUNDARY AT ALL
// jest.config.js sets maxWorkers=1, and @jest/core's shouldRunInBand() returns true whenever
// maxWorkers <= 1, so all ~70 test files execute IN JEST'S OWN PROCESS — there is no child worker
// to take the leaked handles down with it. Each file gets a fresh module registry, hence its own
// copy of every singleton (the pg Pool from src/db/pool.js, the ioredis client from src/db/redis.js,
// any http/https listener it binds, any child process it spawns), and the cleanup contract is
// "every file closes its own copies in afterAll". That contract fails OPEN and fails SILENTLY:
//   - a suite that closes the pool but not the Redis client (it reached ioredis indirectly through
//     src/lib/cache.js and never noticed) leaks a connected socket;
//   - a suite that opens a client inside a test body and closes it on the success path leaks one
//     only on the runs where that test fails — which is exactly why this hang is intermittent and
//     why it never reproduces when the same file is run alone and green;
//   - `server.close()` in an afterAll never calls back while a keep-alive connection is open, so a
//     hook timeout leaves the listener bound.
// A connected, ref'd socket has no idle timeout of its own, so ONE of these keeps Jest alive
// FOREVER: the run prints a green summary, then "Jest did not exit one second after the test run
// has completed", and every automated invocation reads as hung (one had to be killed at 8m20s
// despite the tests finishing in 91s). In CI the job burns to its timeout and the run reports
// nothing. globalTeardown is the only hook that runs once, at the end, in that same process, so it
// is the only place a run-level guarantee can be made.
//
// WHAT THIS FILE DOES ABOUT IT — and what it deliberately does NOT do
// It NAMES every handle that is still open and still holding the loop (type, remote address, port,
// listening address, child pid) together with the API that should have closed it, so the offending
// suite is identifiable from the run's own log instead of from a bisect. THEN it releases the
// loop's claim on those handles so the process exits.
//
// The release is `unref()`, not `destroy()`/`quit()`, and that choice is load-bearing:
//   - unref() only withdraws the handle's vote to keep the event loop alive. It closes nothing, so
//     no 'error'/'end'/'close' handler fires inside a suite's still-loaded module graph and no
//     result already reported can change. The OS closes the fd when the process exits.
//   - destroy() would be WORSE THAN THE BUG for the Redis client: src/db/redis.js's retryStrategy
//     never returns null (NFR-09 — a transient outage must not become a permanent one), so
//     destroying its socket makes ioredis immediately open a NEW socket and arm a reconnect timer.
//     The run would keep hanging, now for a reason invented here.
// A child process is the one handle that is killed rather than unref'd: unref'ing it would let Jest
// exit and leave an ORPHANED node process running against the shared database (observed in this
// project at 23 hours of CPU). The run spawned it, so the run kills it, loudly.
//
// This is a backstop, NOT the fix for the suite that leaked. Nothing is hidden: the warning is
// unconditional, and TEST_STRICT_HANDLES=1 turns it into a hard failure (non-zero exit) for CI or
// for a determinism gate that should refuse to go green over a leak. The permanent fix always
// belongs in the owning suite's afterAll, inside a finally. --forceExit remains banned: it kills
// the process before reporters and coverage finish, which hides the leak instead of naming it.
'use strict';

/** Ports whose owner is unambiguous in this stack; used to name the API that should have closed. */
const PORT_OWNERS = {
  5432: 'PostgreSQL — src/db/pool.js closePool() / tests/helpers/db.js closeDb(), or a bare pg Client the suite opened itself (`await client.end()` in a finally)',
  6379: 'Redis — src/db/redis.js closeRedis() / tests/helpers/redis.js closeTestRedis()',
  9000: 'MinIO object storage — the ADR-004 adapter client (s3.destroy())',
};

/** The port a listening handle is bound to, or null when it is not a bound TCP server. */
function listeningPort(handle) {
  if (typeof handle.address !== 'function') return null;
  try {
    const addr = handle.address();
    return addr && typeof addr === 'object' && typeof addr.port === 'number' ? addr : null;
  } catch {
    return null;
  }
}

/**
 * Classify one active handle. Returns null for the process's own stdio (a pipe or tty for
 * stdin/stdout/stderr): those are Jest's, they hold nothing after the run, and reporting them
 * would bury the one line that matters.
 * @param {object} handle a member of process._getActiveHandles()
 * @returns {{kind: string, detail: string, handle: object}|null}
 */
function describeHandle(handle) {
  const kind = (handle && handle.constructor && handle.constructor.name) || typeof handle;

  if (typeof handle.pid === 'number' && typeof handle.kill === 'function') {
    // Jest's own machinery (jest-worker, jest-haste-map's crawler) is ended by @jest/core before
    // this hook runs, so one still here is not ours to judge — never report or kill it.
    const argvList = Array.isArray(handle.spawnargs) ? handle.spawnargs : [];
    if (argvList.some((a) => typeof a === 'string' && a.includes('jest-worker'))) return null;
    const argv = argvList.length > 0 ? ` argv=[${argvList.join(' ')}]` : '';
    return {
      kind,
      handle,
      detail:
        `child process pid ${handle.pid}${argv} => a process the suite spawned and never awaited; ` +
        "kill it and await its 'exit' in a finally",
    };
  }

  if (typeof handle.remotePort === 'number') {
    const owner = PORT_OWNERS[handle.remotePort];
    return {
      kind,
      handle,
      detail:
        `connected to ${handle.remoteAddress}:${handle.remotePort}` +
        (owner ? ` => ${owner}` : ' => an outbound connection no afterAll closed'),
    };
  }

  const addr = listeningPort(handle);
  if (addr) {
    return {
      kind,
      handle,
      detail:
        `listening on ${addr.address}:${addr.port} => a server the suite bound; close() it in ` +
        'afterAll and await the callback (close() does not return while a keep-alive socket is open)',
    };
  }

  // No peer, no bound port, no pid: stdio, or a socket still mid-connect. Only the latter is worth
  // a line, and it is indistinguishable from stdio here, so stay quiet rather than cry wolf.
  return null;
}

/**
 * Handles that are still open AND still ref'd, i.e. the ones that can hold Node's event loop open
 * after the run. Unref'd handles (Node unrefs idle keep-alive agent sockets), destroyed ones and
 * stdio pipes/ttys cannot, so they are not reported.
 * @returns {Array<{kind: string, detail: string, handle: object}>}
 */
function leakedHandles() {
  if (typeof process._getActiveHandles !== 'function') return [];
  const found = [];
  for (const handle of process._getActiveHandles()) {
    if (!handle || typeof handle !== 'object') continue;
    if (handle.destroyed === true) continue;
    if (typeof handle.hasRef === 'function' && !handle.hasRef()) continue;
    const described = describeHandle(handle);
    if (described) found.push(described);
  }
  return found;
}

/**
 * Withdraw each leaked handle's claim on the event loop (and kill leaked child processes, which
 * must not outlive the run). Never closes a connection — see the header for why destroy() would
 * make the Redis case worse rather than better.
 * @param {Array<{kind: string, handle: object}>} leaks
 */
function releaseLoop(leaks) {
  for (const { handle } of leaks) {
    try {
      if (typeof handle.pid === 'number' && typeof handle.kill === 'function') {
        handle.kill('SIGKILL'); // an orphaned worker would keep hammering the shared test database
      }
      if (typeof handle.unref === 'function') handle.unref();
    } catch {
      /* a handle that refuses to be unref'd is reported above; nothing more to do here */
    }
  }
}

module.exports = async function globalTeardown() {
  const lockClient = globalThis.__HOMEPLATE_SUITE_LOCK_CLIENT__;
  if (lockClient) {
    globalThis.__HOMEPLATE_SUITE_LOCK_CLIENT__ = undefined;
    await lockClient.end();
  }

  // One macrotask so the sockets closed just above (and by the last suite's afterAll) finish
  // their close handshake before the snapshot — otherwise they read as still-open leaks.
  await new Promise((resolve) => setTimeout(resolve, 50));

  const leaks = leakedHandles();
  // Timers are NOT handles — process._getActiveHandles() cannot see them — so an unstopped
  // setTimeout/setInterval shows up only here, and Node exposes no way to reach the Timeout object
  // and clear it. Verified on Node 24: this list carries ONLY ref'd, still-pending timers (an
  // unref'd one and a just-fired one both report nothing), so a line here is always a real leak.
  // A one-shot timer merely delays the exit by its own delay; a SELF-RE-ARMING one — a poll loop
  // such as src/outbox/worker.js startWorker()'s tick, whose stop() a test skipped — never lets the
  // run finish. Either way it can only be fixed in the suite that armed it.
  const timers =
    typeof process.getActiveResourcesInfo === 'function'
      ? process.getActiveResourcesInfo().filter((r) => r === 'Timeout' || r === 'Immediate')
      : [];

  if (leaks.length === 0 && timers.length === 0) return;

  const lines = leaks.map(({ kind, detail }) => `  - ${kind} ${detail}`);
  if (timers.length > 0) {
    lines.push(
      `  - ${timers.length} pending ref'd timer(s) (${[...new Set(timers)].join(', ')}) — NOT ` +
        'releasable from here (Node exposes no handle for a timer). The run waits out its delay, ' +
        'and waits FOREVER if it re-arms itself (a poll loop whose stop() was skipped, e.g. ' +
        "src/outbox/worker.js startWorker()). Clear it in the owning suite's afterAll."
    );
  }
  const message =
    `globalTeardown: ${leaks.length + timers.length} resource(s) were still holding the event ` +
    'loop after the run:\n' +
    lines.join('\n') +
    '\nJest runs every test file in its MAIN process (maxWorkers=1 => runInBand), so a connection ' +
    'a suite forgot to close — or closed only on the success path, so a failing test skipped it — ' +
    "is a ref'd handle in Jest's own event loop. Left alone this prints \"Jest did not exit one " +
    'second after the test run has completed" and hangs the run (and CI) indefinitely. The handles ' +
    "above have been unref'd (child processes killed) so this run exits, but that is a BACKSTOP: " +
    "close the connection in the owning suite's afterAll, inside a finally, and pair every " +
    'dbh.closeDb() with a closeTestRedis(). Do NOT add --forceExit — it hides this instead of ' +
    'naming it. Set TEST_STRICT_HANDLES=1 to fail the run on a leak rather than warn.';

  console.warn(message);
  releaseLoop(leaks);

  if (process.env.TEST_STRICT_HANDLES === '1') {
    throw new Error(message);
  }
};
