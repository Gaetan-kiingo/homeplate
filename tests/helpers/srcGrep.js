// tests/helpers/srcGrep.js — "prove the code path does NOT exist" scans, in one place.
//
// Several st-security assertions pin an ABSENCE (nothing SETs users.deleted_at, nothing
// approves a pending listing) so a wave-4 feature landing half-built cannot pass silently.
// The subtlety: grep exits 1 on "no match", which execFileSync reports as an error — but for
// these scans an empty result is the EXPECTED, passing outcome, so exit 1 must map to ''
// while real failures (bad pattern, unreadable dir: exit 2) still throw.
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');

/** grep -rnE over a directory; returns '' when there is no match (grep exits 1). */
function grepSrc(pattern, dir = path.join(ROOT, 'src')) {
  try {
    return execFileSync('grep', ['-rnE', pattern, dir], { encoding: 'utf8' }).trim();
  } catch (err) {
    if (err.status === 1) return '';
    throw err;
  }
}

module.exports = { grepSrc };
