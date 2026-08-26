// scripts/a11y-audit.js — NFR-07 / UT-01 accessibility harness (wave-5 scaffold; waves 6-7
// extend it as the seven NFR-07 interfaces land — see docs/_generated/build-plan.md §6.1 5C
// and §8.6 / finding MTUT-RV-04).
//
// What it does, in order:
//   1. Builds the client (`npm --prefix client run build`) unless SKIP_CLIENT_BUILD=1 and
//      client/dist/ already exists.
//   2. Serves client/dist/ on 127.0.0.1 over plain local HTTP. Axe measures the DOM, not the
//      transport; TLS 1.2+ enforcement (NFR-03) is ST-01's lane against the real API server.
//      No TLS verification is disabled anywhere: there is simply no remote connection here.
//      DELIBERATE deviation from the plan's "boots vite preview" wording: `vite preview`
//      serves HTTPS with the self-signed dev certificate (client/vite.config.js, NFR-03),
//      which chromium only accepts via ignoreHTTPSErrors — i.e. TLS verification switched
//      off, which the client toolchain bans outright (build-plan §6.1 5A.2). Serving the
//      SAME `vite build` output over loopback HTTP audits the identical DOM with zero TLS
//      compromises anywhere.
//   3. Discovers the routes that exist: '/' always, plus every `path: '...'` literal declared
//      in client/src/features/*/routes.jsx (the U5-SHELL glob-mount convention, so a wave-6
//      feature's routes are discovered without this file being edited). Parameterized paths
//      (`:id`) count as EXISTING for interface coverage but cannot be audited without seeded
//      fixture ids — wave 7 supplies those; until then they hold the gate red.
//   4. Audits every auditable route with axe-core (@axe-core/playwright, pinned devDependency
//      with a lockfile-pinned browser driver, never a floating npx resolution — finding
//      MTUT-W3-03) at wcag2a + wcag2aa. Serious/critical
//      violations fail the route. On '/' it also runs the keyboard checks: the FIRST Tab must
//      land on the skip link, and activating the skip link must move focus to #main.
//   5. Maps the discovered routes onto the SEVEN NFR-07 interfaces and prints coverage.
//
// EXIT CODE — the §8.6 rule: this script exits NON-ZERO until ALL SEVEN interfaces exist,
// every one of them was actually audited, and every audited route is clean. A run that audits
// nothing, or fewer than the seven interfaces, can never exit 0 — an exit-0 no-op is the worst
// outcome, because it would read as NFR-07 coverage that does not exist. The 5-participant
// usability study (SRS §4.5, UT-01) is a human activity recorded separately; this harness
// alone NEVER closes NFR-07.
//
// Host prerequisite (documented in README): `npx playwright install chromium` — the pinned
// playwright package downloads its own pinned browser build; nothing floats.
'use strict';
/* global document -- only inside page.evaluate() callbacks, which playwright executes in the
   audited chromium page, not in this Node process. */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CLIENT_DIR = path.join(ROOT, 'client');
const DIST_DIR = path.join(CLIENT_DIR, 'dist');
const FEATURES_DIR = path.join(CLIENT_DIR, 'src', 'features');

