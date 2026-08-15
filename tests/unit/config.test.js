// tests/unit/config.test.js — U1-CONFIG acceptance (build-plan wave 1).
// Traceability: NFR-05 (login rate-limit knobs), NFR-09 (adapter timeout knobs),
// NFR-12 (retention windows), NFR-13 (field-encryption key required, coarsening radius),
// FR-08 (moderation provider passthrough + confidence threshold), FR-10 (email token TTL),
// FR-11 (ADR-009 MEHKO caps as configuration), FR-12 (concurrent pending-booking cap),
// FR-13 (outbox knobs, ADR-011 push gate).
//
// Proves the four acceptance clauses:
//   1. a missing required secret aborts startup (throws, no silent default);
//   2. every key in .env.example parses — and every schema key is documented there;
//   3. require('src/config') returns a deep-frozen object with the exact policy numbers;
//   4. no cap value appears as an inline literal anywhere else in src/ (grep).
'use strict';

const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const {
  validateEnv,
  envKeys,
  KNOWN_SAMPLE_FIELD_ENCRYPTION_KEY,
  DEFAULT_OBJECT_STORAGE_CREDENTIALS,
  isPlaceholderHexKey,
} = require('../../src/config/schema');

const ROOT = path.join(__dirname, '..', '..');
const ENV_EXAMPLE_PATH = path.join(ROOT, '.env.example');
const exampleText = fs.readFileSync(ENV_EXAMPLE_PATH, 'utf8');
const exampleEnv = dotenv.parse(exampleText);

// ---- 1. fail fast: a missing required secret aborts startup ------------------------------------

describe('U1-CONFIG fail-fast loading (no silent defaults for secrets)', () => {
  const REQUIRED = [
    'DATABASE_URL',
    'REDIS_URL',
    'FIELD_ENCRYPTION_KEY', // NFR-13
    'OBJECT_STORAGE_ENDPOINT', // ADR-004
    'OBJECT_STORAGE_BUCKET',
    'OBJECT_STORAGE_ACCESS_KEY',
    'OBJECT_STORAGE_SECRET_KEY',
  ];

  test.each(REQUIRED)('missing %s throws and names the variable', (key) => {
    const env = { ...exampleEnv };
    delete env[key];
    expect(() => validateEnv(env)).toThrow(new RegExp(key));
  });

  test('an empty-string secret is treated as missing, not as a value', () => {
    const env = { ...exampleEnv, FIELD_ENCRYPTION_KEY: '' };
    expect(() => validateEnv(env)).toThrow(/FIELD_ENCRYPTION_KEY/);
  });

  test('a malformed FIELD_ENCRYPTION_KEY (not 32 bytes hex) is rejected (NFR-13)', () => {
    const env = { ...exampleEnv, FIELD_ENCRYPTION_KEY: 'tooshort' };
    expect(() => validateEnv(env)).toThrow(/FIELD_ENCRYPTION_KEY/);
  });

  test('all problems are reported in one error (fail fast, fail loud)', () => {
    const env = { ...exampleEnv };
    delete env.DATABASE_URL;
    delete env.OBJECT_STORAGE_SECRET_KEY;
    expect(() => validateEnv(env)).toThrow(/DATABASE_URL[\s\S]*OBJECT_STORAGE_SECRET_KEY/);
  });
});

// ---- 2. .env.example is complete, parseable, and secret-free -----------------------------------

describe('U1-CONFIG .env.example (build-plan §5.11: documented variables, no real secrets)', () => {
  test('every key in .env.example parses (validateEnv accepts the documented values)', () => {
    expect(() => validateEnv(exampleEnv)).not.toThrow();
  });

  test('every uncommented key in .env.example is a variable the schema understands', () => {
    for (const key of Object.keys(exampleEnv)) {
      expect(envKeys).toContain(key);
    }
  });

  test('every schema variable is documented in .env.example (set or commented placeholder)', () => {
    for (const key of envKeys) {
      // NODE_ENV et al. appear as `KEY=value`; secrets appear as `#KEY=` placeholders.
      expect(exampleText).toMatch(new RegExp(`^#?${key}=`, 'm'));
    }
  });

  test('no real secret values: API keys and credentials are commented placeholders only', () => {
    for (const key of [
      'SENDGRID_API_KEY',
      'MAPS_API_KEY',
      'LLM_MODERATION_API_KEY',
      'FCM_SERVICE_ACCOUNT_JSON',
    ]) {
      expect(exampleEnv[key] ?? '').toBe('');
    }
  });
});

