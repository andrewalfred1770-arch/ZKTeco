// DIFFERENTIAL RUNTIME HARNESS (read-only instrumentation).
//
// Reproduces the EXACT differential factors between a NORMAL row and a
// MANUAL-OVERRIDE row as they exist in the real app:
//   - AG Grid 31.2.0 (identical version to frontend)
//   - ag-grid.css base rule `.ag-cell { display:inline-block; position:absolute }`
//   - App rule `.cell-manual-override { position: relative; ::after dot }`
//     (frontend/src/index.css:703-712) applied to override cells
//   - App rule `.row-manual { border-inline-end: 3px solid }`
//     (frontend/src/index.css:741-742) applied to override rows
//   - Column cellClass logic from AttendanceDailyPage.jsx:144-159, 180-183
//   - getRowClass logic from AttendanceDailyPage.jsx:233-245
//
// Row 1 = normal. Row 2 = manual override (hasManualPenalty +
// hasManualOvertime + manualEdit all true).
import React, { useMemo, useCallback } from 'react';
import { AgGridReact } from 'ag-grid-react';
import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-quartz.css';

// EXACT copy of the two differential CSS rules from frontend/src/index.css
const APP_CSS = `
.cell-manual-override { position: relative; }
.cell-manual-override::after {
  content: '';
  position: absolute;
  top: 3px; right: 3px;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: #f59e0b;
  box-shadow: 0 0 0 1.5px var(--surface, #fff);
}
.row-manual { border-inline-end: 3px solid #f59e0b !important; }
`;

const editCellClass = () => () => 'cell-editable';

export default function App() {
  const rowData = useMemo(() => ([
    { id: 1, employeeName: 'NORMAL ROW',   effectiveLatePenalty: 1, effectiveOvertimeUnits: 0,
      hasManualPenalty: false, hasManualOvertime: false, manualEdit: false, status: 'late' },
    { id: 2, employeeName: 'OVERRIDE ROW', effectiveLatePenalty: 2, effectiveOvertimeUnits: 1,
      hasManualPenalty: true,  hasManualOvertime: true,  manualEdit: true,  status: 'present' },
  ]), []);

  const columnDefs = useMemo(() => ([
    { field: 'employeeName', headerName: 'اسم الموظف', width: 220 },
    {
      field: 'effectiveLatePenalty', headerName: 'التأخير', width: 110, editable: true,
      cellClass: p => [
        editCellClass('effectiveLatePenalty')(p),
        p.data?.hasManualPenalty ? 'cell-manual-override' : '',
      ].filter(Boolean).join(' '),
    },
    {
      field: 'effectiveOvertimeUnits', headerName: 'الإضافي', width: 110, editable: true,
      cellClass: p => [
        editCellClass('effectiveOvertimeUnits')(p),
        p.data?.hasManualOvertime ? 'cell-manual-override' : '',
      ].filter(Boolean).join(' '),
    },
    { field: 'status', headerName: 'الحالة', width: 175 },
  ]), []);

  const defaultColDef = useMemo(() => ({
    sortable: true, filter: true, resizable: false,
    suppressMovable: true, lockPosition: true,
  }), []);

  const getRowClass = useCallback(({ data }) => {
    if (!data) return '';
    return data.manualEdit ? 'row-manual' : '';
  }, []);

  return (
    <>
      <style>{APP_CSS}</style>
      <div className="ag-theme-quartz" style={{ width: '100%', height: '100%' }}>
        <AgGridReact
          rowData={rowData}
          columnDefs={columnDefs}
          defaultColDef={defaultColDef}
          getRowClass={getRowClass}
          getRowId={p => String(p.data.id)}
          suppressMovableColumns
          reactiveCustomComponents
        />
      </div>
    </>
  );
}
