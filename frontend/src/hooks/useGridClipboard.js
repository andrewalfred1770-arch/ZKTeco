/**
 * useGridClipboard — Excel-style cell range selection, copy and paste for an AG Grid COMMUNITY grid.
 *
 * AG Grid Community has no range selection / clipboard (Enterprise only), so this hook keeps its own selection model
 * (see lib/gridRange.js for the pure logic) and wires it to the grid:
 *   - click / drag / Shift+click / Shift+Arrow / Ctrl+A select a rectangle of cells (highlighted via cellClassRules);
 *   - Ctrl/Cmd+C copies the selection (or the focused cell) as tab-separated text — pastes into Excel and back;
 *   - Ctrl/Cmd+V plans the paste (lib/gridRange.js planPaste) and hands the validated plan to `onPaste`;
 *   - Escape clears the copied-range outline.
 * While a cell EDITOR (an <input>) has focus every one of these is ignored so the browser's native text selection,
 * copy and paste keep working inside the editor.
 *
 * The hook never writes data. Saving is the caller's job (`onPaste` receives the plan); cell states
 * (saving / saved / adjusted / failed / invalid) are reported back through `setCellState` and shown as cell classes.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import toast from 'react-hot-toast';
import {
  parseClipboard, toClipboardText, rectOf, rectCount, rectRows, rectCols, inRect, moveCell, buildCopyMatrix, planPaste, PASTE_FIELDS,
} from '../lib/gridRange';

const EDITING_SELECTOR = 'input, textarea, select, [contenteditable="true"], .ag-cell-inline-editing';
const isEditingTarget = (t) => !!(t && t.closest && t.closest(EDITING_SELECTOR));

export function useGridClipboard({ gridRef, rtl = true, lockReason, onPaste }) {
  const selRef = useRef(null);            // { anchor:{r,c}, focus:{r,c} }
  const copiedRef = useRef(null);         // normalized rectangle of the last copy
  const statesRef = useRef(new Map());    // `${rowId}:${field}` -> { state, op, error }
  const colMapRef = useRef(new Map());    // colId -> displayed column index
  const draggingRef = useRef(false);
  const ignoreFocusUntilRef = useRef(0);
  const onPasteRef = useRef(onPaste); onPasteRef.current = onPaste;
  const lockRef = useRef(lockReason); lockRef.current = lockReason;
  const [, setVersion] = useState(0);
  const bump = useCallback(() => setVersion((v) => v + 1), []);

  const api = () => { const a = gridRef.current && gridRef.current.api; return a && !(a.isDestroyed && a.isDestroyed()) ? a : null; };

  const refreshColMap = useCallback(() => {
    const a = api(); if (!a) return;
    const m = new Map(); a.getAllDisplayedColumns().forEach((col, i) => m.set(col.getColId(), i));
    colMapRef.current = m;
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const getRows = () => { const a = api(); const out = []; if (a) a.forEachNodeAfterFilterAndSort((n) => { if (n.data) out.push(n.data); }); return out; };
  const getCols = () => { const a = api(); return a ? a.getAllDisplayedColumns().map((c) => ({ colId: c.getColId(), field: c.getColDef().field, checkbox: !!c.getColDef().checkboxSelection })) : []; };

  /** repaint the cells whose selection/copy/state classes may have changed (only rendered cells are touched) */
  const repaint = useCallback((rectA, rectB) => {
    const a = api(); if (!a) return;
    const lo = Math.min(...[rectA, rectB].filter(Boolean).map((r) => r.r1), Infinity);
    const hi = Math.max(...[rectA, rectB].filter(Boolean).map((r) => r.r2), -1);
    if (hi < 0) return;
    if (hi - lo > 400) { a.refreshCells({ force: false, suppressFlash: true }); return; }
    const nodes = [];
    for (let i = lo; i <= hi; i++) { const n = a.getDisplayedRowAtIndex(i); if (n) nodes.push(n); }
    if (nodes.length) a.refreshCells({ rowNodes: nodes, force: false, suppressFlash: true });
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const setSelection = useCallback((next) => {
    const before = rectOf(selRef.current);
    selRef.current = next;
    repaint(before, rectOf(next));
    bump();
  }, [repaint, bump]);

  const currentRect = () => {
    const sel = rectOf(selRef.current);
    if (sel) return sel;
    const a = api(); const fc = a && a.getFocusedCell && a.getFocusedCell();
    if (!fc) return null;
    const c = colMapRef.current.get(fc.column.getColId());
    return c == null ? null : { r1: fc.rowIndex, r2: fc.rowIndex, c1: c, c2: c };
  };

  // ── per-cell save states ────────────────────────────────────────────────────
  const setCellState = useCallback((rowId, field, state, info = {}) => {
    const key = `${rowId}:${field}`;
    if (state == null) statesRef.current.delete(key); else statesRef.current.set(key, { state, ...info });
    const a = api();
    const node = a && a.getRowNode(String(rowId));
    if (node) a.refreshCells({ rowNodes: [node], force: false, suppressFlash: true });
    bump();
  }, [bump]);
  const clearCellStates = useCallback((keep) => {
    const before = statesRef.current.size;
    for (const [k, v] of [...statesRef.current.entries()]) if (!keep || !keep(k, v)) statesRef.current.delete(k);
    if (before) { const a = api(); if (a) a.refreshCells({ force: false, suppressFlash: true }); bump(); }
  }, [bump]);
  const stateSummary = () => {
    const s = { saving: 0, saved: 0, adjusted: 0, failed: 0, invalid: 0 }; const failed = [];
    for (const v of statesRef.current.values()) { if (s[v.state] != null) s[v.state]++; if (v.state === 'failed') failed.push(v); }
    return { ...s, failedItems: failed };
  };

  // ── grid event handlers ─────────────────────────────────────────────────────
  const cellPos = (e) => {
    if (!e || !e.column || e.rowIndex == null) return null;
    const c = colMapRef.current.get(e.column.getColId());
    return c == null ? null : { r: e.rowIndex, c };
  };

  const onCellMouseDown = useCallback((e) => {
    const ev = e.event; if (!ev || ev.button !== 0) return;
    if (e.column && e.column.getColDef().checkboxSelection) return;           // the row-checkbox column keeps its own behaviour
    const a = api(); if (a && a.getEditingCells().length) return;             // never fight an open editor
    refreshColMap();
    const p = cellPos({ column: e.column, rowIndex: e.rowIndex }); if (!p) return;
    ignoreFocusUntilRef.current = Date.now() + 80;
    draggingRef.current = true;
    if (ev.shiftKey && selRef.current) setSelection({ anchor: selRef.current.anchor, focus: p });
    else setSelection({ anchor: p, focus: p });
  }, [refreshColMap, setSelection]);

  const onCellMouseOver = useCallback((e) => {
    if (!draggingRef.current || !e.event || !(e.event.buttons & 1) || !selRef.current) return;
    const p = cellPos({ column: e.column, rowIndex: e.rowIndex }); if (!p) return;
    const f = selRef.current.focus;
    if (f.r === p.r && f.c === p.c) return;
    setSelection({ anchor: selRef.current.anchor, focus: p });
  }, [setSelection]);

  const onCellFocused = useCallback((e) => {
    if (Date.now() < ignoreFocusUntilRef.current || draggingRef.current) return;
    if (e.rowIndex == null || !e.column) return;
    const col = typeof e.column === 'string' ? null : e.column;
    if (!col) return;
    refreshColMap();
    const p = cellPos({ column: col, rowIndex: e.rowIndex }); if (!p) return;
    const cur = selRef.current;
    if (cur && cur.focus.r === p.r && cur.focus.c === p.c && cur.anchor.r === p.r && cur.anchor.c === p.c) return;
    setSelection({ anchor: p, focus: p });
  }, [refreshColMap, setSelection]);

  useEffect(() => {
    const up = () => { draggingRef.current = false; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);

  const onKeyDownCapture = useCallback((e) => {
    if (isEditingTarget(e.target)) return;                                    // native keys inside an editor
    const a = api(); if (!a) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'a' || e.key === 'A')) {
      const rows = a.getDisplayedRowCount(); const cols = getCols();
      const first = cols.findIndex((c) => !c.checkbox);
      if (rows > 0 && first >= 0) { refreshColMap(); e.preventDefault(); e.stopPropagation(); setSelection({ anchor: { r: 0, c: first }, focus: { r: rows - 1, c: cols.length - 1 } }); }
      return;
    }
    if (e.key === 'Escape') {
      if (copiedRef.current) { const prev = copiedRef.current; copiedRef.current = null; repaint(prev, null); bump(); }
      return;
    }
    if (e.shiftKey && !mod && e.key.startsWith('Arrow')) {
      refreshColMap();
      let sel = selRef.current;
      if (!sel) { const rc = currentRect(); if (!rc) return; sel = { anchor: { r: rc.r1, c: rc.c1 }, focus: { r: rc.r1, c: rc.c1 } }; }
      const next = moveCell(sel.focus, e.key, { rowCount: a.getDisplayedRowCount(), colCount: getCols().length, rtl });
      e.preventDefault(); e.stopPropagation();
      setSelection({ anchor: sel.anchor, focus: next });
      a.ensureIndexVisible(next.r);
      const col = a.getAllDisplayedColumns()[next.c]; if (col) a.ensureColumnVisible(col);
    }
  }, [refreshColMap, setSelection, repaint, bump, rtl]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onCopy = useCallback((e) => {
    if (isEditingTarget(e.target)) return;
    refreshColMap();
    const rc = currentRect(); if (!rc) return;
    const rows = getRows(); const cols = getCols();
    const matrix = buildCopyMatrix(rc, rows, cols);
    if (!matrix.length) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', toClipboardText(matrix));
    const prev = copiedRef.current; copiedRef.current = rc; repaint(prev, rc); bump();
    toast.success(`تم نسخ ${rectCount(rc)} خلية (${rectRows(rc)}×${rectCols(rc)})`, { duration: 1800 });
  }, [refreshColMap, repaint, bump]);   // eslint-disable-line react-hooks/exhaustive-deps

  const onPasteEvt = useCallback(async (e) => {
    if (isEditingTarget(e.target)) return;
    const text = (e.clipboardData && e.clipboardData.getData('text/plain')) || '';
    e.preventDefault();
    const matrix = parseClipboard(text);
    if (!matrix.length) { toast.error('الحافظة فارغة'); return; }
    refreshColMap();
    const rect = currentRect();
    if (!rect) { toast.error('حدّد خلية أو نطاقاً قبل اللصق'); return; }
    const rows = getRows(); const cols = getCols();
    const plan = planPaste({ matrix, rect, rows, cols, lockReason: (row, field) => (lockRef.current ? lockRef.current(row, field) : null) });
    if (onPasteRef.current) await onPasteRef.current(plan, { rect, rows, cols, matrix });
  }, [refreshColMap]);   // eslint-disable-line react-hooks/exhaustive-deps

  /** Reset everything tied to the displayed rows (call when the data set / filter / sort changes underneath). */
  const resetSelection = useCallback(() => { selRef.current = null; copiedRef.current = null; const a = api(); if (a) a.refreshCells({ force: false, suppressFlash: true }); bump(); }, [bump]);   // eslint-disable-line react-hooks/exhaustive-deps

  const cellClassRules = useMemo(() => {
    const idx = (p) => (p.column ? colMapRef.current.get(p.column.getColId()) : undefined);
    const stateIs = (name) => (p) => { const v = p.data && p.colDef && p.colDef.field ? statesRef.current.get(`${p.data.id}:${p.colDef.field}`) : null; return !!v && v.state === name; };
    return {
      'cell-range': (p) => { const rc = rectOf(selRef.current); return !!rc && rectCount(rc) > 1 && inRect(rc, p.node.rowIndex, idx(p)); },
      'cell-range-anchor': (p) => { const s = selRef.current; return !!s && s.anchor.r === p.node.rowIndex && s.anchor.c === idx(p) && rectCount(rectOf(s)) > 1; },
      'cell-copied': (p) => inRect(copiedRef.current, p.node.rowIndex, idx(p)),
      'cell-paste-saving': stateIs('saving'),
      'cell-paste-saved': stateIs('saved'),
      'cell-paste-adjusted': stateIs('adjusted'),
      'cell-paste-failed': stateIs('failed'),
      'cell-paste-invalid': stateIs('invalid'),
    };
  }, []);

  return {
    wrapperProps: { onKeyDownCapture, onCopy, onPaste: onPasteEvt },
    gridProps: { onCellMouseDown, onCellMouseOver, onCellFocused, onDisplayedColumnsChanged: refreshColMap, onGridReady: refreshColMap },
    cellClassRules,
    selectionCount: rectCount(rectOf(selRef.current)),
    selectionRect: rectOf(selRef.current),
    copiedCount: rectCount(copiedRef.current),
    stateSummary, setCellState, clearCellStates, resetSelection, refreshColMap,
    PASTE_FIELDS,
  };
}
