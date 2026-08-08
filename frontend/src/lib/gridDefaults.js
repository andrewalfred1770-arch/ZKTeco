/**
 * Enterprise Grid Lock — global AG-Grid configuration.
 *
 * Every grid in the system shares this baseline so column layout is
 * 100% deterministic across users/sessions: no drag-reorder, no
 * resize, no pinned/position drift. Only sorting, filtering,
 * scrolling and selection remain interactive.
 *
 * Usage:
 *   import { ENTERPRISE_DEFAULT_COL_DEF, ENTERPRISE_GRID_PROPS } from '../lib/gridDefaults';
 *   const defaultColDef = useMemo(() => ({ ...ENTERPRISE_DEFAULT_COL_DEF, ...overrides }), []);
 *   <AgGridReact {...ENTERPRISE_GRID_PROPS} ... />
 */
export const ENTERPRISE_DEFAULT_COL_DEF = {
  sortable: true,
  filter: true,
  resizable: false,
  suppressMovable: true,
  lockPosition: true,
  lockPinned: true,
  suppressHeaderMenuButton: false,
  suppressSizeToFit: false,
};

export const ENTERPRISE_GRID_PROPS = {
  // ── Canonical resize response (EP-025 cross-platform grid fit) ────────────
  // The whole grid system is opted INTO sizeColumnsToFit — every column carries
  // suppressSizeToFit:false (see ENTERPRISE_DEFAULT_COL_DEF) and the width tiers
  // are authored as fit RATIOS, not final pixels — but the fit was never
  // actually invoked: no page wired onGridSizeChanged and nothing ever calls
  // api.sizeColumnsToFit(). So columns render at their raw fixed widths and any
  // slack between their sum and the container is left as dead horizontal space.
  //
  // This was invisible on Windows (the maximized content width happens to sit
  // near the column sum) but glaring on macOS, whose maximized content area is
  // wider — hence the "large unused horizontal space" symptom. The cause is
  // platform-independent (a missing recalculation), so the fix is too: react to
  // AG Grid's own gridSizeChanged — the canonical signal fired by its internal
  // ResizeObserver on EVERY container change (window resize, maximize, restore,
  // sidebar collapse/expand, resolution change) AND on the initial layout — and
  // refit the columns to the current width. sizeColumnsToFit only redistributes
  // within each column's existing minWidth/maxWidth, so fixed widths, tiers and
  // pinning are all preserved; nothing here is column-definition or OS specific.
  //
  // Guarded on a real width: a grid that fires this while zero-width (mounted
  // on a not-yet-visible route, mid-transition) would otherwise trip AG Grid's
  // "zero width" warning — the later real-size event does the actual fit.
  onGridSizeChanged: (params) => {
    if (params.clientWidth > 0) params.api.sizeColumnsToFit();
  },
  // Native OS tooltip for any column with tooltipValueGetter/tooltipField
  // (e.g. the manual-override explanation) — no effect on columns without
  // one. This is a grid-level option, not a ColDef property, so it belongs
  // here (spread directly onto <AgGridReact>) rather than in
  // ENTERPRISE_DEFAULT_COL_DEF (spread into the `defaultColDef` prop).
  enableBrowserTooltips: true,
  suppressMovableColumns: true,
  suppressDragLeaveHidesColumns: true,
  suppressMakeColumnVisibleAfterUnGroup: true,
  ensureDomOrder: true,
  maintainColumnOrder: true,
  // Every grid registers custom React components (cellRenderer/cellEditor,
  // e.g. TimeCellEditor, the employeeName monitored-badge renderer). Without
  // this flag AG Grid falls back to its legacy (non-reactive) component
  // lifecycle, which can destroy and recreate a row's rendered cells — instead
  // of updating props in place — whenever any cell in that row is refreshed
  // (refreshCells, a rowData update via getRowId, etc). That is the actual
  // mechanism behind rows/cells transiently going blank during inline editing:
  // the row's DOM is torn down and rebuilt, not merely re-rendered. Confirmed
  // via AG Grid's own console warning ("Using custom components without
  // reactiveCustomComponents = true is deprecated") and DOM-level tracing that
  // showed the edited row's node disappearing from the document during a save.
  reactiveCustomComponents: true,
  // Every inline cell save replaces the page's `rowData` array with a new
  // top-level array (one row object swapped in) so React state stays the
  // source of truth. AG Grid's ImmutableService diffs that array against its
  // internal nodes (matched via getRowId) and — by default — always re-runs
  // the FULL group/filter/sort/map pipeline afterward (refreshModel), even
  // though a single-cell edit only ever produces an update-only transaction
  // (no rows added/removed). That full pipeline dispatches a model-updated
  // redraw that repositions/recycles row DOM elements, which can transiently
  // detach the actively-edited row from the document and fire a native
  // focusout — closing the cell editor mid-save even though the user never
  // left the grid (see stopEditingWhenCellsLoseFocus on each page). Row
  // *values* are unaffected either way: node data is applied by
  // nodeManager.updateRowData() before this pipeline runs, independent of it.
  // This flag (an AG Grid built-in, not a workaround) makes refreshModel
  // return immediately when a transaction contains only updates, skipping
  // that redraw entirely for ordinary edits. Transactions with real adds/
  // removes (e.g. a full page reload swapping the dataset) are unaffected —
  // sorting/filtering/grouping still run for those as before.
  suppressModelUpdateAfterUpdateTransaction: true,
  // Arabic no-rows overlay — shown when data loads successfully but has 0
  // rows. AG Grid only accepts a raw HTML string here (no React/live brand
  // data), so this can't embed the uploaded company logo reactively — but
  // every grid in the system (Attendance, Payroll, Movement, Devices, Raw
  // Logs...) shares this ONE template, so a single visual upgrade here reads
  // consistently everywhere instead of each page inventing its own empty
  // message. Kept quiet/muted on purpose — an empty grid is not an error.
  overlayNoRowsTemplate: `
    <div style="font-family:Cairo,sans-serif;direction:rtl;display:flex;flex-direction:column;align-items:center;gap:8px;padding:36px 0;color:#6B7280">
      <div style="width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;background:rgba(100,116,139,0.12);border:1px solid rgba(100,116,139,0.18)">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M8 4v5"/></svg>
      </div>
      <div style="font-size:13px;font-weight:600">لا توجد سجلات للعرض</div>
      <div style="font-size:11px;opacity:0.75">ستظهر البيانات هنا فور توفرها</div>
    </div>`,
};