// ---- 3. the loaded config object: frozen, exact policy numbers ---------------------------------

describe('U1-CONFIG loaded config object (acceptance numbers)', () => {
  const config = require('../../src/config');

  function assertDeepFrozen(obj, trail) {
    expect(Object.isFrozen(obj)).toBe(true);
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v === 'object') assertDeepFrozen(v, `${trail}.${k}`);
    }
  }

  test('the config object is deep-frozen; mutation throws in strict mode', () => {
    assertDeepFrozen(config, 'config');
    expect(() => {
      config.mehko.maxMealsPerDay = 99;
    }).toThrow(TypeError);
    expect(() => {
      config.booking = {};
    }).toThrow(TypeError);
  });

  test('mehko caps (FR-11, AB-07, ADR-009): 1/day-listing, 30/day, 60/week, LA timezone', () => {
    expect(config.mehko).toEqual({
      listingsPerHostPerDay: 1,
      maxMealsPerDay: 30,
      maxMealsPerWeek: 60,
      timezone: 'America/Los_Angeles',
    });
  });

  test('booking.maxConcurrentPending = 3 (FR-12)', () => {
    expect(config.booking.maxConcurrentPending).toBe(3);
  });

  test('privacy: erasureDays 30, inactivityMonths 24, numeric coarsenRadiusMeters (NFR-12/13)', () => {
    expect(config.privacy.erasureDays).toBe(30);
    expect(config.privacy.inactivityMonths).toBe(24);
    expect(typeof config.privacy.coarsenRadiusMeters).toBe('number');
    expect(config.privacy.coarsenRadiusMeters).toBeGreaterThan(0);
  });

  test('auth: loginMaxAttempts 5 in loginWindowSeconds 600 (NFR-05)', () => {
    expect(config.auth.loginMaxAttempts).toBe(5);
    expect(config.auth.loginWindowSeconds).toBe(600);
  });

  test('adapters.timeoutMs = 3000 (NFR-09)', () => {
    expect(config.adapters.timeoutMs).toBe(3000);
  });

  test('notifications.push.enabled defaults to false (ADR-011)', () => {
    expect(config.notifications.push.enabled).toBe(false);
  });

  test('outbox.maxAttempts is a positive integer (ADR-003 dead-letter bound, FR-13)', () => {
    expect(Number.isInteger(config.outbox.maxAttempts)).toBe(true);
    expect(config.outbox.maxAttempts).toBeGreaterThan(0);
  });

  test('auth.emailTokenTtlHours defaults to 24 (FR-10)', () => {
    expect(config.auth.emailTokenTtlHours).toBe(24);
  });

  test('moderation.confidenceThreshold defaults to 0.8 (FR-08, ADR-002)', () => {
    expect(config.moderation.confidenceThreshold).toBe(0.8);
  });
});

// ---- passthrough + knob validation (validateEnv is pure, so exercised directly) ----------------