// The seven NFR-07 interfaces (SRS §4.5 / UT-01; the fail-on-purpose predecessor of this
// script named the same seven). `patterns` match the ROUTE PATH STRINGS declared by the
// wave-6 features. An unmapped route keeps coverage below 7/7 and the gate red — the mapping
// can only fail toward red, never toward false coverage.
const NFR07_INTERFACES = [
  {
    id: 'search-browse',
    label: 'Search / browse (FR-01)',
    patterns: [/^\/(search|browse)(\/|$)/, /^\/listings\/?$/],
  },
  { id: 'listing-detail', label: 'Listing detail (FR-02)', patterns: [/^\/listings\/.+/] },
  { id: 'host-profile', label: 'Host profile (FR-03)', patterns: [/^\/hosts\/.+/] },
  { id: 'booking-flow', label: 'Booking flow (FR-04, FR-12)', patterns: [/^\/bookings(\/|$)/] },
  {
    id: 'signup-login',
    label: 'Signup / login (FR-09, FR-10)',
    patterns: [/^\/(login|signup|register)(\/|$)/],
  },
  {
    id: 'messaging',
    label: 'Messaging (FR-06)',
    patterns: [/^\/messages(\/|$)/, /^\/bookings\/[^/]+\/messages/],
  },
  {
    id: 'moderator-queue',
    label: 'Moderator queue (FR-08)',
    patterns: [/^\/(moderation|queue)(\/|$)/],
  },
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

function buildClient() {
  if (process.env.SKIP_CLIENT_BUILD === '1' && fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    console.log('a11y-audit: SKIP_CLIENT_BUILD=1 and client/dist exists — reusing the build');
    return;
  }
  console.log('a11y-audit: building the client (npm --prefix client run build)…');
  const result = spawnSync('npm', ['--prefix', CLIENT_DIR, 'run', 'build'], {
    stdio: 'inherit',
    cwd: ROOT,
  });
  if (result.status !== 0) {
    console.error('a11y-audit: client build failed — nothing to audit.');
    process.exit(1);
  }
}

/** Static file server over client/dist with SPA fallback to index.html. */
function serveDist() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    let filePath = path.normalize(path.join(DIST_DIR, urlPath));
    if (!filePath.startsWith(DIST_DIR)) {
      res.writeHead(403).end();
      return;
    }
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST_DIR, 'index.html'); // SPA fallback — client router owns the path
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath)] || 'application/octet-stream',
    });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Route paths declared by wave-6 features (path: '...' literals in features/<name>/routes.jsx). */
