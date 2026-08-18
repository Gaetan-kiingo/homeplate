// tests/unit/bootstrap.test.js — proves the U0-BOOTSTRAP foundation before ten parallel
// implementers inherit it (build-plan wave 0): toolchain, seeded test DB, Redis, MinIO,
// fail-fast config, and the ADR-009 caps living in config rather than inline.
// Traceability: NFR-02, NFR-08, NFR-11 (toolchain substrate — the infra, test harness and
// build gate these lanes run on; the requirements' own acceptance tests land in waves 1+).
'use strict';

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const Redis = require('ioredis');
const dotenv = require('dotenv');
const { S3Client, HeadBucketCommand } = require('@aws-sdk/client-s3');

const { listMigrations } = require('../../scripts/migrate');
const { validateEnv } = require('../../src/config/schema');

const ROOT = path.join(__dirname, '..', '..');

describe('U0-BOOTSTRAP toolchain', () => {
  test('runs on Node 20+ (SPMP §5.1.3)', () => {
    expect(Number(process.versions.node.split('.')[0])).toBeGreaterThanOrEqual(20);
  });

  test('Jest does not pass vacuously: passWithNoTests is not enabled (build-plan wave 0)', () => {
    const jestConfig = require('../../jest.config.js');
    expect(jestConfig.passWithNoTests).toBeUndefined();
  });

  test('every verification lane directory exists (build-plan §1, SRS §4)', () => {
    const lanes = [
      'tc-core',
      'tc-booking',
      'it-adapters',
      'st-security',
      'rt-lt-resilience',
      'mt-ut-quality',
      'adr-conformance',
      'coverage',
    ];
    for (const lane of lanes) {
      const dir = path.join(ROOT, 'tests', lane);
      expect(fs.existsSync(dir) && fs.statSync(dir).isDirectory()).toBe(true);
    }
  });
});

describe('U0-BOOTSTRAP seeded test database (SRS §4.1)', () => {
  test('DATABASE_URL is guarded onto a *_test database', () => {
    const dbName = new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '');
    expect(dbName.endsWith('_test')).toBe(true);
  });

  test('schema_migrations matches db/migrations on disk', async () => {
    const client = new Client({
      connectionString: process.env.DATABASE_URL,
      connectionTimeoutMillis: 4000,
    });
    await client.connect();
    try {
      const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
      const appliedVersions = rows.map((r) => r.version);
      const onDiskVersions = listMigrations().map((m) => m.version);
      expect(appliedVersions).toEqual(onDiskVersions);
    } finally {
      await client.end();
    }
  });
});

describe('U0-BOOTSTRAP Redis (sessions/cache only — SRS §2.4)', () => {
  test('test Redis is reachable on an isolated DB index and round-trips a value', async () => {
    // Isolation is what matters, not the literal default index: any non-zero DB index keeps
    // the suite's flushdb off dev sessions (DB 0), including under a TEST_REDIS_URL override
    // (verification-report F-2).
    const redisDbIndex = Number(new URL(process.env.REDIS_URL).pathname.replace(/^\//, '') || '0');
    expect(Number.isInteger(redisDbIndex)).toBe(true);
    expect(redisDbIndex).toBeGreaterThan(0);
    const redis = new Redis(process.env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 4000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    await redis.connect();
    // The probe key lives in the approved hp:cache: namespace so the adr-conformance
    // Redis-namespace scan (keys must match /^hp:(session|ratelimit|cache):/) can never
    // flag it even if a parallel suite scans mid-test, and it is deleted before
    // disconnect so no residue outlives this test on the shared test Redis DB.
    const probeKey = 'hp:cache:bootstrap-probe';
    try {
      expect(await redis.ping()).toBe('PONG');
      await redis.set(probeKey, 'ok', 'EX', 30);
      expect(await redis.get(probeKey)).toBe('ok');
    } finally {
      await redis.del(probeKey).catch(() => {});
      redis.disconnect();
    }
  });
});

describe('U0-BOOTSTRAP object storage (ADR-004)', () => {
  test('MinIO test bucket exists and answers HeadBucket', async () => {
    const s3 = new S3Client({
      endpoint: process.env.OBJECT_STORAGE_ENDPOINT,
      region: process.env.OBJECT_STORAGE_REGION || 'us-east-1',
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY,
        secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY,
      },
    });
    try {
      const res = await s3.send(
        new HeadBucketCommand({ Bucket: process.env.OBJECT_STORAGE_BUCKET })
      );
      expect(res.$metadata.httpStatusCode).toBe(200);
    } finally {
      s3.destroy();
    }
  });
});

describe('U1-CONFIG fail-fast loader (scaffold contract)', () => {
  const exampleEnv = dotenv.parse(fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8'));

  test('.env.example enumerates every required variable (satisfies the schema)', () => {
    expect(() => validateEnv(exampleEnv)).not.toThrow();
  });

  test('a missing required variable aborts loading and is named in the error', () => {
    const env = { ...exampleEnv };
    delete env.DATABASE_URL;
    expect(() => validateEnv(env)).toThrow(/DATABASE_URL/);
  });

  test('all missing requirements are reported at once (fail fast, fail loud)', () => {
    const env = { ...exampleEnv };
    delete env.DATABASE_URL;
    delete env.REDIS_URL;
    delete env.FIELD_ENCRYPTION_KEY;
    expect(() => validateEnv(env)).toThrow(
      /DATABASE_URL[\s\S]*REDIS_URL[\s\S]*FIELD_ENCRYPTION_KEY/
    );
  });

  test('HTTPS enforcement fails closed in production (NFR-03, AB-05)', () => {
    const env = { ...exampleEnv, NODE_ENV: 'production', ENFORCE_HTTPS: 'false' };
    expect(() => validateEnv(env)).toThrow(/ENFORCE_HTTPS/);
  });

  test('live moderation mode requires provider variables — nothing hardcoded (ADR-007)', () => {
    const env = { ...exampleEnv, LLM_MODERATION_MODE: 'live' };
    expect(() => validateEnv(env)).toThrow(
      /LLM_MODERATION_BASE_URL[\s\S]*LLM_MODERATION_API_KEY[\s\S]*MODERATION_MODEL/
    );
  });

  test('config loads frozen under the test environment, push disabled (ADR-011)', () => {
    const config = require('../../src/config');
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.notifications)).toBe(true);
    expect(config.env).toBe('test');
    expect(config.notifications.transport).toBe('mock');
    expect(config.notifications.push.enabled).toBe(false);
  });
});

describe('ADR-009 — MEHKO caps are configuration, evaluated in America/Los_Angeles', () => {
  test('caps and boundary timezone live in src/config/locale.js', () => {
    const locale = require('../../src/config/locale');
    expect(locale.timezone).toBe('America/Los_Angeles');
    expect(locale.mehko.maxListingsPerHostPerDay).toBe(1);
    expect(locale.mehko.maxMealsPerHostPerDay).toBe(30);
    expect(locale.mehko.maxMealsPerHostPerWeek).toBe(90);
    expect(Object.isFrozen(locale)).toBe(true);
    expect(Object.isFrozen(locale.mehko)).toBe(true);
  });
});