describe('U1-CONFIG moderation/auth knobs (FR-08, FR-10, ADR-007)', () => {
  test('LLM_MODERATION_BASE_URL / API_KEY / MODERATION_MODEL pass through verbatim', () => {
    const cfg = validateEnv({
      ...exampleEnv,
      LLM_MODERATION_BASE_URL: 'https://provider.example',
      LLM_MODERATION_API_KEY: 'test-key-not-real',
      MODERATION_MODEL: 'some-model-id',
    });
    expect(cfg.moderation.baseUrl).toBe('https://provider.example');
    expect(cfg.moderation.apiKey).toBe('test-key-not-real');
    expect(cfg.moderation.model).toBe('some-model-id');
  });

  test('live moderation mode requires all three provider variables (ADR-007)', () => {
    const env = { ...exampleEnv, LLM_MODERATION_MODE: 'live' };
    delete env.LLM_MODERATION_BASE_URL;
    expect(() => validateEnv(env)).toThrow(
      /LLM_MODERATION_BASE_URL[\s\S]*LLM_MODERATION_API_KEY[\s\S]*MODERATION_MODEL/
    );
  });

  test('MODERATION_CONFIDENCE_THRESHOLD accepts (0, 1] and rejects everything else', () => {
    expect(
      validateEnv({ ...exampleEnv, MODERATION_CONFIDENCE_THRESHOLD: '0.35' }).moderation
        .confidenceThreshold
    ).toBe(0.35);
    expect(
      validateEnv({ ...exampleEnv, MODERATION_CONFIDENCE_THRESHOLD: '1' }).moderation
        .confidenceThreshold
    ).toBe(1);
    for (const bad of ['0', '1.5', '-0.2', 'high']) {
      expect(() => validateEnv({ ...exampleEnv, MODERATION_CONFIDENCE_THRESHOLD: bad })).toThrow(
        /MODERATION_CONFIDENCE_THRESHOLD/
      );
    }
  });

  test('EMAIL_TOKEN_TTL_HOURS: configurable, defaults to 24, rejects non-positive', () => {
    const env = { ...exampleEnv };
    delete env.EMAIL_TOKEN_TTL_HOURS;
    expect(validateEnv(env).auth.emailTokenTtlHours).toBe(24);
    expect(
      validateEnv({ ...exampleEnv, EMAIL_TOKEN_TTL_HOURS: '48' }).auth.emailTokenTtlHours
    ).toBe(48);
    expect(() => validateEnv({ ...exampleEnv, EMAIL_TOKEN_TTL_HOURS: '0' })).toThrow(
      /EMAIL_TOKEN_TTL_HOURS/
    );
  });
});

// ---- production adapter modes: mocks are dev/test-only (ADR-005/007/011) -----------------------

