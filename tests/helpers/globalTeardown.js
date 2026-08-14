// tests/helpers/globalTeardown.js — deliberate design decision, not an omission:
// the seeded test database and test Redis DB are LEFT IN PLACE after a run so failures can be
// inspected post-mortem. Reproducibility is provided at the START of every run by
// globalSetup (schema reset + migrate + seed + Redis flush), which is what the SRS §4.1
// "reproducible seed/teardown" protocol requires. Docker containers keep running; stop them
// with `docker compose down` when done.
'use strict';

module.exports = async function globalTeardown() {
  // Intentionally empty — see header.
};
