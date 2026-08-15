// src/lib/mediaUrls.js — U3-LISTINGS: media URL derivation and upload-target minting by PURE
// LOCAL COMPUTATION (build-plan wave 3A; ADR-004-adjacent, request-path-safe).
//
// Requirement / decision traceability (SRS Appendix B):
//   FR-02 / FR-03 / FR-05 — listing, host-profile and review images are stored in object
//            storage referenced BY KEY (media_objects.storage_key, ADR-004); this module turns
//            those keys into browser-fetchable GET URLs for serializers, and mints time-boxed
//            direct-upload targets so image bytes NEVER transit the API (build-plan §6.3).
//   NFR-11 — every input is validated against strict allowlists (UUID, storage-key pattern,
//            media-kind enum, configured MIME allowlist) before any URL is derived.
//   NFR-13 / AB-08 — upload keys are server-generated and namespaced <kind>/<userId>/<uuid>.<ext>
//            so a caller can only ever upload under their own prefix; nothing here exposes any
//            personal data — keys carry entity kind + user id only.
//   ADR-001/003 — REQUEST-PATH SAFE ON PURPOSE: this module performs NO network I/O and imports
//            NOTHING from src/adapters/*. An S3 presigned URL is pure SigV4 HMAC arithmetic over
//            config.objectStorage (endpoint, region, bucket, credentials from the environment),
//            so deriving one can never block on, or fail with, the storage provider. Worker-side
//            get/put/delete stay behind src/adapters/objectStorage.js (ADR-004).
//
// Public interface (build-plan wave-3A contract):
//   urlForKey(key[, { expiresSeconds }])       → presigned GET URL string
//   createUploadTarget(userId, kind, contentType[, { sizeBytes }])
//       → { storageKey, uploadUrl, headers, expiresAt }
//   assertValidKey(key)                         → key, or a 422 INVALID_STORAGE_KEY AppError
//   MEDIA_KINDS, KEY_PATTERN                    (mirrors of the 0001 schema / adapter rule)
'use strict';

const crypto = require('crypto');
const config = require('../config');
const { AppError, ValidationError } = require('./errors');

// Mirror of the canonical storage-key rule in src/adapters/objectStorage.js (KEY_PATTERN).
// Deliberately a copy, not an import: importing the adapter would put an S3 client on the
// request path (ADR-001/003). tests/unit/listings.test.js pins the two patterns identical.
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9/_\-.]{0,511}$/;

// media_objects.entity_type enum (db/migrations/0001_core_schema.sql, ADR-004).
const MEDIA_KINDS = Object.freeze(['listing', 'review', 'host_profile']);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Extension by MIME type for the server-generated key; anything outside the configured
// allowlist is rejected before this map is consulted.
const EXTENSIONS = Object.freeze({
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
});

/**
 * The storage-key rule, enforceable WITHOUT touching src/adapters (ADR-001/003). Identical in
 * pattern and in thrown error to src/adapters/objectStorage.assertValidKey — the adapter keeps
 * its own copy for its worker-side calls, and tests/unit/listings.test.js pins the two patterns
 * character-for-character so they cannot drift. Request-reachable code (src/schemas/media.js,
 * src/modules/media/service.attach) validates through THIS one, so a request never loads the
 * adapter module (and never constructs its S3 client) just to check a string.
 *
 * @param {string} key  candidate media_objects.storage_key
 * @returns {string} the same key
 * @throws {AppError} 422 INVALID_STORAGE_KEY
 */
function assertValidKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key) || key.includes('..')) {
    throw new AppError('Invalid object-storage key', {
      status: 422,
      code: 'INVALID_STORAGE_KEY',
      retryable: false,
    });
  }
  return key;
}

// ---- SigV4 presigning (pure crypto — no SDK, no network) -------------------------------------

/** AWS-style URI encoding (RFC 3986: unreserved characters only stay literal). */
function uriEncode(value) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

/** Encode an object key for the canonical URI: each path segment encoded, '/' preserved. */
function encodeKeyPath(key) {
  return key.split('/').map(uriEncode).join('/');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data, 'utf8').digest();
}

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data, 'utf8').digest('hex');
}

