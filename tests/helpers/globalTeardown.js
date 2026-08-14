// tests/helpers/globalTeardown.js — deliberate design decision, not an omission:
// the seeded test database and test Redis DB are LEFT IN PLACE after a run so failures can be
// inspected post-mortem. Reproducibility is provided at the START of every run by
// globalSetup (schema reset + migrate + seed + Redis flush), which is what the SRS §4.1
// "reproducible seed/teardown" protocol requires. Docker containers keep running; stop them
// with `docker compose down` when done.
//
// The one thing that MUST be released here is the suite advisory lock taken by globalSetup
// (verification-report F-1): ending the session frees the lock so a waiting run can start.
'use strict';

module.exports = async function globalTeardown() {
  const lockClient = globalThis.__HOMEPLATE_SUITE_LOCK_CLIENT__;
  if (lockClient) {
    globalThis.__HOMEPLATE_SUITE_LOCK_CLIENT__ = undefined;
    await lockClient.end();
  }
};
