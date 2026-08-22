// U1-CONFIG — environment schema and FAIL-FAST validation (scaffolded by U0-BOOTSTRAP,
// reconciled by U1-CONFIG). Every required variable missing from the environment aborts
// start-up with an explicit list — nothing silently defaults to an insecure value.
//
// Requirement / decision traceability:
//   NFR-03, AB-05  — HTTPS/TLS enforcement flag fails closed in production
//   NFR-04, NFR-05 — login rate-limit knobs (5 attempts / 10 minutes)
//   NFR-09         — external-adapter timeout/retry knobs, outbox retry/backoff (ADR-003)
//   NFR-12         — erasure and inactivity retention windows; BACKUP_RETENTION_DAYS is the
//                    ST-05 backup-expiry policy scripts/backup.js enforces (U4-PRIVACY)
//   NFR-13, ST-06  — field-level AES-256-GCM key (32 bytes hex) for §3.4 PII columns; the
//                    placeholder key shipped in .env.example is REFUSED in production
//   AB-08          — the default MinIO object-storage credentials are refused in production
//                    (a media bucket reachable with published credentials is harvestable)
//   FR-08          — MODERATION_CONFIDENCE_THRESHOLD: below it, content routes to the human
//                    moderator queue (ADR-002 confidence-based routing)
//   FR-10          — EMAIL_TOKEN_TTL_HOURS: email-verification token expiry
//   FR-12          — per-guest concurrent pending-booking cap (build-plan open question 3)
//   FR-13          — outbox knobs carry booking notifications without delaying the booking
//   ADR-004        — object storage connection (per-object-delete media store)
//   ADR-005        — Maps adapter mode/key/cache TTL
//   ADR-007        — provider-agnostic moderation LLM variables; no hardcoded provider/model
//   ADR-010        — coordinate coarsening radius (public precision)
//   ADR-011        — notifications: SendGrid email channel, push gated DEFAULT FALSE
'use strict';

const { z } = require('zod');

const NODE_ENVS = ['development', 'test', 'production'];

// ---- committed placeholder credentials (NFR-13, ST-06, AB-08) --------------------------------
// These values ship IN THE REPOSITORY so that `cp .env.example .env`, `npm run build` and the
// docker-compose dev loop work with no setup. That convenience is exactly why production must
// refuse them: a key published in a git repository gives "encrypted at rest" no confidentiality
// against anyone who can read the repo, and a media bucket reachable with the documented MinIO
// defaults is open to harvesting (AB-08). Exported so tests can assert on the same constants
// instead of re-typing the literals.
const KNOWN_SAMPLE_FIELD_ENCRYPTION_KEY = 'deadbeef'.repeat(8);
const DEFAULT_OBJECT_STORAGE_CREDENTIALS = Object.freeze(['minioadmin']);

/**
 * True when a 64-hex key is really one short block repeated (deadbeef×8, 00×32, abab…) — a
 * placeholder rather than 32 bytes of entropy. Catches the committed sample key and every
 * near-miss variant of it; a `openssl rand -hex 32` key has no such period.
 */
function isPlaceholderHexKey(hex) {
  const n = hex.length;
  for (let block = 1; block <= n / 2; block += 1) {
    if (n % block !== 0) continue;
    if (hex.slice(0, block).repeat(n / block) === hex) return true;
  }
  return false;
}

// ---- primitive coercions ---------------------------------------------------------------------

const intWithDefault = (def, min = 1) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int().min(min));

// Bounded float knob (e.g. a confidence threshold in (0, 1]); NaN and out-of-range reject.
const floatWithin = (def, gt, lte) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().gt(gt).lte(lte));

const boolWithDefault = (def) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? String(def) : v))
    .pipe(z.enum(['true', 'false']))
    .transform((v) => v === 'true');

const optionalString = z
  .string()
  .optional()
  .transform((v) => (v === undefined || v === '' ? undefined : v));

// ---- raw shape (defaults applied here; cross-field requirements checked below) ---------------

