// tests/mt-ut-quality/ut01-keyboard-spotcheck.js — UT-01 / NFR-07 keyboard-navigation spot
// checks (verifier lane "mt-ut-quality"). NOT a jest test (jest collects *.test.js only, so
// this file can never change the backend suite count): run it directly with
//   node tests/mt-ut-quality/ut01-keyboard-spotcheck.js
// after `npm run test:a11y` (or any `npm --prefix client run build`) has produced client/dist.
//
// What it proves, per audited route (the non-parameterized subset of the NFR-07 seven):
//   1. Keyboard-only traversal (Tab) reaches EVERY visible interactive control on the page.
//   2. Every control, WHILE FOCUSED VIA KEYBOARD, shows a visible focus indicator
//      (computed outline-width > 0 with outline-style != none, or a non-none box-shadow).
// This is the "keyboard-only traversal reaches every interactive control with a visible
// focus indicator" clause of NFR-07's acceptance, which scripts/a11y-audit.js only samples
// on '/' (skip-link check). The 5-participant moderated study remains a human activity.
'use strict';
/* global document, getComputedStyle -- only inside page.evaluate() callbacks, which
   playwright executes in the audited chromium page, not in this Node process (same pattern
   as scripts/a11y-audit.js). */

const fs = require('fs');
const http = require('http');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const DIST_DIR = path.join(ROOT, 'client', 'dist');

const ROUTES = [
  '/login',
  '/signup',
  '/verify-email',
  '/account',
  '/search',
  '/bookings',
  '/bookings/new',
  '/moderation',
  '/moderation/alerts',
];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveDist() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
    let filePath = path.normalize(path.join(DIST_DIR, urlPath));
    if (!filePath.startsWith(DIST_DIR)) return void res.writeHead(403).end();
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      filePath = path.join(DIST_DIR, 'index.html');
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(filePath)] || 'text/plain' });
    fs.createReadStream(filePath).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function spotCheckRoute(page, origin, routePath) {
  const failures = [];
  await page.goto(origin + routePath, { waitUntil: 'networkidle' });

  // Enumerate the visible interactive controls a keyboard user must be able to reach.
  const expected = await page.evaluate(() => {
    const sel = 'a[href], button, input, select, textarea, [tabindex]';
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      if (el.tabIndex < 0) continue; // explicitly removed from the tab order
      if (el.disabled) continue;
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      // The skip link is legitimately off-screen until focused — keep it.
      const isSkip = el.getAttribute('href') === '#main';
      if (!isSkip && r.width === 0 && r.height === 0) continue;
      const key =
        el.tagName +
        '#' +
        (el.id || '') +
        '[' +
        (el.getAttribute('name') ||
          el.getAttribute('href') ||
          (el.textContent || '').trim().slice(0, 40)) +
        ']';
      el.setAttribute('data-kbd-key', key + '::' + out.length);
      out.push(key + '::' + out.length);
    }
    return out;
  });

  // Tab through the document and record every focus stop + its focus indicator.
  const reached = new Set();
  const noIndicator = [];
  const budget = expected.length * 3 + 20; // runaway guard, not a tuning knob
  let lastKey = null;
  let wrapped = false;
  for (let i = 0; i < budget && !wrapped; i += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return { key: null };
      const cs = getComputedStyle(el);
      const visible =
        (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) ||
        (cs.boxShadow && cs.boxShadow !== 'none');
      return { key: el.getAttribute('data-kbd-key'), tag: el.tagName, visible };
    });
    if (stop.key === null) continue; // focus passed through body (wrap boundary)
    if (reached.has(stop.key) && stop.key !== lastKey) wrapped = true; // full cycle done
    if (stop.key) {
      if (!reached.has(stop.key) && !stop.visible) {
        noIndicator.push(stop.key + ' <' + stop.tag + '>');
      }
      reached.add(stop.key);
    }
    lastKey = stop.key;
  }

  const unreached = expected.filter((k) => !reached.has(k));
  if (unreached.length) {
    failures.push(
      `${routePath}: ${unreached.length}/${expected.length} interactive control(s) NOT reachable by Tab: ${unreached.join(', ')}`
    );
  }
  if (noIndicator.length) {
    failures.push(
      `${routePath}: focused WITHOUT a visible focus indicator: ${noIndicator.join(', ')}`
    );
  }
  return { failures, expectedCount: expected.length, reachedCount: reached.size };
}

async function main() {
  if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
    console.error(
      'ut01-keyboard-spotcheck: client/dist missing — run `npm --prefix client run build` first.'
    );
    process.exit(2);
  }
  const { chromium } = require('playwright');
  const server = await serveDist();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  let failed = false;
  for (const route of ROUTES) {
    const { failures, expectedCount, reachedCount } = await spotCheckRoute(page, origin, route);
    if (failures.length) {
      failed = true;
      for (const f of failures) console.error('  FAIL  ' + f);
    } else {
      console.log(
        `  ok    ${route} — ${reachedCount}/${expectedCount} interactive controls reached by Tab, all with a visible focus indicator`
      );
    }
  }
  await browser.close();
  server.close();
  console.log(failed ? 'ut01-keyboard-spotcheck: FAIL' : 'ut01-keyboard-spotcheck: PASS');
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('ut01-keyboard-spotcheck: crashed —', err);
  process.exit(2);
});
