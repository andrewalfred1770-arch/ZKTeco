/**
 * searchText — the ONE definition of "matches the search box" for names,
 * codes, departments, positions and rule text, so Arabic and English input
 * behave the same everywhere.
 *
 * Search text is NORMALIZED for comparison only — stored values are never
 * changed, and what the user sees is always the original text.
 *
 * normalizeSearch() folds:
 *   - case (Latin) and Latin accents ("José" = "jose");
 *   - Arabic diacritics (tashkeel, superscript alef) and tatweel ("مُحَمَّد" = "محمد");
 *   - alef variants أ إ آ ٱ → ا, alef maqsura ى → ي, ta marbuta ة → ه,
 *     hamza carriers ؤ → و and ئ → ي, Persian ی → ي and ک → ك;
 *   - Arabic-Indic (٠-٩) and Persian (۰-۹) digits → 0-9;
 *   - compatibility/presentation forms (NFKD), zero-width and bidi control
 *     characters (removed), and any run of whitespace incl. NBSP (→ one space).
 *
 * Matching: every whitespace-separated word of the query must appear
 * (substring, as before) somewhere in the row's combined searchable text.
 * A query that was a contiguous substring before still matches; word order no
 * longer matters ("ali ahmed" finds "Ahmed Ali").
 */

const MARKS = /[\u0300-\u036F\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g; // Latin accents, tashkeel, quranic marks, tatweel
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF\u00AD]/g; // zero-width, bidi controls, BOM, soft hyphen
const WHITESPACE = /[\s\u00A0]+/g;
const LETTERS = {
  '\u0623': '\u0627', '\u0625': '\u0627', '\u0622': '\u0627', '\u0671': '\u0627', // alef with hamza above/below, madda, wasla -> alef
  '\u0649': '\u064A', '\u06CC': '\u064A', '\u0626': '\u064A',                     // alef maqsura, Persian yeh, hamza-on-yeh -> yeh
  '\u0624': '\u0648',                                                             // hamza-on-waw -> waw
  '\u0629': '\u0647',                                                             // ta marbuta -> heh
  '\u06A9': '\u0643',                                                             // Persian keheh -> kaf
};
const LETTER_RE = /[\u0623\u0625\u0622\u0671\u0649\u06CC\u0626\u0624\u0629\u06A9]/g;
const DIGIT_RE = /[\u0660-\u0669\u06F0-\u06F9]/g;

export function normalizeSearch(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    .normalize('NFKD')
    .replace(INVISIBLE, '')
    .replace(MARKS, '')
    .replace(LETTER_RE, (c) => LETTERS[c])
    .replace(DIGIT_RE, (d) => { const c = d.charCodeAt(0); return String(c >= 0x06F0 ? c - 0x06F0 : c - 0x0660); })
    .toLowerCase()
    .replace(WHITESPACE, ' ')
    .trim();
}

// Tokenizing the same query once per keystroke, not once per row.
let lastQuery = null; let lastTokens = [];
/** Normalized words of a query ([] when blank). Memoized on the last query. */
export function searchTokens(query) {
  if (query === lastQuery) return lastTokens;
  const n = normalizeSearch(query);
  lastQuery = query; lastTokens = n ? n.split(' ') : [];
  return lastTokens;
}

/** True when every query word occurs in the (already normalized) haystack. */
export function matchesTokens(tokens, haystack) {
  for (let i = 0; i < tokens.length; i++) if (!haystack.includes(tokens[i])) return false;
  return true;
}

// Normalized haystack per row object, re-derived only when a searched field changes.
const rowCache = new WeakMap();
/** Normalized combined text of `fields` for `row` (cached per row object). */
export function rowHaystack(row, fields) {
  const sig = fields.join('\u0001');
  const hit = rowCache.get(row);
  if (hit && hit.sig === sig) return hit.text;
  const text = normalizeSearch(fields.filter((f) => f !== null && f !== undefined && f !== '').join(' '));
  rowCache.set(row, { sig, text });
  return text;
}

/** One-shot convenience: does `query` match the given field values? ('' matches all.) */
export function matchesSearch(query, ...fields) {
  const tokens = searchTokens(query);
  return tokens.length === 0 || matchesTokens(tokens, normalizeSearch(fields.filter((f) => f != null && f !== '').join(' ')));
}