const rawSchema = z.object({
  NODE_ENV: z.enum(NODE_ENVS).optional().default('development'),

  // ADR-007/ADR-005 escape hatch — the ONLY way to point a NODE_ENV=test process at a live
  // moderation/Maps provider ("only the IT-03 measurement run may call the live API").
  // Default false, so `npm test` and CI can never be flipped to a third party by a stray
  // exported variable. The IT-03 runner opts in explicitly and records the model id with the
  // result (ADR-007 follow-ups). It grants NOTHING in production, where live is already the
  // required mode, and it does not relax the ADR-011 mock-transport rule.
  ALLOW_LIVE_ADAPTERS_IN_TESTS: boolWithDefault(false),

  // server / transport (NFR-03, AB-05)
  PORT: intWithDefault(3000),
  TLS_CERT_PATH: z.string().optional().default('certs/dev-cert.pem'),
  TLS_KEY_PATH: z.string().optional().default('certs/dev-key.pem'),
  ENFORCE_HTTPS: boolWithDefault(true),
  // FR-10 — the externally reachable origin of THIS deployment. The worker builds the
  // single-use email-verification link from it, so a wrong value mails dead links: it is
  // required in production (and must be https there — NFR-03) and defaults to the local
  // dev origin otherwise. No secret, but no silent guess in production either.
  PUBLIC_BASE_URL: optionalString,

  // stores (SRS §2.4)
  DATABASE_URL: optionalString,
  REDIS_URL: optionalString,

  // field-level encryption at rest for §3.4 PII columns (NFR-13)
  FIELD_ENCRYPTION_KEY: optionalString,

  // auth (ADR-006; NFR-04/NFR-05: lock after 5 failed attempts in 10 minutes)
  AUTH_LOGIN_MAX_ATTEMPTS: intWithDefault(5),
  AUTH_LOGIN_WINDOW_SECONDS: intWithDefault(600),
  SESSION_TTL_SECONDS: intWithDefault(604800),
  SESSION_COOKIE_NAME: z.string().optional().default('hp.sid'),
  // FR-10 — email-verification token expiry; a token older than this returns 400.
  EMAIL_TOKEN_TTL_HOURS: intWithDefault(24),

  // booking (FR-12 — per-guest concurrent pending cap, configurable)
  BOOKING_MAX_CONCURRENT_PENDING: intWithDefault(3),

  // privacy / data lifecycle (NFR-12, NFR-13, ADR-010)
  PRIVACY_ERASURE_DAYS: intWithDefault(30),
  PRIVACY_INACTIVITY_MONTHS: intWithDefault(24),
  PRIVACY_COARSEN_RADIUS_METERS: intWithDefault(300),

  // NFR-12 (ST-05) — "database backups containing deleted data shall expire within 30 days".
  // The validated retention window scripts/backup.js enforces against the dump directory;
  // U4-PRIVACY made the policy executable (finding STS-W3-03 / F-03).
  BACKUP_RETENTION_DAYS: intWithDefault(30),

  // external adapter resilience (NFR-09, ADR-005)
  ADAPTER_TIMEOUT_MS: intWithDefault(3000),
  ADAPTER_RETRY_MAX: intWithDefault(2, 0),
  ADAPTER_BACKOFF_BASE_MS: intWithDefault(200),

  // outbox worker (ADR-001/ADR-003 — retry, backoff, dead-letter)
  OUTBOX_POLL_INTERVAL_MS: intWithDefault(1000),
  OUTBOX_BATCH_SIZE: intWithDefault(10),
  OUTBOX_MAX_ATTEMPTS: intWithDefault(8),
  OUTBOX_BACKOFF_BASE_MS: intWithDefault(5000),
  OUTBOX_BACKOFF_MAX_MS: intWithDefault(3600000),

  // notifications (ADR-011 — email via SendGrid is the v1.0 channel; push OFF by default)
  NOTIFICATIONS_TRANSPORT: z.enum(['mock', 'sendgrid']).optional(),
  NOTIFICATIONS_PUSH_ENABLED: boolWithDefault(false),
  SENDGRID_API_KEY: optionalString,
  SENDGRID_FROM_EMAIL: optionalString,
  FCM_SERVICE_ACCOUNT_JSON: optionalString,

  // maps / places (ADR-005; cached at public precision only per ADR-010)
  MAPS_MODE: z.enum(['mock', 'live']).optional(),
  MAPS_API_KEY: optionalString,
  MAPS_CACHE_TTL_SECONDS: intWithDefault(86400),

  // search result-page cache (FR-01, NFR-01, NFR-09 — U3-SEARCH caches whole result pages in
  // Redis via cache.wrap; this TTL is that cache's, distinct from the geocode cache above)
  SEARCH_CACHE_TTL_SECONDS: intWithDefault(60),

  // media upload surface (ADR-004; FR-02/FR-05 media supply — U3-HOSTS-MEDIA validates
  // {contentType ∈ allowlist, sizeBytes ≤ cap} and issues time-boxed upload targets)
  MEDIA_MAX_UPLOAD_BYTES: intWithDefault(5242880),
  MEDIA_UPLOAD_URL_TTL_SECONDS: intWithDefault(900),
  MEDIA_ALLOWED_CONTENT_TYPES: z.string().optional().default('image/jpeg,image/png,image/webp'),

  // moderation LLM (ADR-007 — provider-agnostic; provider/model/key come from env ONLY)
  LLM_MODERATION_MODE: z.enum(['mock', 'live']).optional(),
  LLM_MODERATION_BASE_URL: optionalString,
  LLM_MODERATION_API_KEY: optionalString,
  MODERATION_MODEL: optionalString,
  // FR-08 / ADR-002 — LLM classifications with confidence below this route to the human
  // moderator queue; public content stays pending until a human decides. Must be in (0, 1].
  MODERATION_CONFIDENCE_THRESHOLD: floatWithin(0.8, 0, 1),

  // object storage (ADR-004 — media referenced by key, per-object delete)
  OBJECT_STORAGE_ENDPOINT: optionalString,
  OBJECT_STORAGE_REGION: z.string().optional().default('us-east-1'),
  OBJECT_STORAGE_BUCKET: optionalString,
  OBJECT_STORAGE_ACCESS_KEY: optionalString,
  OBJECT_STORAGE_SECRET_KEY: optionalString,
  OBJECT_STORAGE_FORCE_PATH_STYLE: boolWithDefault(true),
});

