/**
 * gridRange.js — pure, dependency-free helpers for Excel-style cell ranges and clipboard text on the attendance grids.
 *
 * AG Grid Community has no range selection or clipboard module (those are Enterprise features), so the monthly
 * attendance grid keeps its own selection model and these functions do all the decisions. Nothing here touches the
 * DOM, React or the network: the page wires events to them, and they are unit-tested directly.
 *
 * Rules that matter for safety:
 *  - a paste only ever produces operations for cells inside the pasted rectangle — never a neighbouring cell or date;
 *  - every value is validated BEFORE anything is saved (the caller refuses the whole paste when any cell is invalid);
 *  - blank pasted cells are skipped, never written as "clear";
 *  - values equal to what the cell already holds are skipped (no needless write, lock or audit row);
 *  - only the columns listed in PASTE_FIELDS are writable; any other target column is reported and skipped.
 */
import { parseTimeInput } from './timeInput.js';

/** Fields a paste may write, and how each value is read. */
export const PASTE_FIELDS = { checkIn: 'time', checkOut: 'time', status: 'status' };

export const STATUS_CODES = ['present', 'late', 'absent', 'early_leave', 'weekend', 'holiday'];
const STATUS_AR = {
  present: 'حاضر', late: 'متأخر', absent: 'غائب', early_leave: 'انصراف مبكر', weekend: 'إجازة أسبوعية', holiday: 'عطلة رسمية',
};
const STATUS_ALIASES = {
  present: ['present', 'حاضر', 'حضور'],
  late: ['late', 'متأخر', 'تأخير'],
  absent: ['absent', 'غائب', 'غياب'],
  early_leave: ['early_leave', 'early leave', 'earlyleave', 'انصراف مبكر'],
  weekend: ['weekend', 'إجازة أسبوعية', 'اجازة اسبوعية', 'اجازة أسبوعية'],
  holiday: ['holiday', 'عطلة رسمية', 'عطلة'],
};

/** "حاضر" / "present" → "present"; unknown text → null. */
export function statusFromText(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!t) return null;
  for (const [code, names] of Object.entries(STATUS_ALIASES)) if (names.some((n) => n.toLowerCase() === t)) return code;
  return null;
}
export const statusLabel = (code) => STATUS_AR[code] || String(code ?? '');

// ───────────────────────── clipboard text (TSV, Excel-compatible) ─────────────────────────

/** Excel/Sheets/this grid's text → matrix of strings. Quoted cells (embedded tabs/newlines/"") are honoured; one trailing newline is dropped. */
export function parseClipboard(text) {
  const src = String(text ?? '').replace(/\r\n?/g, '\n');
  if (src === '') return [];
  const rows = []; let row = []; let cell = ''; let inQ = false; let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQ) {
      if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else inQ = false; } else cell += ch;
    } else if (ch === '"' && cell === '') { inQ = true; quoted = true; }
    else if (ch === '\t') { row.push(cell); cell = ''; quoted = false; }
    else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; quoted = false; }
    else cell += ch;
  }
  if (cell !== '' || row.length || quoted) { row.push(cell); rows.push(row); }
  return rows;
}

