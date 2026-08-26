// client/src/ui/kit-contract.test.js — U5-UI-KIT contract gates (NFR-07; build-plan §6.1 5B):
//   1. styles/tokens.css documents a measured contrast ratio for every colour pair, and this
//      spec RECOMPUTES each ratio from the hex values in the file — a drifted comment, a
//      renamed token or an under-threshold pair (body >= 4.5:1; large/ui/focus >= 3:1) fails
//      the suite. The numbers in the comments are therefore verified facts, not decoration.
//   2. Grep gate: no off-token colour literals anywhere in the kit's shipped sources — every
//      colour flows through a token whose pairs are measured above.
//   3. Leaf gate: the kit imports nothing from layout/, api/, session/ (or anywhere outside
//      react/react-dom and its own directory) — it is the dependency LEAF of the client.
//   4. The published export surface is exactly the wave-5 interface wave-6 builds on.
//   5. tokens.css ships the focus-indicator tokens, the responsive type/spacing scale, and a
//      prefers-reduced-motion block.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as kit from './index.js';

const uiDir = path.dirname(fileURLToPath(import.meta.url));
const tokensPath = path.join(uiDir, '..', 'styles', 'tokens.css');
const tokensCss = fs.readFileSync(tokensPath, 'utf8');

/** Shipped kit sources: everything under ui/ except the specs themselves. */
const shippedFiles = fs
  .readdirSync(uiDir)
  .filter((name) => /\.(jsx|js|css)$/.test(name) && !name.includes('.test.'))
  .map((name) => ({ name, text: fs.readFileSync(path.join(uiDir, name), 'utf8') }));