/** 20260101T000000Z-style timestamp + its date stamp, from a Date. */
function amzTimestamps(now) {
  const amzDate = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

/**
 * Build a SigV4 PRESIGNED URL (query-string authentication) for one object — the standard
 * S3-compatible presign algorithm, computed locally from config.objectStorage. Works against
 * MinIO (dev/test) and any S3-compatible deployment store identically.
 *
 * @param {string} method          'GET' | 'PUT'
 * @param {string} key             validated storage key
 * @param {number} expiresSeconds  URL lifetime
 * @param {Date}   [now]           injection point for deterministic tests
 * @returns {{url: string, expiresAt: string}}
 */
function presign(method, key, expiresSeconds, now = new Date()) {
  const store = config.objectStorage;
  const endpoint = new URL(store.endpoint);
  const host = store.forcePathStyle ? endpoint.host : `${store.bucket}.${endpoint.host}`;
  const basePath = endpoint.pathname === '/' ? '' : endpoint.pathname.replace(/\/$/, '');
  const canonicalUri = store.forcePathStyle
    ? `${basePath}/${uriEncode(store.bucket)}/${encodeKeyPath(key)}`
    : `${basePath}/${encodeKeyPath(key)}`;

  const { amzDate, dateStamp } = amzTimestamps(now);
  const scope = `${dateStamp}/${store.region}/s3/aws4_request`;

  // Canonical query string: names sorted, everything URI-encoded (AWS SigV4 spec).
  const params = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${store.accessKey}/${scope}`],
    ['X-Amz-Date', amzDate],
    ['X-Amz-Expires', String(expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ]
    .map(([name, value]) => `${uriEncode(name)}=${uriEncode(value)}`)
    .sort()
    .join('&');

  const canonicalRequest = [
    method,
    canonicalUri,
    params,
    `host:${host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256Hex(canonicalRequest)].join('\n');

  const signingKey = hmac(
    hmac(hmac(hmac(`AWS4${store.secretKey}`, dateStamp), store.region), 's3'),
    'aws4_request'
  );
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  const url =
    `${endpoint.protocol}//${host}${canonicalUri}?${params}` + `&X-Amz-Signature=${signature}`;
  const expiresAt = new Date(now.getTime() + expiresSeconds * 1000).toISOString();
  return { url, expiresAt };
}

// ---- public surface --------------------------------------------------------------------------

/**
 * Browser-fetchable GET URL for a stored object key (FR-02/03/05 image URLs). Pure local
 * computation — safe on every request path; the URL expires so harvested payloads go stale
 * (AB-08 defence in depth).
 *
 * @param {string} key  media_objects.storage_key
 * @param {object} [options]
 * @param {number} [options.expiresSeconds]  default config.media.uploadUrlTtlSeconds
 * @returns {string} presigned GET URL
 */
function urlForKey(key, { expiresSeconds } = {}) {
  assertValidKey(key);
  const ttl = expiresSeconds === undefined ? config.media.uploadUrlTtlSeconds : expiresSeconds;
  if (!Number.isInteger(ttl) || ttl <= 0) {
    throw new ValidationError('expiresSeconds must be a positive integer');
  }
  return presign('GET', key, ttl).url;
}

/**
 * Mint a direct-to-storage upload target (build-plan §6.3): the API returns a presigned PUT
 * URL and the client uploads bytes STRAIGHT to object storage — the server never proxies
 * media bytes and never calls a storage adapter on the request path (ADR-001/003, ADR-004).
 *
 * The key is server-generated and namespaced `<kind>/<userId>/<uuid>.<ext>`, so a user can
 * only ever upload under their own prefix and cross-user attachment is impossible (AB-08).
 *
 * @param {string} userId       authenticated uploader (users.id)
 * @param {string} kind         one of MEDIA_KINDS ('listing' | 'review' | 'host_profile')
 * @param {string} contentType  must be in config.media.allowedContentTypes
 * @param {object} [options]
 * @param {number} [options.sizeBytes]  declared size; must be ≤ config.media.maxUploadBytes
 * @returns {{storageKey: string, uploadUrl: string, headers: object, expiresAt: string}}
 */
function createUploadTarget(userId, kind, contentType, { sizeBytes } = {}) {
  if (typeof userId !== 'string' || !UUID_RE.test(userId)) {
    throw new ValidationError('userId must be a UUID', { details: { field: 'userId' } });
  }
  if (!MEDIA_KINDS.includes(kind)) {
    throw new ValidationError(`kind must be one of: ${MEDIA_KINDS.join(', ')}`, {
      details: { field: 'kind' },
    });
  }
  const mime = typeof contentType === 'string' ? contentType.trim().toLowerCase() : '';
  if (!config.media.allowedContentTypes.includes(mime)) {
    throw new ValidationError(
      `contentType must be one of: ${config.media.allowedContentTypes.join(', ')}`,
      { code: 'UNSUPPORTED_MEDIA_TYPE', details: { field: 'contentType' } }
    );
  }
  if (sizeBytes !== undefined && sizeBytes !== null) {
    if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
      throw new ValidationError('sizeBytes must be a positive integer', {
        details: { field: 'sizeBytes' },
      });
    }
    if (sizeBytes > config.media.maxUploadBytes) {
      throw new ValidationError('sizeBytes exceeds the configured upload limit', {
        code: 'MEDIA_TOO_LARGE',
        details: { field: 'sizeBytes', maxUploadBytes: config.media.maxUploadBytes },
      });
    }
  }

  const subtype = mime.split('/')[1] || '';
  const ext = EXTENSIONS[mime] || subtype.replace(/[^a-z0-9]/g, '').slice(0, 10) || 'bin';
  const storageKey = `${kind}/${userId.toLowerCase()}/${crypto.randomUUID()}.${ext}`;
  assertValidKey(storageKey);

  const { url, expiresAt } = presign('PUT', storageKey, config.media.uploadUrlTtlSeconds);
  return {
    storageKey,
    uploadUrl: url,
    // The client sends these on its PUT; Content-Type rides unsigned (SignedHeaders=host)
    // so the same target works across S3-compatible stores.
    headers: { 'Content-Type': mime },
    expiresAt,
  };
}

module.exports = { urlForKey, createUploadTarget, assertValidKey, MEDIA_KINDS, KEY_PATTERN };