// ---- validation ------------------------------------------------------------------------------

function deepFreeze(obj) {
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) deepFreeze(value);
  }
  return Object.freeze(obj);
}

/**
 * Validate a raw environment (e.g. process.env) and return the frozen config object.
 * Pure: reads nothing but its argument, so `.env.example` completeness and fail-fast
 * behaviour are directly testable (scripts/check-build.js, tests/unit/bootstrap.test.js).
 * Throws a single Error listing EVERY problem at once.
 */
function validateEnv(rawEnv) {
  const parsed = rawSchema.safeParse(rawEnv);
  const problems = [];

  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      problems.push(`${issue.path.join('.')}: ${issue.message}`);
    }
    throw configError(problems);
  }

  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';
  const isTest = e.NODE_ENV === 'test';

  // Required in every mode — the API cannot run without its stores (SRS §2.4).
  if (!e.DATABASE_URL) problems.push('DATABASE_URL is required (PostgreSQL connection string)');
  if (!e.REDIS_URL) problems.push('REDIS_URL is required (Redis connection string)');
  if (!e.FIELD_ENCRYPTION_KEY) {
    problems.push('FIELD_ENCRYPTION_KEY is required (NFR-13 field-level encryption)');
  } else if (!/^[0-9a-f]{64}$/i.test(e.FIELD_ENCRYPTION_KEY)) {
    problems.push(
      'FIELD_ENCRYPTION_KEY must be 64 hex characters (32 bytes for AES-256-GCM); generate with: openssl rand -hex 32'
    );
  }
  if (!e.OBJECT_STORAGE_ENDPOINT) problems.push('OBJECT_STORAGE_ENDPOINT is required (ADR-004)');
  if (!e.OBJECT_STORAGE_BUCKET) problems.push('OBJECT_STORAGE_BUCKET is required (ADR-004)');
  if (!e.OBJECT_STORAGE_ACCESS_KEY)
    problems.push('OBJECT_STORAGE_ACCESS_KEY is required (ADR-004)');
  if (!e.OBJECT_STORAGE_SECRET_KEY)
    problems.push('OBJECT_STORAGE_SECRET_KEY is required (ADR-004)');

  // Committed placeholder credentials fail CLOSED in production, exactly like ENFORCE_HTTPS
  // and the mock adapters below. An operator following the documented path (`cp .env.example
  // .env`, fill in the provider keys) must not end up encrypting the §3.4 PII columns under a
  // key that is published in this repository, nor exposing the media bucket on the default
  // MinIO credentials (NFR-13, ST-06, AB-08). Dev and test keep using the samples.
  if (isProduction && e.FIELD_ENCRYPTION_KEY && isPlaceholderHexKey(e.FIELD_ENCRYPTION_KEY)) {
    problems.push(
      'FIELD_ENCRYPTION_KEY is a placeholder (the sample key committed in .env.example, or ' +
        'another repeated-block value) and must not be used when NODE_ENV=production — NFR-13 ' +
        'encryption at rest is worthless under a published key; generate with: openssl rand -hex 32'
    );
  }
  if (isProduction) {
    for (const name of ['OBJECT_STORAGE_ACCESS_KEY', 'OBJECT_STORAGE_SECRET_KEY']) {
      if (DEFAULT_OBJECT_STORAGE_CREDENTIALS.includes(e[name])) {
        problems.push(
          `${name} is the default MinIO credential documented in .env.example/docker-compose.yml ` +
            'and must not be used when NODE_ENV=production (ADR-004, AB-08 — the media bucket ' +
            'would be readable by anyone who can read this repository)'
        );
      }
    }
  }

  // Transport enforcement fails CLOSED in production (NFR-03, AB-05, build-plan §2).
  if (isProduction && !e.ENFORCE_HTTPS) {
    problems.push('ENFORCE_HTTPS must not be disabled when NODE_ENV=production (NFR-03)');
  }

  // FR-10 — public origin used to build the emailed verification link. Outside production a
  // local default keeps dev/test frictionless; in production an explicit https origin is
  // mandatory, because a guessed origin would mail links nobody can follow (and FR-10 would
  // be unmeetable — email_verified could never become true).
  let publicBaseUrl = e.PUBLIC_BASE_URL;
  if (publicBaseUrl === undefined) {
    if (isProduction) {
      problems.push(
        'PUBLIC_BASE_URL is required when NODE_ENV=production (FR-10 — the emailed ' +
          'verification link must point at this deployment)'
      );
    } else {
      publicBaseUrl = `https://localhost:${e.PORT}`;
    }
  }
  if (publicBaseUrl !== undefined) {
    let parsedBase = null;
    try {
      parsedBase = new URL(publicBaseUrl);
    } catch {
      parsedBase = null;
    }
    if (!parsedBase || (parsedBase.protocol !== 'https:' && parsedBase.protocol !== 'http:')) {
      problems.push(
        'PUBLIC_BASE_URL must be an absolute http(s) origin, e.g. https://homeplate.example'
      );
    } else if (isProduction && parsedBase.protocol !== 'https:') {
      problems.push('PUBLIC_BASE_URL must use https when NODE_ENV=production (NFR-03)');
    } else {
      publicBaseUrl = publicBaseUrl.replace(/\/+$/, ''); // one canonical form, no trailing slash
    }
  }

  // Adapter modes: mocks are the dev/test default; production must run live (ADR-007/005/011).
  const notificationsTransport = e.NOTIFICATIONS_TRANSPORT ?? (isProduction ? 'sendgrid' : 'mock');
  const mapsMode = e.MAPS_MODE ?? (isProduction ? 'live' : 'mock');
  const moderationMode = e.LLM_MODERATION_MODE ?? (isProduction ? 'live' : 'mock');

  if (isProduction && notificationsTransport === 'mock') {
    problems.push('NOTIFICATIONS_TRANSPORT=mock is not allowed in production (ADR-011)');
  }
  if (isProduction && mapsMode === 'mock') {
    // ADR-005 / FR-01: production geocoding must come from the live Maps adapter — the
    // deterministic mock would silently fabricate coordinates and search results.
    problems.push('MAPS_MODE=mock is not allowed in production (ADR-005)');
  }
  if (isProduction && moderationMode === 'mock') {
    // ADR-007 / ADR-002 / FR-08, NFR-10: the deterministic mock classifier exists for CI only;
    // in production it could approve unreviewed content, violating never-publish-unreviewed.
    problems.push('LLM_MODERATION_MODE=mock is not allowed in production (ADR-007)');
  }
  if (isTest && notificationsTransport !== 'mock') {
    // The whole automated suite asserts on persisted NOTIFICATION_ATTEMPT rows, never on a
    // third party's behaviour (ADR-011). No measurement run needs a live transport, so this
    // guard has no escape hatch.
    problems.push('NOTIFICATIONS_TRANSPORT must be mock when NODE_ENV=test (ADR-011)');
  }
  // The same rule for the other two adapters, which previously relied on a soft default in
  // tests/helpers/env.js that any exported variable could override — e.g. a shell left over
  // from a wave-7 IT-03 run would have sent the entire suite (and CI) at the live providers.
  // ADR-007: "CI and the automated suite use a deterministic MOCK adapter; only the IT-03
  // measurement run may call the live API"; ADR-005 adds the free-tier quota reason.
  if (isTest && !e.ALLOW_LIVE_ADAPTERS_IN_TESTS) {
    if (moderationMode !== 'mock') {
      problems.push(
        'LLM_MODERATION_MODE must be mock when NODE_ENV=test (ADR-007) — set ' +
          'ALLOW_LIVE_ADAPTERS_IN_TESTS=true for the IT-03 measurement run only'
      );
    }
    if (mapsMode !== 'mock') {
      problems.push(
        'MAPS_MODE must be mock when NODE_ENV=test (ADR-005) — set ' +
          'ALLOW_LIVE_ADAPTERS_IN_TESTS=true for the IT-03 measurement run only'
      );
    }
  }
  if (notificationsTransport === 'sendgrid') {
    if (!e.SENDGRID_API_KEY)
      problems.push('SENDGRID_API_KEY is required when NOTIFICATIONS_TRANSPORT=sendgrid');
    if (!e.SENDGRID_FROM_EMAIL)
      problems.push('SENDGRID_FROM_EMAIL is required when NOTIFICATIONS_TRANSPORT=sendgrid');
  }
  if (e.NOTIFICATIONS_PUSH_ENABLED && isProduction && !e.FCM_SERVICE_ACCOUNT_JSON) {
    problems.push(
      'FCM_SERVICE_ACCOUNT_JSON is required when push is enabled in production (ADR-011)'
    );
  }
  if (mapsMode === 'live' && !e.MAPS_API_KEY) {
    problems.push('MAPS_API_KEY is required when MAPS_MODE=live (ADR-005)');
  }
  // Media content-type allowlist (ADR-004): comma-separated MIME types, each type/subtype.
  const allowedContentTypes = e.MEDIA_ALLOWED_CONTENT_TYPES.split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (allowedContentTypes.length === 0) {
    problems.push('MEDIA_ALLOWED_CONTENT_TYPES must list at least one MIME type (ADR-004)');
  }
  for (const mime of allowedContentTypes) {
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(mime)) {
      problems.push(
        `MEDIA_ALLOWED_CONTENT_TYPES entry "${mime}" is not a valid type/subtype MIME type`
      );
    }
  }

  if (moderationMode === 'live') {
    // ADR-007: never hardcode a provider, a model id or a key — live mode demands all three.
    if (!e.LLM_MODERATION_BASE_URL)
      problems.push('LLM_MODERATION_BASE_URL is required when LLM_MODERATION_MODE=live (ADR-007)');
    if (!e.LLM_MODERATION_API_KEY)
      problems.push('LLM_MODERATION_API_KEY is required when LLM_MODERATION_MODE=live (ADR-007)');
    if (!e.MODERATION_MODEL)
      problems.push('MODERATION_MODEL is required when LLM_MODERATION_MODE=live (ADR-007)');
  }

  if (problems.length > 0) throw configError(problems);

  return deepFreeze({
    env: e.NODE_ENV,
    isProduction,
    isTest,
    server: {
      port: e.PORT,
      enforceHttps: e.ENFORCE_HTTPS,
      // FR-10 — origin the worker prefixes onto the verification link (no trailing slash).
      publicBaseUrl,
      tls: { certPath: e.TLS_CERT_PATH, keyPath: e.TLS_KEY_PATH },
    },
    db: { url: e.DATABASE_URL },
    redis: { url: e.REDIS_URL },
    crypto: { fieldEncryptionKeyHex: e.FIELD_ENCRYPTION_KEY },
    auth: {
      loginMaxAttempts: e.AUTH_LOGIN_MAX_ATTEMPTS,
      loginWindowSeconds: e.AUTH_LOGIN_WINDOW_SECONDS,
      sessionTtlSeconds: e.SESSION_TTL_SECONDS,
      sessionCookieName: e.SESSION_COOKIE_NAME,
      emailTokenTtlHours: e.EMAIL_TOKEN_TTL_HOURS,
    },
    booking: { maxConcurrentPending: e.BOOKING_MAX_CONCURRENT_PENDING },
    privacy: {
      erasureDays: e.PRIVACY_ERASURE_DAYS,
      inactivityMonths: e.PRIVACY_INACTIVITY_MONTHS,
      coarsenRadiusMeters: e.PRIVACY_COARSEN_RADIUS_METERS,
    },
    backup: {
      // NFR-12 backup-expiry policy (ST-05): scripts/backup.js prunes dumps older than this.
      retentionDays: e.BACKUP_RETENTION_DAYS,
    },
    adapters: {
      timeoutMs: e.ADAPTER_TIMEOUT_MS,
      retryMax: e.ADAPTER_RETRY_MAX,
      backoffBaseMs: e.ADAPTER_BACKOFF_BASE_MS,
    },
    outbox: {
      pollIntervalMs: e.OUTBOX_POLL_INTERVAL_MS,
      batchSize: e.OUTBOX_BATCH_SIZE,
      maxAttempts: e.OUTBOX_MAX_ATTEMPTS,
      backoffBaseMs: e.OUTBOX_BACKOFF_BASE_MS,
      backoffMaxMs: e.OUTBOX_BACKOFF_MAX_MS,
    },
    notifications: {
      transport: notificationsTransport,
      push: { enabled: e.NOTIFICATIONS_PUSH_ENABLED },
      email: { from: e.SENDGRID_FROM_EMAIL ?? 'no-reply@homeplate.local' },
      sendgridApiKey: e.SENDGRID_API_KEY,
      fcmServiceAccountJson: e.FCM_SERVICE_ACCOUNT_JSON,
    },
    maps: {
      mode: mapsMode,
      apiKey: e.MAPS_API_KEY,
      cacheTtlSeconds: e.MAPS_CACHE_TTL_SECONDS,
    },
    search: {
      // FR-01 / NFR-01 / NFR-09 — U3-SEARCH result-page cache TTL (cache.wrap key TTL).
      cacheTtlSeconds: e.SEARCH_CACHE_TTL_SECONDS,
    },
    media: {
      // ADR-004 / FR-02 / FR-05 — U3-HOSTS-MEDIA upload validation caps and target expiry.
      maxUploadBytes: e.MEDIA_MAX_UPLOAD_BYTES,
      uploadUrlTtlSeconds: e.MEDIA_UPLOAD_URL_TTL_SECONDS,
      allowedContentTypes,
    },
    moderation: {
      mode: moderationMode,
      baseUrl: e.LLM_MODERATION_BASE_URL,
      apiKey: e.LLM_MODERATION_API_KEY,
      model: e.MODERATION_MODEL,
      confidenceThreshold: e.MODERATION_CONFIDENCE_THRESHOLD,
    },
    objectStorage: {
      endpoint: e.OBJECT_STORAGE_ENDPOINT,
      region: e.OBJECT_STORAGE_REGION,
      bucket: e.OBJECT_STORAGE_BUCKET,
      accessKey: e.OBJECT_STORAGE_ACCESS_KEY,
      secretKey: e.OBJECT_STORAGE_SECRET_KEY,
      forcePathStyle: e.OBJECT_STORAGE_FORCE_PATH_STYLE,
    },
  });
}

function configError(problems) {
  return new Error(
    `Invalid configuration — refusing to start (fail-fast, build-plan U1-CONFIG):\n` +
      problems.map((p) => `  - ${p}`).join('\n') +
      `\nSee .env.example for the full variable list.`
  );
}

// Every environment variable the schema understands — the authoritative list used by
// tests/unit/config.test.js to prove .env.example documents each one (build-plan §5.11).
const envKeys = Object.freeze(Object.keys(rawSchema.shape));

module.exports = {
  validateEnv,
  deepFreeze,
  envKeys,
  // NFR-13 / ST-06 / AB-08 — the committed placeholders production refuses, exported so tests
  // and tooling assert against one definition instead of re-typing the literals.
  KNOWN_SAMPLE_FIELD_ENCRYPTION_KEY,
  DEFAULT_OBJECT_STORAGE_CREDENTIALS,
  isPlaceholderHexKey,
};
