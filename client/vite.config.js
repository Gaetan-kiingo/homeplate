// client/vite.config.js — Vite toolchain for the responsive React WEB client (SRS §2.1.2;
// scaffold for wave 5, extended by U5-SHELL). Requirement / decision traceability:
//   NFR-03 / ADR-006 — the dev and preview servers serve HTTPS ONLY, using the self-signed
//     material from scripts/gen-dev-certs.sh (certs/dev-{cert,key}.pem, git-ignored). The
//     /api proxy targets the HTTPS API and VERIFIES its certificate by passing the dev cert
//     as the CA through an explicit https.Agent — a self-signed certificate is its own CA and
//     its SAN covers localhost/127.0.0.1. Certificate verification stays ON everywhere: the
//     proxy's verification-off escape hatch, the agent option that skips peer checks, and the
//     Node global that disables TLS rejection are all banned anywhere in the client toolchain
//     (build-plan §6.1 5A.2).
//   SRS §4.1 — vitest (jsdom) is the client test runner; the root `npm test` backend Jest
//     contract is untouched (jest roots point at <rootDir>/tests only).
// Certs are REQUIRED for `vite dev` / `vite preview` (fail fast with the fix), NOT for
// `vite build` (CI builds need no listener) and NOT under vitest (mode === 'test': jsdom,
// no network listener either).
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const clientDir = path.dirname(fileURLToPath(import.meta.url));
const certPath = path.resolve(clientDir, '..', 'certs', 'dev-cert.pem');
const keyPath = path.resolve(clientDir, '..', 'certs', 'dev-key.pem');

/** HTTPS material for the dev/preview listener, or a loud failure when it is missing. */
function requireDevTls() {
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    throw new Error(
      'NFR-03: the Homeplate client dev/preview server serves HTTPS only, and ' +
        'certs/dev-cert.pem / certs/dev-key.pem are missing. Run scripts/gen-dev-certs.sh ' +
        'from the repository root first (certs/ is git-ignored).'
    );
  }
  return { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
}

export default defineConfig(({ command, mode }) => {
  const config = {
    plugins: [react()],
    // vitest — client tests only; backend tests stay under the root Jest contract.
    // `globals: true` is part of the published wave-5 interface: 5B unit specs may use bare
    // describe/it/expect/vi (the root ESLint override declares the same globals for client
    // test files); explicit `import { ... } from 'vitest'` keeps working too.
    test: {
      environment: 'jsdom',
      globals: true,
      setupFiles: ['./vitest.setup.js'],
      include: ['src/**/*.test.{js,jsx}'],
      css: true,
    },
  };

  // `vite dev` and `vite preview` both resolve with command === 'serve'; vitest resolves with
  // mode === 'test' and starts no HTTP listener, so it must not demand TLS material.
  if (command === 'serve' && mode !== 'test') {
    const tls = requireDevTls();
    // Override for a non-default API port only; the target stays https and stays verified.
    const apiTarget = process.env.VITE_API_PROXY_TARGET || 'https://localhost:3000';
    config.server = {
      https: tls,
      port: 5173,
      proxy: {
        '/api': {
          target: apiTarget,
          changeOrigin: true,
          // Explicit CA so the self-signed API certificate VERIFIES (never verification off).
          agent: new https.Agent({ ca: fs.readFileSync(certPath) }),
        },
      },
    };
    config.preview = { https: tls, port: 4173 };
  }

  return config;
});