/**
 * Enterprise column width tiers — deliberate, fixed widths per column
 * role so headers/icons never clip and no column wastes horizontal space.
 *   TINY:   #, كود, حالة, إجراء — short codes/badges/single icons
 *   MEDIUM: الحضور/الانصراف/التأخير/الإضافي — time + numeric penalty cells
 *   LARGE:  اسم الموظف/القسم/الملاحظات — free text, grows to fill space
 * (LARGE includes flex:1 — drop it when spreading onto a `pinned` column,
 * since AG Grid ignores flex on pinned columns.)
 */
export const COL_TINY   = { width: 70,  maxWidth: 90,  minWidth: 60 };
export const COL_MEDIUM = { width: 110, minWidth: 100 };
export const COL_LARGE  = { width: 220, minWidth: 180, flex: 1 };

/**
 * safeRefreshCells — the ONE guarded way any page calls AG Grid's
 * `api.refreshCells()` (used by every "cell is saving/saved/error" visual
 * marker). Calling refreshCells against a destroyed grid or a rowNode that
 * has since been removed from the model (e.g. a live-sync reload landed, or
 * the user navigated away while a save was still in flight) throws inside
 * AG Grid internals — an uncaught exception there can abort the in-progress
 * React commit and take the whole grid's rendered rows down with it, which
 * is indistinguishable from "rows disappeared" to the user.
 *
 * Previously only EmployeeMovementPage guarded this call (as a local
 * `safeRefreshCells`); AttendanceDailyPage and PayrollPage called
 * `api.refreshCells()` directly. Centralized here so no page can skip it.
 *
 * @param {import('react').RefObject} gridRef - the page's AgGridReact ref
 * @param {string|number} rowId - the row's getRowId value
 * @param {import('ag-grid-community').IRowNode} node - the row node passed
 *   into the cell-edit handler
 * @param {string[]} columns - column fields to refresh
 */
