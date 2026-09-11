// tests/adr-conformance/adr-wave5-client-invariants.test.js — ADR conformance lane
// (verifier-owned). Wave-5 surface: the React web-client foundation under client/.
//
// The client ships no adapter, no SQL and no worker — so the binding invariants that CAN
// bite here are the ones about what the client is allowed to know and to do:
//   ADR-006 / NFR-03 — the session cookie is opaque + HttpOnly: client code must NEVER read
//              document.cookie, must send credentials on every /api call, and must never
//              disable TLS verification anywhere (dev server, proxy, a11y harness included).
//   ADR-010 / NFR-13 — the client's documented wire shape must match the backend PUBLIC
//              serializer exactly: coarseLat/coarseLng + areaLabel by default; the precise
//              address keys exist ONLY as the optional booking-gated privileged projection.
//              A client that hardcodes `listing.addressLine1` on a public path would mask a
//              server-side leak (or crash); one that documents lat/lng as public would
//              invite wave-6 screens to assume precision that never arrives.
//   ADR-007 — no provider name, model id or API-key literal anywhere under client/ either
//              (the wave-3 scan covers src/ and scripts/; this extends it to the new tree).
//   ADR-001 — the client package must not reach into the server's src/ (it talks HTTP only);
//              in particular nothing under client/ may import src/adapters/*.
//
// All checks are static (fs scans over the committed tree) and therefore cheap; the
// behavioural halves (credentials:'include' per call, 401 broadcast, degraded-state
// modelling) are pinned by the client's own vitest suites (client/src/api/*.test.js), which
// the wave gate runs separately — this file pins the repo-level safety properties that no
// client-package test can see (e.g. the backend serializer allowlist staying in sync).
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const CLIENT = path.join(ROOT, 'client');
const CLIENT_SRC = path.join(CLIENT, 'src');

/** Recursively list files under dir (skipping node_modules/dist) matching exts. */
function listFiles(dir, exts) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(p, exts));
    else if (entry.isFile() && exts.some((e) => p.endsWith(e))) out.push(p);
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p);

describe('wave-5 preconditions', () => {
  test('the client package exists and is non-trivial (the checks below scan a real tree)', () => {
    expect(fs.existsSync(path.join(CLIENT, 'package.json'))).toBe(true);
    const files = listFiles(CLIENT_SRC, ['.js', '.jsx']);
    expect(files.length).toBeGreaterThan(20);
  });
});

