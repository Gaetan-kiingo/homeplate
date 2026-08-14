// U1-CONFIG — environment schema and FAIL-FAST validation (scaffolded by U0-BOOTSTRAP,
// reconciled by U1-CONFIG). Every required variable missing from the environment aborts
// start-up with an explicit list — nothing silently defaults to an insecure value.
//
// Requirement / decision traceability:
//   NFR-03, AB-05  — HTTPS/TLS enforcement flag fails closed in production
//   NFR-04, NFR-05 — login rate-limit knobs (5 attempts / 10 minutes)
//   NFR-09         — external-adapter timeout/retry knobs, outbox retry/backoff (ADR-003)
//   NFR-12         — erasure and inactivity retention windows
//   NFR-13         — field-level AES-256-GCM key (32 bytes hex) for §3.4 PII columns
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

  // server / transport (NFR-03, AB-05)
  PORT: intWithDefault(3000),
  TLS_CERT_PATH: z.string().optional().default('certs/dev-cert.pem'),
  TLS_KEY_PATH: z.string().optional().default('certs/dev-key.pem'),
  ENFORCE_HTTPS: boolWithDefault(true),

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

  // Transport enforcement fails CLOSED in production (NFR-03, AB-05, build-plan §2).
  if (isProduction && !e.ENFORCE_HTTPS) {
    problems.push('ENFORCE_HTTPS must not be disabled when NODE_ENV=production (NFR-03)');
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
    // third party's behaviour (ADR-011).
    problems.push('NOTIFICATIONS_TRANSPORT must be mock when NODE_ENV=test (ADR-011)');
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

module.exports = { validateEnv, deepFreeze, envKeys };
