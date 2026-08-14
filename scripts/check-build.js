// scripts/check-build.js — `npm run build` for the no-transpile CommonJS server (U0-BOOTSTRAP;
// build-plan §2). Toolchain substrate for NFR-11 (the fail-fast env contract and migration
// ordering it enforces are what keep the validation/parameterized-SQL discipline buildable)
// and for NFR-02/NFR-08 (CI blocks on this gate). Four checks, all reported before exiting
// non-zero:
//   1. .env.example satisfies the config schema — the template must enumerate every required
//      variable, so the fail-fast loader (U1-CONFIG) and the template can never drift apart.
//   2. db/migrations/*.sql are well-formed: NNNN_name.sql, unique ordered versions.
//   3. Every .js under src/ and scripts/ parses (node --check); tests/ parse under Jest anyway,
//      and tests/load/ is excluded because k6 scripts are ESM for the k6 runtime, not Node.
//   4. If src/app.js exists (U1-HTTP, wave 1), the Express app factory boots in a child
//      process against the .env.example environment. Its absence before wave 1 is reported,
//      not failed.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const dotenv = require('dotenv');
const { validateEnv } = require('../src/config/schema');
const { listMigrations } = require('./migrate');

const ROOT = path.join(__dirname, '..');
const failures = [];

function ok(msg) {
  console.log(`  ok    ${msg}`);
}
function fail(msg) {
  failures.push(msg);
  console.error(`  FAIL  ${msg}`);
}
function info(msg) {
  console.log(`  info  ${msg}`);
}

// ---- 1. .env.example completeness -------------------------------------------------------------
console.log('check-build: env template');
const examplePath = path.join(ROOT, '.env.example');
let exampleEnv = {};
if (!fs.existsSync(examplePath)) {
  fail('.env.example is missing — every required variable must be documented there');
} else {
  exampleEnv = dotenv.parse(fs.readFileSync(examplePath, 'utf8'));
  try {
    validateEnv(exampleEnv);
    ok('.env.example satisfies the config schema (fail-fast loader contract)');
  } catch (err) {
    fail(`.env.example no longer satisfies the config schema:\n${err.message}`);
  }
}

// ---- 2. migrations ---------------------------------------------------------------------------
console.log('check-build: migrations');
try {
  const migrations = listMigrations();
  ok(`db/migrations: ${migrations.length} file(s), naming and ordering valid`);
} catch (err) {
  fail(err.message);
}

// ---- 3. syntax check -------------------------------------------------------------------------
console.log('check-build: syntax (node --check)');
function walkJs(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      walkJs(full, out);
    } else if (entry.name.endsWith('.js')) {
      out.push(full);
    }
  }
  return out;
}
const jsFiles = [...walkJs(path.join(ROOT, 'src')), ...walkJs(path.join(ROOT, 'scripts'))];
let syntaxFailures = 0;
for (const file of jsFiles) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    syntaxFailures += 1;
    fail(`syntax error in ${path.relative(ROOT, file)}:\n${result.stderr.trim()}`);
  }
}
if (syntaxFailures === 0) ok(`${jsFiles.length} file(s) parse cleanly`);

// ---- 4. app factory boot ---------------------------------------------------------------------
console.log('check-build: app factory');
const appPath = path.join(ROOT, 'src', 'app.js');
if (!fs.existsSync(appPath)) {
  info('src/app.js not present yet (arrives with U1-HTTP in wave 1) — boot check skipped');
} else {
  // Boot in a child process so the example env cannot leak into this process. Test-style env:
  // transport enforcement off (build-plan §2 — fails closed in production), mock adapters.
  const bootEnv = {
    ...process.env,
    ...exampleEnv,
    NODE_ENV: 'test',
    ENFORCE_HTTPS: 'false',
    NOTIFICATIONS_TRANSPORT: 'mock',
    MAPS_MODE: 'mock',
    LLM_MODERATION_MODE: 'mock',
  };
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const { createApp } = require(${JSON.stringify(appPath)});
       const app = createApp();
       if (!app || typeof app.use !== 'function') { console.error('createApp() did not return an Express app'); process.exit(2); }
       console.log('app factory booted');`,
    ],
    { encoding: 'utf8', env: bootEnv, cwd: ROOT }
  );
  if (result.status === 0) {
    ok('src/app.js createApp() boots against the .env.example environment');
  } else {
    fail(`app factory failed to boot:\n${(result.stderr || result.stdout).trim()}`);
  }
}

// ---- summary ---------------------------------------------------------------------------------
if (failures.length > 0) {
  console.error(`\ncheck-build: ${failures.length} failure(s)`);
  process.exit(1);
}
console.log('\ncheck-build: all checks passed');