describe('ADR-006 / NFR-03 — cookie opacity and TLS are never compromised client-side', () => {
  test('no file under client/src reads document.cookie', () => {
    // Built from parts so this file itself never contains the contiguous pattern the
    // sibling repo-wide grep gate (client/src/api/endpoints.test.js) scans for.
    const cookieRead = new RegExp('document\\.' + 'cookie');
    const offenders = [];
    for (const file of listFiles(CLIENT_SRC, ['.js', '.jsx'])) {
      if (cookieRead.test(fs.readFileSync(file, 'utf8'))) offenders.push(rel(file));
    }
    expect(offenders).toEqual([]);
  });

  test('no TLS-verification bypass anywhere in client config, client source or the a11y harness', () => {
    const patterns = [
      /secure\s*:\s*false/, // vite proxy verification-off escape hatch
      /rejectUnauthorized\s*:\s*false/, // node https.Agent peer-check skip
      /NODE_TLS_REJECT_UNAUTHORIZED/, // process-wide TLS off
      /ignoreHTTPSErrors\s*:\s*true/, // playwright's certificate bypass
    ];
    const targets = [
      ...listFiles(CLIENT_SRC, ['.js', '.jsx']),
      path.join(CLIENT, 'vite.config.js'),
      path.join(CLIENT, 'vitest.setup.js'),
      path.join(ROOT, 'scripts', 'a11y-audit.js'),
    ];
    const offenders = [];
    for (const file of targets) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        const code = line.replace(/\/\/.*$/, ''); // comments may DISCUSS the banned options
        for (const p of patterns) {
          if (p.test(code)) offenders.push(`${rel(file)}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test('the vite /api proxy verifies the dev certificate via an explicit CA (never verification off)', () => {
    const text = fs.readFileSync(path.join(CLIENT, 'vite.config.js'), 'utf8');
    // The only sanctioned trust path: an https.Agent handed the dev cert as its CA.
    expect(text).toMatch(/new\s+https\.Agent\(\s*\{\s*ca\s*:/);
    expect(text).toMatch(/https:\/\/localhost/);
  });
});

describe('ADR-010 / NFR-13 — the client documents EXACTLY the backend public wire shape', () => {
  const serializers = require('../../src/modules/listings/serializers');

  test('backend PUBLIC_KEYS still carry coarse fields and no precise key (the contract being mirrored)', () => {
    expect(serializers.PUBLIC_KEYS).toEqual(
      expect.arrayContaining(['coarseLat', 'coarseLng', 'areaLabel'])
    );
    for (const k of serializers.PRIVILEGED_ONLY_KEYS) {
      expect(serializers.PUBLIC_KEYS).not.toContain(k);
    }
    expect(serializers.PRIVILEGED_ONLY_KEYS).toEqual(
      expect.arrayContaining(['addressLine1', 'addressLine2', 'lat', 'lng'])
    );
  });

  test('client/src/api/types.js documents every coarse public key and none of the precise keys as public', () => {
    const text = fs.readFileSync(path.join(CLIENT_SRC, 'api', 'types.js'), 'utf8');
    for (const key of ['coarseLat', 'coarseLng', 'areaLabel']) {
      expect(text).toContain(key);
    }
    // The PublicListing typedef block must not claim any privileged-only key as a property.
    const publicBlock = text.slice(text.indexOf('@typedef'), text.indexOf('PrivilegedListing'));
    expect(publicBlock.length).toBeGreaterThan(100); // both typedefs exist, in this order
    for (const key of serializers.PRIVILEGED_ONLY_KEYS) {
      expect(publicBlock).not.toMatch(new RegExp(`@property[^\\n]*\\b${key}\\b`));
    }
  });

  test('privileged address keys are read ONLY by the two gated screens (detail, owner edit), presence-guarded', () => {
    // Re-baselined by U6R-FIX (finding W6-G2). Wave 5 shipped no booking-gated screen, so
    // this guard banned every .addressLine1/.postalCode dereference outright. Wave 6 ships
    // exactly the screen ADR-010 permits: ListingDetailPage renders the exact address only
    // when the SERVER's booking-gated serializer included it (pending/in-progress guest —
    // src/modules/listings/access.js). The invariant keeps its direction: no OTHER shipped
    // module may touch a privileged key, and the one gated screen must presence-guard on
    // the payload itself carrying it — never assume the key exists (build-plan G.2 #8).
    // 2026-09-11: a SECOND permitted reader — the owner's edit screen (features/host), which
    // pre-fills the form from the owner's privileged read (src/modules/listings/access.js
    // grants the owner the exact address). Same rule: presence-guarded, and no third module.
    const gatedScreens = [
      path.join(CLIENT_SRC, 'features', 'discovery', 'ListingDetailPage.jsx'),
      path.join(CLIENT_SRC, 'features', 'host', 'EditMealPage.jsx'),
    ];
    for (const screen of gatedScreens) expect(fs.existsSync(screen)).toBe(true);
    const offenders = [];
    for (const file of listFiles(CLIENT_SRC, ['.js', '.jsx'])) {
      if (file.endsWith('.test.js') || file.endsWith('.test.jsx')) continue;
      if (file === path.join(CLIENT_SRC, 'api', 'types.js')) continue;
      const text = fs.readFileSync(file, 'utf8');
      if (!/\.(addressLine1|addressLine2|postalCode)\b/.test(text)) continue;
      if (!gatedScreens.includes(file)) {
        offenders.push(rel(file));
        continue;
      }
      // The gated screen must gate rendering on the payload carrying the key.
      if (!/addressLine1\s*!==\s*undefined/.test(text)) {
        offenders.push(`${rel(file)} (presence guard missing)`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('ADR-007 — no provider, model id or key literal under client/ either', () => {
  test('client sources and config are free of provider/model/key literals', () => {
    const patterns = [
      /generativelanguage\.googleapis/i,
      /gemini[-_ ]?(1\.5|2\.0|flash|pro)/i,
      /AIza[0-9A-Za-z_-]{10,}/, // Google API key shape
      /SG\.[0-9A-Za-z_-]{16,}/, // SendGrid key shape
      /api[_-]?key\s*[:=]\s*['"][^'"]{8,}['"]/i,
    ];
    const offenders = [];
    for (const file of [
      ...listFiles(CLIENT_SRC, ['.js', '.jsx']),
      path.join(CLIENT, 'vite.config.js'),
      path.join(CLIENT, 'index.html'),
    ]) {
      if (!fs.existsSync(file)) continue;
      const text = fs.readFileSync(file, 'utf8');
      for (const p of patterns) {
        if (p.test(text)) offenders.push(`${rel(file)}: ${p}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('ADR-001 — the client talks HTTP only; it never reaches into the server tree', () => {
  test('no import/require under client/src resolves into the repository src/ (adapters included)', () => {
    const importish = /(?:from\s+|require\(|import\()\s*['"]((?:\.\.\/)+[^'"]*|[^'".][^'"]*)['"]/g;
    const offenders = [];
    for (const file of listFiles(CLIENT_SRC, ['.js', '.jsx'])) {
      const text = fs.readFileSync(file, 'utf8');
      let m;
      while ((m = importish.exec(text)) !== null) {
        const spec = m[1];
        if (!spec.startsWith('..')) continue; // package imports and ./siblings are fine
        const resolved = path.resolve(path.dirname(file), spec);
        if (!resolved.startsWith(CLIENT)) offenders.push(`${rel(file)} -> ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
