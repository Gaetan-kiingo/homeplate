// src/db/fieldCrypto.js — U1-DB: field-level AES-256-GCM encryption at rest.
//
// Requirement traceability (SRS Appendix B):
//   NFR-13 — "Personal data shall be encrypted … at rest (AES-256 or equivalent)". Free-tier
//   PostgreSQL has no TDE (build-plan open question 7), so the §3.4 PII columns that carry a
//   phone number or the third-party emergency contact (users.phone_enc,
//   users.emergency_contact_{name,phone,email}_enc) store the output of encrypt(), never
//   plaintext. The 32-byte key comes from FIELD_ENCRYPTION_KEY via src/config — never from code.
//
// Format (versioned for future key rotation):
//   'enc:v1:' + base64( IV[12] ‖ GCM tag[16] ‖ ciphertext )
// A fresh random IV per call means encrypting the same value twice yields different ciphertexts
// (no equality-searchable ciphertext), and GCM authentication makes any tampering detectable.
//
// Public interface (build-plan wave-1 contract): { encrypt, decrypt } (+ isEncrypted helper).
// null/undefined pass through as null so nullable PII columns need no special-casing.
'use strict';

const crypto = require('crypto');
const config = require('../config');

const ALGORITHM = 'aes-256-gcm';
const PREFIX = 'enc:v1:';
const IV_LENGTH = 12; // NIST-recommended GCM nonce size
const TAG_LENGTH = 16;

// 64 hex chars = 32 bytes, validated by the config schema at load (fail-fast, U1-CONFIG).
const KEY = Buffer.from(config.crypto.fieldEncryptionKeyHex, 'hex');

/**
 * Encrypt a plaintext string for storage in an *_enc column.
 * @param {string|null|undefined} plaintext
 * @returns {string|null} versioned ciphertext ('enc:v1:…'), or null for null/undefined input
 */
function encrypt(plaintext) {
  if (plaintext === null || plaintext === undefined) return null;
  if (typeof plaintext !== 'string') {
    throw new TypeError('fieldCrypto.encrypt: plaintext must be a string (or null)');
  }
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, KEY, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/**
 * Decrypt a value produced by encrypt(). Throws on tampered, truncated or foreign input —
 * silent corruption of PII is never acceptable (NFR-13).
 * @param {string|null|undefined} value
 * @returns {string|null} the plaintext, or null for null/undefined input
 */
function decrypt(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string' || !value.startsWith(PREFIX)) {
    throw new TypeError(
      'fieldCrypto.decrypt: not a fieldCrypto ciphertext (missing enc:v1: prefix)'
    );
  }
  const raw = Buffer.from(value.slice(PREFIX.length), 'base64');
  if (raw.length < IV_LENGTH + TAG_LENGTH) {
    throw new RangeError('fieldCrypto.decrypt: ciphertext too short — truncated or corrupted');
  }
  const iv = raw.subarray(0, IV_LENGTH);
  const tag = raw.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = raw.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, KEY, iv);
  decipher.setAuthTag(tag);
  // GCM auth failure throws here — tampering is detected, never returned as garbage plaintext.
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

/**
 * Whether a stored value is fieldCrypto ciphertext (ST-06 uses this to prove a column holds
 * ciphertext rather than plaintext).
 * @param {*} value
 * @returns {boolean}
 */
function isEncrypted(value) {
  return typeof value === 'string' && value.startsWith(PREFIX);
}

module.exports = { encrypt, decrypt, isEncrypted };
