// src/modules/auth/passwords.js — U2-IDENTITY: the ONE password hashing/verification module.
//
// Requirement / decision traceability (SRS Appendix B):
//   NFR-04 (ST-02) — passwords are stored ONLY as Argon2id hashes ($argon2id$…) with
//                    memoryCost >= 19456 KiB and timeCost >= 2 (OWASP password-storage
//                    minimums), per-hash random salt (two registrations with the same
//                    password produce different hashes). No plaintext is ever stored,
//                    logged, or returned anywhere.
//   AB-05           — a stolen users-table dump yields no plaintext; verification is the
//                    only way to test a candidate password.
//   ADR-006         — one auth service owns credentials; every hash/verify in the codebase
//                    goes through this module.
//
// Primary implementation: Argon2id via @node-rs/argon2 (prebuilt native binaries).
// Documented fallback (build-plan §1 stack table): if the native binding cannot load on the
// build host, bcryptjs cost 12 is used ($2a$12$…) and the active algorithm is exported so
// the ST-02 run records the deviation. verify() accepts BOTH formats regardless of the
// active algorithm, so a fallback-era hash still verifies after the binding is restored.
'use strict';

// Argon2id parameters — OWASP minimum-recommendation configuration (ST-02 asserts these
// numbers by parsing the produced hash): m=19456 KiB (19 MiB), t=2 iterations, p=1 lane.
const ARGON2_PARAMS = Object.freeze({
  memoryCost: 19456, // KiB
  timeCost: 2,
  parallelism: 1,
});

// bcryptjs fallback cost (ST-02 documented deviation path — NFR-04 allows bcrypt >= 12).
const BCRYPT_COST = 12;

// Resolve the hashing backend once at load. @node-rs/argon2 ships prebuilt binaries for
// every mainstream platform; the require only fails on hosts with no prebuilt binding,
// which is exactly the case the documented bcryptjs fallback exists for.
let argon2 = null;
try {
  // eslint-disable-next-line global-require
  argon2 = require('@node-rs/argon2');
} catch (_nativeBindingUnavailable) {
  argon2 = null;
}

// eslint-disable-next-line global-require
const bcrypt = require('bcryptjs');

/** 'argon2id' when the native binding loaded; 'bcrypt' on the documented fallback path.
 *  The ST-02 record captures this value alongside the parameters. */
const activeAlgorithm = argon2 ? 'argon2id' : 'bcrypt';

/** The parameters the active algorithm hashes with (for the ST-02 record). */
const activeParams = Object.freeze(
  argon2 ? { ...ARGON2_PARAMS } : { cost: BCRYPT_COST, note: 'bcryptjs fallback — ST-02 deviation' }
);

/**
 * Hash a plaintext password for storage in users.password_hash (NFR-04).
 * A fresh random salt is generated per call by the underlying library, so identical
 * passwords never share a hash.
 * @param {string} plaintext
 * @returns {Promise<string>} '$argon2id$…' (primary) or '$2a$12$…' (documented fallback)
 */
async function hashPassword(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new TypeError('hashPassword: plaintext must be a non-empty string');
  }
  if (argon2) {
    return argon2.hash(plaintext, {
      ...ARGON2_PARAMS,
      algorithm: argon2.Algorithm.Argon2id,
    });
  }
  return bcrypt.hash(plaintext, BCRYPT_COST);
}

/**
 * Verify a candidate password against a stored hash. Accepts both hash formats
 * independently of the active algorithm (a bcrypt-era hash keeps working after the
 * Argon2 binding is restored, and vice versa). NEVER throws on a wrong password —
 * only on a malformed stored hash, which is a data-integrity bug worth surfacing.
 * @param {string} storedHash  value of users.password_hash
 * @param {string} plaintext   candidate password
 * @returns {Promise<boolean>}
 */
async function verifyPassword(storedHash, plaintext) {
  if (typeof storedHash !== 'string' || storedHash.length === 0) {
    throw new TypeError('verifyPassword: storedHash must be a non-empty string');
  }
  if (typeof plaintext !== 'string') return false;

  if (storedHash.startsWith('$argon2')) {
    if (!argon2) {
      // Argon2 hash on disk but no binding on this host: fail closed (cannot verify).
      throw new Error(
        'verifyPassword: stored hash is Argon2 but @node-rs/argon2 is unavailable on this host'
      );
    }
    return argon2.verify(storedHash, plaintext);
  }
  if (/^\$2[aby]\$/.test(storedHash)) {
    return bcrypt.compare(plaintext, storedHash);
  }
  throw new Error('verifyPassword: unrecognized password hash format in users.password_hash');
}

// A real hash of a random value, computed lazily once: login verifies against THIS when the
// account does not exist, so "no such user" costs the same as "wrong password" and response
// timing does not enumerate accounts (AB-05 hardening).
let dummyHashPromise = null;
function getDummyHash() {
  if (!dummyHashPromise) {
    // eslint-disable-next-line global-require
    const { randomBytes } = require('crypto');
    dummyHashPromise = hashPassword(randomBytes(24).toString('base64url'));
  }
  return dummyHashPromise;
}

/**
 * Burn one password verification against a throwaway hash (timing equalization for
 * nonexistent accounts — AB-05). Always resolves false.
 * @param {string} plaintext
 * @returns {Promise<false>}
 */
async function verifyAgainstDummy(plaintext) {
  const dummy = await getDummyHash();
  await verifyPassword(dummy, typeof plaintext === 'string' ? plaintext : '');
  return false;
}

module.exports = {
  hashPassword,
  verifyPassword,
  verifyAgainstDummy,
  activeAlgorithm,
  activeParams,
  ARGON2_PARAMS,
  BCRYPT_COST,
};