export function safeRefreshCells(gridRef, rowId, node, columns) {
  const api = gridRef?.current?.api;
  if (!api || api.isDestroyed?.()) return;
  if (!node || !api.getRowNode(String(rowId))) return;
  api.refreshCells({ rowNodes: [node], columns, force: true });
}

/**
 * tabToNextCell — Excel-like Tab/Shift+Tab that skips non-editable columns.
 *
 * Pass as the `tabToNextCell` prop on <AgGridReact>.
 * Cycles only through columns whose `colDef.editable` is truthy (or returns
 * truthy when called with the row data). When all editable columns in a row
 * are exhausted, Tab moves to the first editable column of the next row
 * (or last editable of the previous row for Shift+Tab).
 */
/**
 * isAbsentRow — the ONE canonical check for "this row represents an absent
 * employee", shared by every grid's getRowClass, the cell-level status/name
 * overrides, and the print template (reportTemplate.js). Different callers
 * populate different fields (the boolean `isAbsent` flag vs. the raw
 * `status` string), so both are checked — this is a detection change only,
 * it never touches how either field is computed.
 */
export function isAbsentRow(data) {
  return !!(data && (data.isAbsent || data.status === 'absent'));
}

/**
 * attendanceRowClass — shared getRowClass priority chain (Monitored >
 * Holiday > Weekend > Absent > Late > Overtime). Previously duplicated
 * verbatim across AttendanceDailyPage/AttendanceMonthlyPage/
 * EmployeeMovementPage; centralized here so the "entire row" absence
 * highlight (and every other row state) is defined exactly once.
 *
 * Pass directly as the `getRowClass` prop on <AgGridReact>.
 */
export function attendanceRowClass({ data }) {
  if (!data) return '';
  const classes = [];
  if      (data.isMonitored) classes.push('row-monitored');
  if      (data.isHoliday)   classes.push('row-holiday');
  else if (data.isWeekend)   classes.push('row-weekend');
  else if (isAbsentRow(data)) classes.push('row-absent');
  else if ((data.effectiveLatePenalty   || 0) > 0) classes.push('row-late');
  else if ((data.effectiveOvertimeUnits || 0) > 0) classes.push('row-overtime');
  return classes.join(' ');
}

export function tabToNextCell(params) {
  const { backwards, previousCellPosition, nextCellPosition, api } = params;

  // Don't override Tab in pinned rows (totals, headers)
  if (previousCellPosition?.rowPinned) return nextCellPosition;

  // Check if a column is editable for a given row's data
  function isEditable(col, rowData) {
    const def = col.getColDef?.();
    if (!def) return false;
    if (typeof def.editable === 'function') {
      return !!def.editable({ data: rowData, column: col, colDef: def });
    }
    return !!def.editable;
  }

  const allCols = api.getAllDisplayedColumns?.() ?? [];
  const totalRows = api.getDisplayedRowCount?.() ?? 0;
  const step = backwards ? -1 : 1;

  let colIdx = allCols.findIndex(c => c === previousCellPosition?.column);
  let rowIdx = previousCellPosition?.rowIndex ?? 0;

  // Walk columns + rows until we find an editable cell
  let guard = 0;
  while (guard++ < 500) {
    colIdx += step;

    // Wrap: move to next/prev row when column index crosses boundary
    if (colIdx < 0 || colIdx >= allCols.length) {
      rowIdx += step;
      if (rowIdx < 0 || rowIdx >= totalRows) {
        return nextCellPosition; // boundary of grid — use default
      }
      colIdx = backwards ? allCols.length - 1 : 0;
    }

    const col     = allCols[colIdx];
    const rowNode = api.getDisplayedRowAtIndex?.(rowIdx);
    if (!rowNode || rowNode.rowPinned) continue;

    if (isEditable(col, rowNode.data)) {
      return { rowIndex: rowIdx, column: col, rowPinned: null };
    }
  }

  return nextCellPosition; // fallback to AG Grid default
}