/** matrix → text for the clipboard (cells with tab/newline/quote are quoted). */
export function toClipboardText(matrix) {
  const esc = (v) => { const s = String(v ?? ''); return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return (matrix || []).map((r) => r.map(esc).join('\t')).join('\n');
}

// ───────────────────────── ranges ─────────────────────────

/** {anchor:{r,c}, focus:{r,c}} → normalized rectangle {r1,r2,c1,c2} (inclusive), or null. */
export function rectOf(sel) {
  if (!sel || !sel.anchor || !sel.focus) return null;
  return {
    r1: Math.min(sel.anchor.r, sel.focus.r), r2: Math.max(sel.anchor.r, sel.focus.r),
    c1: Math.min(sel.anchor.c, sel.focus.c), c2: Math.max(sel.anchor.c, sel.focus.c),
  };
}
export const rectRows = (rc) => (rc ? rc.r2 - rc.r1 + 1 : 0);
export const rectCols = (rc) => (rc ? rc.c2 - rc.c1 + 1 : 0);
export const rectCount = (rc) => rectRows(rc) * rectCols(rc);
export const inRect = (rc, r, c) => !!rc && r >= rc.r1 && r <= rc.r2 && c >= rc.c1 && c <= rc.c2;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * Arrow-key movement of a cell position. `rtl` flips left/right (AG Grid's RTL layout keeps column 0 on the right,
 * so ArrowLeft goes to the NEXT column index there).
 */
export function moveCell(pos, key, { rowCount, colCount, rtl = false }) {
  let { r, c } = pos;
  if (key === 'ArrowUp') r -= 1;
  else if (key === 'ArrowDown') r += 1;
  else if (key === 'ArrowLeft') c += rtl ? 1 : -1;
  else if (key === 'ArrowRight') c += rtl ? -1 : 1;
  return { r: clamp(r, 0, Math.max(0, rowCount - 1)), c: clamp(c, 0, Math.max(0, colCount - 1)) };
}

// ───────────────────────── copy ─────────────────────────

/** Display text of one cell for the clipboard. Times stay "HH:mm"; status is the Arabic label (the paste accepts both). */
export function cellCopyText(row, field) {
  if (!row) return '';
  const v = row[field];
  if (field === 'status') return v ? statusLabel(v) : '';
  if (v == null || v === '') return '';
  return String(v);
}

/** matrix of strings for the rectangle (rows = displayed row data in order; cols = [{field}] in order). */
export function buildCopyMatrix(rc, rows, cols) {
  if (!rc) return [];
  const out = [];
  for (let r = rc.r1; r <= rc.r2; r++) {
    const line = [];
    for (let c = rc.c1; c <= rc.c2; c++) line.push(cellCopyText(rows[r], cols[c] && cols[c].field));
    out.push(line);
  }
  return out;
}

// ───────────────────────── paste planning ─────────────────────────

/**
 * Turn clipboard text + the target selection into a list of validated cell operations. Pure: it saves nothing.
 *
 * @param {object} p
 * @param {string[][]} p.matrix            parsed clipboard
 * @param {{r1,r2,c1,c2}} p.rect           target rectangle (a single focused cell is a 1×1 rectangle)
 * @param {object[]} p.rows                displayed row data, in display order
 * @param {{field:string}[]} p.cols        displayed columns, in display order
 * @param {(row:object, field:string)=>string|null} [p.lockReason]  returns a reason when this cell must not be written
 * @returns {{ops:object[], errors:object[], skipped:object[], unchanged:number, clipped:number, mode:'fill'|'tile'|'once', targets:number}}
 */
export function planPaste({ matrix, rect, rows, cols, lockReason }) {
  const plan = { ops: [], errors: [], skipped: [], unchanged: 0, clipped: 0, mode: 'once', targets: 0 };
  if (!rect || !Array.isArray(matrix) || matrix.length === 0) return plan;
  const R = matrix.length;
  const C = Math.max(...matrix.map((r) => r.length), 1);

  // which clipboard cell lands on which grid cell
  const targets = [];
  if (R === 1 && C === 1 && rectCount(rect) > 1) {
    plan.mode = 'fill';                                           // one value → every selected cell
    for (let r = rect.r1; r <= rect.r2; r++) for (let c = rect.c1; c <= rect.c2; c++) targets.push({ r, c, i: 0, j: 0 });
  } else if (rectRows(rect) % R === 0 && rectCols(rect) % C === 0 && rectCount(rect) > R * C) {
    plan.mode = 'tile';                                           // selection is an exact multiple → repeat the block
    for (let r = rect.r1; r <= rect.r2; r++) for (let c = rect.c1; c <= rect.c2; c++) targets.push({ r, c, i: (r - rect.r1) % R, j: (c - rect.c1) % C });
  } else {
    for (let i = 0; i < R; i++) for (let j = 0; j < C; j++) targets.push({ r: rect.r1 + i, c: rect.c1 + j, i, j });   // once, from the top-left cell
  }
  plan.targets = targets.length;

  for (const t of targets) {
    if (t.r >= rows.length || t.c >= cols.length) { plan.clipped++; continue; }       // outside the grid: never wrapped onto other cells
    const row = rows[t.r]; const col = cols[t.c]; const field = col && col.field;
    const text = (matrix[t.i] && matrix[t.i][t.j]) ?? '';
    const where = { rowIndex: t.r, colIndex: t.c, rowId: row && row.id, employeeName: row && row.employeeName, date: row && row.date, field, text: String(text) };
    if (String(text).trim() === '') { plan.skipped.push({ ...where, reason: 'خلية فارغة — لم تُكتب' }); continue; }
    const kind = PASTE_FIELDS[field];
    if (!kind) { plan.skipped.push({ ...where, reason: 'العمود غير قابل للصق' }); continue; }
    const locked = lockReason ? lockReason(row, field) : null;
    if (locked) { plan.skipped.push({ ...where, reason: locked }); continue; }

    let value;
    if (kind === 'time') {
      const p = parseTimeInput(text);
      if (!p.ok) { plan.errors.push({ ...where, reason: p.reason }); continue; }
      value = p.value;
    } else {
      value = statusFromText(text);
      if (!value) { plan.errors.push({ ...where, reason: 'حالة غير معروفة' }); continue; }
    }
    if ((row[field] ?? '') === value) { plan.unchanged++; continue; }                  // already holds this value
    plan.ops.push({ ...where, value, employeeId: row.employeeId });
  }
  return plan;
}

/** A plan may be saved only when nothing in it is invalid and there is at least one change. */
export const isPlanSavable = (plan) => !!plan && plan.errors.length === 0 && plan.ops.length > 0;