function discoverFeatureRoutes() {
  const routes = [];
  if (!fs.existsSync(FEATURES_DIR)) return routes;
  for (const entry of fs.readdirSync(FEATURES_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const routesFile = path.join(FEATURES_DIR, entry.name, 'routes.jsx');
    if (!fs.existsSync(routesFile)) continue;
    const source = fs.readFileSync(routesFile, 'utf8');
    for (const match of source.matchAll(/path:\s*['"`]([^'"`]+)['"`]/g)) {
      const p = match[1].startsWith('/') ? match[1] : `/${match[1]}`;
      routes.push({ path: p, feature: entry.name });
    }
  }
  return routes;
}

async function auditRoute(page, AxeBuilder, origin, routePath) {
  await page.goto(origin + routePath, { waitUntil: 'networkidle' });
  const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze();
  const gating = results.violations.filter(
    (v) => v.impact === 'serious' || v.impact === 'critical'
  );
  const advisory = results.violations.filter(
    (v) => v.impact !== 'serious' && v.impact !== 'critical'
  );
  return { gating, advisory };
}

async function keyboardChecks(page, origin) {
  const failures = [];
  await page.goto(origin + '/', { waitUntil: 'networkidle' });
  await page.keyboard.press('Tab');
  const first = await page.evaluate(() => {
    const el = document.activeElement;
    return el
      ? { tag: el.tagName, href: el.getAttribute('href'), text: (el.textContent || '').trim() }
      : null;
  });
  if (!first || first.tag !== 'A' || first.href !== '#main') {
    failures.push(
      `first Tab must land on the skip link (a[href="#main"]) — got ${JSON.stringify(first)}`
    );
  } else {
    await page.keyboard.press('Enter');
    const focusedId = await page.evaluate(() =>
      document.activeElement ? document.activeElement.id : null
    );
    if (focusedId !== 'main') {
      failures.push(
        `activating the skip link must move focus to #main — focus is on ${JSON.stringify(focusedId)}`
      );
    }
  }
  return failures;
}

async function main() {
  buildClient();

  let chromium, AxeBuilder;
  try {
    ({ chromium } = require('playwright'));
    ({ default: AxeBuilder } = require('@axe-core/playwright'));
  } catch (err) {
    console.error(
      'a11y-audit: pinned harness dependencies missing — run `npm ci` at the repo root.'
    );
    console.error(String(err && err.message));
    process.exit(1);
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    console.error('a11y-audit: chromium is not installed for the pinned playwright version.');
    console.error('Host step (README): npx playwright install chromium');
    console.error(String(err && err.message).split('\n')[0]);
    process.exit(1);
  }

  const server = await serveDist();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const failures = [];

  try {
    // @axe-core/playwright requires a page created from an explicit context.
    const context = await browser.newContext();
    const page = await context.newPage();

    // ---- routes that exist on this tree --------------------------------------------------
    // The shell always ships '/' (home) and the '*' catch-all 404 (client/src/routes.jsx);
    // the 404 is audited through a path no feature declares, so it stays the catch-all even
    // once wave 6 lands.
    const featureRoutes = discoverFeatureRoutes();
    const auditable = [
      { path: '/', feature: 'shell' },
      { path: '/a11y-audit-not-a-page', feature: 'shell 404 catch-all' },
    ].concat(featureRoutes.filter((r) => !r.path.includes(':')));
    const parameterized = featureRoutes.filter((r) => r.path.includes(':'));

    // ---- axe on every auditable route ----------------------------------------------------
    for (const route of auditable) {
      const { gating, advisory } = await auditRoute(page, AxeBuilder, origin, route.path);
      const label = `${route.path} (${route.feature})`;
      if (gating.length === 0) {
        console.log(
          `  ok    ${label} — 0 serious/critical wcag2a+wcag2aa violations` +
            (advisory.length ? ` (${advisory.length} lower-impact finding(s) reported below)` : '')
        );
      } else {
        console.error(`  FAIL  ${label} — ${gating.length} serious/critical violation(s):`);
        for (const v of gating) {
          console.error(`          [${v.impact}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`);
        }
        failures.push(`${label}: ${gating.length} serious/critical axe violation(s)`);
      }
      for (const v of advisory) {
        console.log(
          `          note [${v.impact || 'n/a'}] ${v.id}: ${v.help} (${v.nodes.length} node(s))`
        );
      }
    }

    // ---- keyboard checks on the shell ----------------------------------------------------
    const kb = await keyboardChecks(page, origin);
    if (kb.length === 0) {
      console.log('  ok    keyboard: first Tab reaches the skip link; activating it focuses #main');
    } else {
      for (const f of kb) {
        console.error(`  FAIL  keyboard: ${f}`);
        failures.push(`keyboard: ${f}`);
      }
    }

    for (const route of parameterized) {
      console.log(
        `  info  ${route.path} (${route.feature}) exists but is parameterized — auditing it ` +
          'needs seeded fixture ids (wave 7); it stays UNAUDITED and holds the gate red'
      );
      failures.push(`${route.path} exists but is not yet audited (parameterized; wave 7)`);
    }

    // ---- NFR-07 interface coverage -------------------------------------------------------
    const allPaths = featureRoutes.map((r) => r.path);
    let present = 0;
    console.log('\na11y-audit: NFR-07 interface coverage');
    for (const iface of NFR07_INTERFACES) {
      const hit = allPaths.find((p) => iface.patterns.some((re) => re.test(p)));
      if (hit) {
        present += 1;
        console.log(`  present  ${iface.label} — route ${hit}`);
      } else {
        console.log(`  MISSING  ${iface.label}`);
        failures.push(`interface missing: ${iface.label}`);
      }
    }
    console.log(
      `\na11y-audit: ${present} of the 7 NFR-07 interfaces exist on this tree` +
        (present < 7
          ? ' — the audit gate stays RED until wave 6 lands all seven (build-plan §8.6).'
          : '.')
    );

    if (failures.length > 0) {
      console.error(`\na11y-audit: FAIL — ${failures.length} blocking item(s):`);
      for (const f of failures) console.error(`  - ${f}`);
      console.error(
        'Reminder: even at 7/7 green, NFR-07 also requires the recorded 5-participant usability ' +
          'study (SRS §4.5, UT-01) — a human activity this script cannot perform.'
      );
      process.exitCode = 1;
    } else {
      console.log(
        '\na11y-audit: PASS — all 7 NFR-07 interfaces audited clean at wcag2a+wcag2aa. ' +
          'NFR-07 still needs the recorded 5-participant study (UT-01) before it can be closed.'
      );
    }
  } finally {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  }
}

main().catch((err) => {
  console.error('a11y-audit: unexpected failure');
  console.error(err && err.stack ? err.stack : String(err));
  process.exit(1);
});
