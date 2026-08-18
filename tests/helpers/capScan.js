// tests/helpers/capScan.js — the ADR-009 "caps are configuration" static scan, in one place.
//
// ADR-009 requires every MEHKO cap to live in src/config and never inline in a service, so the
// verification lanes grep module sources for the cap VALUES. That scan used to be a bare
// `/\b60\b/`, which worked only because 60 happened to be distinctive.
//
// It stopped being safe on 2026-08-18, when AB 1325 moved the weekly cap from 60 to 90: 90 is
// also the maximum latitude, so `src/schemas/common.js` and `src/lib/geoPrecision.js` legitimately
// contain it. A scan that cannot tell a meal cap from a coordinate bound reports offenders that
// are not offences, and the usual reaction — loosening the assertion — would quietly retire the
// invariant instead.
//
// So the scan is narrowed rather than weakened:
//   - comments are stripped, because a comment explaining the cap is documentation, not an
//     inline cap (a hardcoded cap in *code* is what ADR-009 forbids);
//   - lines in a geographic context are skipped, because ±90 there is a latitude bound;
//   - the value 1 is never scanned: `listingsPerHostPerDay` is 1, which appears everywhere.
'use strict';

const fs = require('fs');

/** Lines where a cap-shaped number is legitimately something else. */
const NON_CAP_CONTEXT = /lat\b|lng\b|latitude|longitude|coarsen|coordinate|geo/i;

/** Remove block and line comments without eating the `//` in a URL. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/**
 * @param {string} source      file contents
 * @param {number[]} capValues e.g. Object.values(config.mehko).filter(Number.isFinite)
 * @returns {{line: number, text: string}[]} offending lines — a hardcoded cap in real code
 */
function capLiteralHits(source, capValues) {
  const caps = [...new Set(capValues.filter((v) => Number.isFinite(v) && v > 1))];
  if (!caps.length) return [];
  const pattern = new RegExp(`\\b(${caps.join('|')})\\b`);
  return stripComments(source)
    .split('\n')
    .map((text, i) => ({ line: i + 1, text }))
    .filter(({ text }) => pattern.test(text) && !NON_CAP_CONTEXT.test(text));
}

/** Convenience: true when the file hardcodes any of the caps in real code. */
function fileHardcodesCap(file, capValues) {
  return capLiteralHits(fs.readFileSync(file, 'utf8'), capValues).length > 0;
}

module.exports = { capLiteralHits, fileHardcodesCap, stripComments };
