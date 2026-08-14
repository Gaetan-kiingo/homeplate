// src/lib/sanitize.js — shared output/input sanitizer (U1-VALID, build-plan wave 1).
//
// Traceability: NFR-11 (validate and sanitize all user inputs against XSS/injection),
// AB-06 (injection via search fields, listing text, chat, reviews), ST-04 payload corpus,
// ADR-006 (validation and sanitization live at the API boundary, one shared layer).
//
// Contract (build-plan "Public interfaces"): `sanitize.text/html/identifier`.
//
// Design:
//  - `text(s)`    HTML-escapes a string for safe embedding in any HTML context. The input is
//                 preserved character-for-character (minus control characters); `&<>"'` and
//                 backtick become entities, so no markup can form. This is the default for
//                 user-authored plain text (listing descriptions, chat, reviews, profiles).
//  - `html(s)`    strips ALL markup (dangerous elements including their content, comments,
//                 then every remaining tag) and HTML-escapes what is left. Homeplate v1.0 has
//                 no rich-text feature (SRS 1.2), so the safe allowlist is the empty set:
//                 pasted HTML degrades to clean inert text.
//  - `identifier(s)` reduces a string to a conservative machine-identifier alphabet
//                 [A-Za-z0-9_.-], collapsing dot runs and trimming leading/trailing
//                 separators, so it can never carry markup, SQL metacharacters, path
//                 traversal ("..") or option-injection ("-x") into logs, keys or filenames.
//
// The hard guarantee, asserted by tests/unit/validation.test.js over the ST-04 corpus:
// no output of text()/html() ever contains a raw "<" or ">", therefore no executable
// markup survives a round-trip through this module. Stripping in html() is defense in
// depth; the final escape is the invariant. SQL injection is NOT defended here -- the
// defense is parameterized SQL everywhere (NFR-11); SQLi strings pass through as inert data.
'use strict';

// C0 control characters and DEL, except \t (u0009), \n (u000A), \r (u000D) which are
// legitimate in user text. Written as escapes so the source file stays plain text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#x27;',
  '`': '&#x60;',
};
const HTML_ESCAPE_RE = /[&<>"'`]/g;

// Elements whose CONTENT must be removed along with the tags (script bodies, style sheets,
// nested browsing contexts, SVG/MathML script vectors, form hijacking).
const DANGEROUS_BLOCK_RE =
  /<(script|style|iframe|object|embed|noscript|template|svg|math|form)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;

// HTML comments (including conditional comments); an unterminated comment swallows to the end.
const COMMENT_RE = /<!--[\s\S]*?(?:-->|$)/g;

// Any remaining tag-shaped token: <tag ...>, </tag>, <!doctype ...>, <?xml ...>.
// An unterminated tag at end-of-string is stripped too.
const TAG_RE = /<\/?[a-zA-Z!?][^>]*(?:>|$)/g;

function assertString(value, fn) {
  if (typeof value !== 'string') {
    throw new TypeError(`sanitize.${fn}: expected a string, got ${typeof value}`);
  }
}

function stripControlChars(value) {
  return value.replace(CONTROL_CHARS_RE, '');
}

/** Escape the HTML-significant characters so the string is inert in element and attribute
 *  contexts. Exported for reuse by serializers (NFR-11). */
function escapeHtml(value) {
  assertString(value, 'escapeHtml');
  return value.replace(HTML_ESCAPE_RE, (c) => HTML_ESCAPES[c]);
}

/** Plain-text sanitizer: control characters removed, HTML metacharacters escaped.
 *  Output never contains a raw "<" or ">" (NFR-11, AB-06). */
function text(value) {
  assertString(value, 'text');
  return escapeHtml(stripControlChars(value));
}

/** Markup-stripping sanitizer: removes dangerous elements WITH their content, comments and
 *  every remaining tag (iterated to a fixpoint so split-tag evasions like
 *  `<scr<script>ipt>` cannot reassemble), then escapes whatever text is left.
 *  Output never contains a raw "<" or ">" (NFR-11, AB-06, ST-04). */
function html(value) {
  assertString(value, 'html');
  let out = stripControlChars(value);
  let previous;
  do {
    previous = out;
    out = out.replace(DANGEROUS_BLOCK_RE, '');
    out = out.replace(COMMENT_RE, '');
    out = out.replace(TAG_RE, '');
  } while (out !== previous); // every replacement shortens the string, so this terminates
  return escapeHtml(out);
}

/** Identifier sanitizer for machine-facing strings (storage keys, slugs, log fields):
 *  keeps only [A-Za-z0-9_.-], collapses dot runs (no ".." traversal), trims leading/
 *  trailing dots and dashes (no hidden files, no option-injection), caps at 128 chars.
 *  Unicode is NFKC-folded first so full-width lookalikes cannot smuggle characters. */
function identifier(value) {
  assertString(value, 'identifier');
  return stripControlChars(value)
    .normalize('NFKC')
    .replace(/[^A-Za-z0-9_.-]+/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/^[.-]+/, '')
    .replace(/[.-]+$/, '')
    .slice(0, 128);
}

module.exports = { text, html, identifier, escapeHtml };