describe('U1-CONFIG production rejects mock adapters (FR-01, FR-08, NFR-10, ADR-005/007/011)', () => {
  // A production-shaped environment: live modes with all the secrets they demand — including
  // REAL (non-placeholder) values for the two credentials .env.example ships as samples.
  // STS-W3-02: the sample FIELD_ENCRYPTION_KEY and the minioadmin storage credentials are
  // committed to this repository, so production refuses them; a fixture that kept them would
  // no longer be production-shaped. Their rejection is asserted below.
  const productionEnv = {
    ...exampleEnv,
    NODE_ENV: 'production',
    FIELD_ENCRYPTION_KEY: require('crypto').randomBytes(32).toString('hex'),
    OBJECT_STORAGE_ACCESS_KEY: 'not-a-real-access-key',
    OBJECT_STORAGE_SECRET_KEY: 'not-a-real-secret-key',
    NOTIFICATIONS_TRANSPORT: 'sendgrid',
    SENDGRID_API_KEY: 'test-key-not-real',
    SENDGRID_FROM_EMAIL: 'no-reply@homeplate.example',
    MAPS_MODE: 'live',
    MAPS_API_KEY: 'test-key-not-real',
    LLM_MODERATION_MODE: 'live',
    LLM_MODERATION_BASE_URL: 'https://provider.example',
    LLM_MODERATION_API_KEY: 'test-key-not-real',
    MODERATION_MODEL: 'some-model-id',
  };

  test('a fully live production environment validates (sanity baseline)', () => {
    const cfg = validateEnv(productionEnv);
    expect(cfg.maps.mode).toBe('live');
    expect(cfg.moderation.mode).toBe('live');
    expect(cfg.notifications.transport).toBe('sendgrid');
  });

  test('MAPS_MODE=mock is rejected in production (ADR-005 — no fabricated geocoding)', () => {
    expect(() => validateEnv({ ...productionEnv, MAPS_MODE: 'mock' })).toThrow(
      /MAPS_MODE=mock is not allowed in production/
    );
  });

  test('LLM_MODERATION_MODE=mock is rejected in production (ADR-007/ADR-002 — never publish unreviewed)', () => {
    expect(() => validateEnv({ ...productionEnv, LLM_MODERATION_MODE: 'mock' })).toThrow(
      /LLM_MODERATION_MODE=mock is not allowed in production/
    );
  });

  test('NOTIFICATIONS_TRANSPORT=mock is rejected in production (ADR-011)', () => {
    expect(() => validateEnv({ ...productionEnv, NOTIFICATIONS_TRANSPORT: 'mock' })).toThrow(
      /NOTIFICATIONS_TRANSPORT=mock is not allowed in production/
    );
  });

  test('COV-02 reproduction: all three mock overrides throw together, never return a config', () => {
    expect(() =>
      validateEnv({
        ...productionEnv,
        MAPS_MODE: 'mock',
        LLM_MODERATION_MODE: 'mock',
        NOTIFICATIONS_TRANSPORT: 'mock',
      })
    ).toThrow(/NOTIFICATIONS_TRANSPORT=mock[\s\S]*MAPS_MODE=mock[\s\S]*LLM_MODERATION_MODE=mock/);
  });

  test('mock adapters remain the accepted default outside production (dev/test/CI)', () => {
    const cfg = validateEnv({ ...exampleEnv, NODE_ENV: 'test' });
    expect(cfg.maps.mode).toBe('mock');
    expect(cfg.moderation.mode).toBe('mock');
    expect(cfg.notifications.transport).toBe('mock');
  });

  // ---- STS-W3-02: committed placeholder credentials fail closed in production ----------------
  // (NFR-13 encryption at rest, ST-06, AB-08 — a secret published in this repository is not a
  // secret. The dev/test defaults must keep working, so the guard is production-only.)

  test('the committed sample FIELD_ENCRYPTION_KEY is refused in production (NFR-13, ST-06)', () => {
    expect(exampleEnv.FIELD_ENCRYPTION_KEY).toBe(KNOWN_SAMPLE_FIELD_ENCRYPTION_KEY);
    expect(() =>
      validateEnv({ ...productionEnv, FIELD_ENCRYPTION_KEY: KNOWN_SAMPLE_FIELD_ENCRYPTION_KEY })
    ).toThrow(/FIELD_ENCRYPTION_KEY[\s\S]*openssl rand -hex 32/);
  });

  test('any repeated-block key is refused in production; a generated key is accepted', () => {
    for (const placeholder of ['0'.repeat(64), 'ab'.repeat(32), 'cafebabe'.repeat(8)]) {
      expect(isPlaceholderHexKey(placeholder)).toBe(true);
      expect(() => validateEnv({ ...productionEnv, FIELD_ENCRYPTION_KEY: placeholder })).toThrow(
        /FIELD_ENCRYPTION_KEY/
      );
    }
    const fresh = require('crypto').randomBytes(32).toString('hex');
    expect(isPlaceholderHexKey(fresh)).toBe(false);
    expect(() => validateEnv({ ...productionEnv, FIELD_ENCRYPTION_KEY: fresh })).not.toThrow();
  });

  test('the default MinIO object-storage credentials are refused in production (AB-08)', () => {
    for (const key of ['OBJECT_STORAGE_ACCESS_KEY', 'OBJECT_STORAGE_SECRET_KEY']) {
      expect(exampleEnv[key]).toBe(DEFAULT_OBJECT_STORAGE_CREDENTIALS[0]);
      expect(() =>
        validateEnv({ ...productionEnv, [key]: DEFAULT_OBJECT_STORAGE_CREDENTIALS[0] })
      ).toThrow(new RegExp(key));
    }
  });

  test('the same placeholders stay usable in development and test (guard is production-only)', () => {
    for (const env of ['development', 'test']) {
      const cfg = validateEnv({ ...exampleEnv, NODE_ENV: env });
      expect(cfg.crypto.fieldEncryptionKeyHex).toBe(KNOWN_SAMPLE_FIELD_ENCRYPTION_KEY);
      expect(cfg.objectStorage.accessKey).toBe(DEFAULT_OBJECT_STORAGE_CREDENTIALS[0]);
    }
  });
});

// ---- W3-ADR-02: NODE_ENV=test is pinned to the mock adapters (ADR-005/007/011) -----------------

