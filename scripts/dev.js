// scripts/dev.js — `npm run dev`: run the API server and the outbox worker together
// (build-plan §2). Existence-aware because the two entry points arrive in different waves:
// src/server.js with U1-HTTP (wave 1), scripts/worker.js with U2-OUTBOX (wave 2). Each present
// process is spawned with inherited stdio; SIGINT/SIGTERM stop both.
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const targets = [
  { name: 'api', file: path.join(ROOT, 'src', 'server.js'), wave: 'U1-HTTP (wave 1)' },
  { name: 'worker', file: path.join(ROOT, 'scripts', 'worker.js'), wave: 'U2-OUTBOX (wave 2)' },
];

const present = targets.filter((t) => fs.existsSync(t.file));
const missing = targets.filter((t) => !fs.existsSync(t.file));

for (const t of missing) {
  console.warn(`dev: ${path.relative(ROOT, t.file)} does not exist yet — built by ${t.wave}`);
}
if (present.length === 0) {
  console.error('dev: nothing to run yet. Infrastructure only: docker compose up -d');
  process.exit(1);
}

const children = [];
let shuttingDown = false;

for (const t of present) {
  const child = spawn(process.execPath, [t.file], { stdio: 'inherit', cwd: ROOT });
  console.log(`dev: started ${t.name} (${path.relative(ROOT, t.file)}) pid ${child.pid}`);
  child.on('exit', (code, signal) => {
    if (shuttingDown) return;
    console.error(`dev: ${t.name} exited (code=${code} signal=${signal}) — stopping the rest`);
    shutdown(code === 0 ? 0 : 1);
  });
  children.push(child);
}

function shutdown(exitCode) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  }
  // Give children a moment to close their pools before the parent exits.
  setTimeout(() => process.exit(exitCode), 500).unref();
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