// WCAG 2.1 relative luminance + contrast ratio, floored to 2 decimals — the exact procedure
// used to produce the documented numbers, so equality is exact, not approximate.
function luminance(hex) {
  const channels = [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255);
  const [r, g, b] = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)
  );
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA, hexB) {
  const [hi, lo] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
  return Math.floor(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
}

function parseHexTokens(css) {
  const tokens = {};
  for (const match of css.matchAll(/(--hp-[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) {
    tokens[match[1]] = match[2];
  }
  return tokens;
}

const CONTRAST_LINE =
  /contrast:\s*(--hp-[a-z0-9-]+)\s+on\s+(--hp-[a-z0-9-]+)\s*=\s*([0-9]+(?:\.[0-9]+)?):1\s*\((body|large|ui|focus|exempt|decorative)/g;
const MIN_BY_TAG = { body: 4.5, large: 3, ui: 3, focus: 3 };

describe('tokens.css measured-contrast contract (NFR-07: >= 4.5:1 body, >= 3:1 large/UI/focus)', () => {
  const hexTokens = parseHexTokens(tokensCss);
  const documented = [...tokensCss.matchAll(CONTRAST_LINE)].map((m) => ({
    fg: m[1],
    bg: m[2],
    documentedRatio: Number(m[3]),
    tag: m[4],
  }));

  it('documents a substantial pair set (every text/background pairing the kit uses)', () => {
    expect(documented.length).toBeGreaterThanOrEqual(15);
  });

  it.each(documented)(
    '$fg on $bg: documented $documentedRatio:1 ($tag) matches the recomputed ratio and its floor',
    ({ fg, bg, documentedRatio, tag }) => {
      expect(hexTokens[fg], `${fg} must be a hex token in tokens.css`).toBeDefined();
      expect(hexTokens[bg], `${bg} must be a hex token in tokens.css`).toBeDefined();
      const measured = contrastRatio(hexTokens[fg], hexTokens[bg]);
      expect(measured).toBe(documentedRatio);
      if (MIN_BY_TAG[tag]) {
        expect(measured).toBeGreaterThanOrEqual(MIN_BY_TAG[tag]);
      }
    }
  );

  it('every hex colour token appears in at least one measured pair — no unmeasured colours', () => {
    const paired = new Set(documented.flatMap(({ fg, bg }) => [fg, bg]));
    const colourTokens = Object.keys(hexTokens).filter((name) => name.startsWith('--hp-color-'));
    expect(colourTokens.length).toBeGreaterThan(0);
    for (const token of colourTokens) {
      expect(paired.has(token), `${token} has no measured contrast pair`).toBe(true);
    }
  });

  it('ships the visible-focus-indicator tokens (NFR-07 keyboard traversal)', () => {
    expect(tokensCss).toMatch(/--hp-focus-ring-width:/);
    expect(tokensCss).toMatch(/--hp-focus-ring-offset:/);
    expect(tokensCss).toMatch(/--hp-focus-ring-color:/);
  });

  it('ships the responsive type and spacing scales', () => {
    for (const token of ['sm', 'base', 'lg', 'xl', '2xl']) {
      expect(tokensCss).toMatch(new RegExp(`--hp-font-size-${token}:`));
    }
    for (let step = 1; step <= 7; step += 1) {
      expect(tokensCss).toMatch(new RegExp(`--hp-space-${step}:`));
    }
    expect(tokensCss).toMatch(/clamp\(/); // fluid type between the 320px floor and desktop
  });

  it('respects prefers-reduced-motion at the token level', () => {
    expect(tokensCss).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });
});

describe('kit grep gates (build-plan §6.1 5B: token-only colour, leaf imports)', () => {
  const HEX_LITERAL = /#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/;
  const FUNCTION_COLOUR = /\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|color-mix)\s*\(/;
  const NAMED_COLOUR =
    /:\s*[^;{}]*\b(?:white|black|red|green|blue|gray|grey|yellow|orange|purple|pink|brown|cyan|magenta|silver|gold|navy|teal|maroon|olive|aqua|fuchsia|lime|coral|salmon|crimson|indigo|violet|tan|beige|ivory|khaki)\b/i;

  it('has shipped sources to gate (the kit exists)', () => {
    expect(shippedFiles.length).toBeGreaterThanOrEqual(20); // 12 modules + index + css modules
  });

  it.each(shippedFiles)('$name contains no off-token colour literal', ({ name, text }) => {
    expect(text).not.toMatch(HEX_LITERAL);
    expect(text).not.toMatch(FUNCTION_COLOUR);
    if (name.endsWith('.css')) {
      const withoutComments = text.replace(/\/\*[\s\S]*?\*\//g, '');
      expect(withoutComments).not.toMatch(NAMED_COLOUR);
    }
  });

  it.each(shippedFiles.filter((f) => /\.(jsx|js)$/.test(f.name)))(
    '$name is a leaf: imports only react, react-dom, or its own siblings',
    ({ text }) => {
      const specifiers = [...text.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
      for (const specifier of specifiers) {
        expect(specifier).toMatch(/^(?:react|react-dom(?:\/[a-z-]+)?|\.\/[A-Za-z][\w.-]*)$/);
      }
    }
  );

  it('never reads the opaque HttpOnly session cookie (ADR-006/NFR-03)', () => {
    // Pattern assembled from parts so this spec never trips the repo-wide cookie grep gate.
    const cookieRead = new RegExp('document' + '\\s*\\.\\s*' + 'cookie');
    for (const { text } of shippedFiles) {
      expect(text).not.toMatch(cookieRead);
    }
  });
});

describe('published export surface (build-plan §7: what wave 6 builds on)', () => {
  it('exports exactly the 13 published names', () => {
    expect(Object.keys(kit).sort()).toEqual(
      [
        'Button',
        'Card',
        'Dialog',
        'ErrorSummary',
        'FormField',
        'Img',
        'Select',
        'Spinner',
        'StatusAnnouncer',
        'TextArea',
        'TextInput',
        'VisuallyHidden',
        'useAnnounce',
      ].sort()
    );
    for (const [name, value] of Object.entries(kit)) {
      expect(value, `${name} must be a component or hook`).toBeTruthy();
      expect(['function', 'object']).toContain(typeof value); // forwardRef exotic components are objects
    }
  });
});