describe('U1-CONFIG test environment refuses live adapters (ADR-007, ADR-005, ADR-011)', () => {
  const testEnv = { ...exampleEnv, NODE_ENV: 'test' };
  const live = {
    LLM_MODERATION_MODE: 'live',
    LLM_MODERATION_BASE_URL: 'https://provider.example/v1',
    LLM_MODERATION_API_KEY: 'test-key-not-real',
    MODERATION_MODEL: 'some-model-id',
    MAPS_MODE: 'live',
    MAPS_API_KEY: 'test-key-not-real',
  };

  test('LLM_MODERATION_MODE=live is refused under NODE_ENV=test (ADR-007)', () => {
    expect(() => validateEnv({ ...testEnv, ...live, MAPS_MODE: 'mock' })).toThrow(
      /LLM_MODERATION_MODE must be mock when NODE_ENV=test/
    );
  });

  test('MAPS_MODE=live is refused under NODE_ENV=test (ADR-005 — free-tier quota, no CI calls)', () => {
    expect(() =>
      validateEnv({ ...testEnv, MAPS_MODE: 'live', MAPS_API_KEY: 'test-key-not-real' })
    ).toThrow(/MAPS_MODE must be mock when NODE_ENV=test/);
  });

  test('ALLOW_LIVE_ADAPTERS_IN_TESTS=true is the documented IT-03 opt-in, and nothing more', () => {
    const cfg = validateEnv({ ...testEnv, ...live, ALLOW_LIVE_ADAPTERS_IN_TESTS: 'true' });
    expect(cfg.moderation.mode).toBe('live');
    expect(cfg.moderation.model).toBe('some-model-id'); // recorded with any IT-03 result
    expect(cfg.maps.mode).toBe('live');
    // It never relaxes ADR-011: the suite always asserts on persisted NOTIFICATION_ATTEMPT rows.
    expect(() =>
      validateEnv({
        ...testEnv,
        ALLOW_LIVE_ADAPTERS_IN_TESTS: 'true',
        NOTIFICATIONS_TRANSPORT: 'sendgrid',
        SENDGRID_API_KEY: 'test-key-not-real',
        SENDGRID_FROM_EMAIL: 'no-reply@homeplate.example',
      })
    ).toThrow(/NOTIFICATIONS_TRANSPORT must be mock when NODE_ENV=test/);
  });

  test('the opt-in defaults to false and grants nothing in development or production', () => {
    expect(validateEnv({ ...exampleEnv, ...live, NODE_ENV: 'development' }).moderation.mode).toBe(
      'live'
    ); // dev was never restricted
    expect(exampleEnv.ALLOW_LIVE_ADAPTERS_IN_TESTS).toBeUndefined(); // commented placeholder only
    expect(() => validateEnv({ ...testEnv, ...live })).toThrow(/NODE_ENV=test/);
  });
});

// ---- 4. grep: no cap value inlined anywhere else in src/ ---------------------------------------

describe('ADR-009 / SRS §2.1.7 — policy numbers live ONLY in src/config', () => {
  const CONFIG_DIR = path.join(ROOT, 'src', 'config');

  // A policy knob being (re)assigned a numeric literal, e.g. `maxMealsPerDay: 30` or
  // `{ timeoutMs = 3000 }` — legitimate code reads these from config instead.
  const INLINE_CAP = new RegExp(
    '\\b(' +
      [
        'listingsPerHostPerDay',
        'maxListingsPerHostPerDay',
        'maxMealsPerDay',
        'maxMealsPerHostPerDay',
        'maxMealsPerWeek',
        'maxMealsPerHostPerWeek',
        'maxConcurrentPending',
        'erasureDays',
        'inactivityMonths',
        'coarsenRadiusMeters',
        'loginMaxAttempts',
        'loginWindowSeconds',
        'emailTokenTtlHours',
        'confidenceThreshold',
        'maxAttempts',
        'timeoutMs',
      ].join('|') +
      ')\\s*[:=]\\s*[0-9]'
  );

  function jsFilesUnder(dir) {
    const out = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) out.push(...jsFilesUnder(full));
      else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  }

  // COV-01 regression guard: only executable code can enforce (or violate) a policy cap,
  // so blank out `//` and `/* */` comments before scanning. Doc text such as
  // `@param {number} [options.timeoutMs=3000]` repeatedly false-positived here.
  // String and template-literal contents are PRESERVED (a `//` inside a URL string is
  // not a comment, and blanking strings could hide a real literal later on the line),
  // which is why this is a small state machine rather than a regex strip.
  function stripComments(source) {
    let out = '';
    let i = 0;
    let state = 'code'; // code | line | block | single | double | template
    while (i < source.length) {
      const ch = source[i];
      const next = source[i + 1];
      if (state === 'code') {
        if (ch === '/' && next === '/') {
          state = 'line';
          i += 2;
          continue;
        }
        if (ch === '/' && next === '*') {
          state = 'block';
          i += 2;
          continue;
        }
        if (ch === "'") state = 'single';
        else if (ch === '"') state = 'double';
        else if (ch === '`') state = 'template';
        out += ch;
        i += 1;
        continue;
      }
      if (state === 'line') {
        if (ch === '\n') {
          state = 'code';
          out += ch;
        }
        i += 1;
        continue;
      }
      if (state === 'block') {
        if (ch === '*' && next === '/') {
          state = 'code';
          i += 2;
          continue;
        }
        if (ch === '\n') out += ch; // keep line structure for readable offender output
        i += 1;
        continue;
      }
      // inside a '…', "…" or `…` literal: honour escapes, keep contents verbatim
      if (ch === '\\') {
        out += ch + (next ?? '');
        i += 2;
        continue;
      }
      if (
        (state === 'single' && ch === "'") ||
        (state === 'double' && ch === '"') ||
        (state === 'template' && ch === '`') ||
        (state !== 'template' && ch === '\n') // unterminated line — bail back to code
      ) {
        state = 'code';
      }
      out += ch;
      i += 1;
      continue;
    }
    return out;
  }

  const offenders = [];
  for (const file of jsFilesUnder(path.join(ROOT, 'src'))) {
    if (file.startsWith(CONFIG_DIR + path.sep)) continue; // the single legitimate home
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    if (/Los_Angeles/.test(text)) {
      offenders.push(`${path.relative(ROOT, file)}: hardcodes the operating timezone`);
    }
    const hit = text.match(INLINE_CAP);
    if (hit) {
      offenders.push(`${path.relative(ROOT, file)}: inline policy literal "${hit[0]}"`);
    }
  }

  test('no cap value or timezone literal outside src/config', () => {
    expect(offenders).toEqual([]);
  });

  // Pin the scanner's contract so neither failure mode regresses:
  // comments must not trip it, and stripping them must not blind it to real code.
  describe('scanner self-check (COV-01: comments are documentation, not policy)', () => {
    test('a JSDoc default like [options.timeoutMs=3000] is NOT an offender', () => {
      const doc = '/**\n * @param {number} [options.timeoutMs=3000] budget\n */\nlet x;\n';
      expect(stripComments(doc)).not.toMatch(INLINE_CAP);
    });

    test('a // comment mentioning maxMealsPerDay: 30 or Los_Angeles is NOT an offender', () => {
      const line = 'doWork(); // ADR-009: maxMealsPerDay: 30, America/Los_Angeles\n';
      const stripped = stripComments(line);
      expect(stripped).not.toMatch(INLINE_CAP);
      expect(stripped).not.toMatch(/Los_Angeles/);
    });

    test('an executable inline literal IS still caught after stripping', () => {
      const code = 'const caps = { maxMealsPerDay: 30 };\n';
      expect(stripComments(code)).toMatch(INLINE_CAP);
    });

    test('a hardcoded timezone string in code IS still caught after stripping', () => {
      const code = "const tz = 'America/Los_Angeles';\n";
      expect(stripComments(code)).toMatch(/Los_Angeles/);
    });

    test('a // inside a string is not a comment — code after it is still scanned', () => {
      const code = "const u = 'https://x.example'; const timeoutMs = 3000;\n";
      expect(stripComments(code)).toMatch(INLINE_CAP);
    });
  });
});
