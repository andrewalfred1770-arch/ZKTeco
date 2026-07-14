/**
 * useAttendanceFilter — centralised filter state for all attendance grids.
 *
 * Pattern:
 *   const { filters, updateFilter, applyQuick, clearFilters,
 *           doesPassFilter, isActive, gridApiRef } = useAttendanceFilter();
 *
 *   // Wire to AG Grid:
 *   isExternalFilterPresent={() => isActive}
 *   doesExternalFilterPass={p => doesPassFilter(p.data)}
 *
 *   // Notify grid whenever filters change:
 *   // (handled automatically inside updateFilter / applyQuick / clearFilters)
 *   // Just save gridApiRef.current = api in onGridReady.
 *
 * Performance: doesPassFilter uses a ref so the callback never needs to be
 * recreated — AG Grid holds one stable reference.  Filter evaluation is O(n)
 * synchronous but AG Grid only renders the visible viewport, so 5 000 rows
 * filter instantly.
 */
import { useState, useCallback, useRef } from 'react';

export const EMPTY_FILTERS = {
  search:        '',
  statuses:      [],        // string[]  e.g. ['absent','late']
  absenceTypes:  [],        // string[]  'with_permission'|'without_permission'|'custom'
  penaltyOp:     'none',   // 'none'|'gt'|'lt'|'eq'|'between'
  penaltyVal:    '',
  penaltyVal2:   '',        // upper bound for 'between'
  lateOp:        'none',   // 'none'|'gt'|'lt'|'eq'
  lateVal:       '',
  earlyLeaveOp:  'none',
  earlyLeaveVal: '',
  overtimeMode:  'all',    // 'all'|'has'|'none'
  overtimeGt:    '',
  monitored:     'all',    // 'all'|'only'|'hide'
  biometric:     [],        // 'missing_checkin'|'missing_checkout'|'no_punches'|'incomplete'
  departments:   [],        // string[]  department names
};

// Quick-filter presets that map a button label to a partial filter state
export const QUICK_PRESETS = {
  all:                EMPTY_FILTERS,
  absent:             { ...EMPTY_FILTERS, statuses: ['absent'] },
  late:               { ...EMPTY_FILTERS, statuses: ['late'] },
  deductions:         { ...EMPTY_FILTERS, penaltyOp: 'gt', penaltyVal: '0' },
  overtime:           { ...EMPTY_FILTERS, overtimeMode: 'has' },
  with_permission:    { ...EMPTY_FILTERS, absenceTypes: ['with_permission'] },
  without_permission: { ...EMPTY_FILTERS, absenceTypes: ['without_permission'] },
  monitored:          { ...EMPTY_FILTERS, monitored: 'only' },
  incomplete:         { ...EMPTY_FILTERS, biometric: ['missing_checkin', 'missing_checkout'] },
};

export function useAttendanceFilter() {
  const [filters, _setFilters] = useState(EMPTY_FILTERS);
  // Ref always holds the LATEST filters — doesPassFilter reads from this so
  // the callback never needs to be recreated (stable reference for AG Grid).
  const filtersRef  = useRef(EMPTY_FILTERS);
  const gridApiRef  = useRef(null);

  const commit = useCallback((next) => {
    filtersRef.current = next;
    _setFilters(next);
    gridApiRef.current?.onFilterChanged();
  }, []);

  const updateFilter = useCallback((key, value) => {
    commit({ ...filtersRef.current, [key]: value });
  }, [commit]);

  // Toggle a value inside an array-typed filter field
  const toggleArrayItem = useCallback((key, item) => {
    const prev = filtersRef.current[key] || [];
    const next = prev.includes(item) ? prev.filter(x => x !== item) : [...prev, item];
    commit({ ...filtersRef.current, [key]: next });
  }, [commit]);

  const applyQuick = useCallback((presetKey) => {
    commit(QUICK_PRESETS[presetKey] || EMPTY_FILTERS);
  }, [commit]);

  const clearFilters = useCallback(() => {
    commit(EMPTY_FILTERS);
  }, [commit]);

  // Pure filter function — called by AG Grid for every row.
  // Reads from filtersRef.current so it never goes stale.
  const doesPassFilter = useCallback((row) => {
    if (!row) return true;
    const f = filtersRef.current;

    // ── Global search ───────────────────────────────────────────────────────
    if (f.search.trim()) {
      const q = f.search.trim().toLowerCase();
      const hit = [
        row.employeeName,
        String(row.employeeCode ?? ''),
        row.department,
        row.position,
        row.jobTitle,
      ].some(v => v?.toLowerCase().includes(q));
      if (!hit) return false;
    }

    // ── Status multi-select ─────────────────────────────────────────────────
    if (f.statuses.length) {
      const s = row.status || 'present';
      if (!f.statuses.includes(s)) return false;
    }

    // ── Absence type ────────────────────────────────────────────────────────
    if (f.absenceTypes.length) {
      if (!row.isAbsent) return false;
      if (!f.absenceTypes.includes(row.absenceType || 'none')) return false;
    }

    // ── Penalty days ────────────────────────────────────────────────────────
    if (f.penaltyOp !== 'none') {
      const v  = row.penaltyDays ?? 0;
      const t  = parseFloat(f.penaltyVal)  || 0;
      const t2 = parseFloat(f.penaltyVal2) || 0;
      if (f.penaltyOp === 'gt'      && !(v > t))           return false;
      if (f.penaltyOp === 'lt'      && !(v < t))           return false;
      if (f.penaltyOp === 'eq'      && v !== t)            return false;
      if (f.penaltyOp === 'between' && !(v >= t && v <= t2)) return false;
    }

    // ── Late minutes ────────────────────────────────────────────────────────
    if (f.lateOp !== 'none') {
      const v = row.lateMinutes ?? 0;
      const t = parseFloat(f.lateVal) || 0;
      if (f.lateOp === 'gt' && !(v > t)) return false;
      if (f.lateOp === 'lt' && !(v < t)) return false;
      if (f.lateOp === 'eq' && v !== t)  return false;
    }

    // ── Early leave minutes ─────────────────────────────────────────────────
    if (f.earlyLeaveOp !== 'none') {
      const v = row.earlyLeaveMinutes ?? 0;
      const t = parseFloat(f.earlyLeaveVal) || 0;
      if (f.earlyLeaveOp === 'gt' && !(v > t)) return false;
      if (f.earlyLeaveOp === 'lt' && !(v < t)) return false;
      if (f.earlyLeaveOp === 'eq' && v !== t)  return false;
    }

    // ── Overtime ────────────────────────────────────────────────────────────
    const ot = row.effectiveOvertimeUnits ?? row.overtimeHours ?? 0;
    if (f.overtimeMode === 'has'  && !(ot > 0)) return false;
    if (f.overtimeMode === 'none' && ot > 0)    return false;
    if (f.overtimeGt) {
      const t = parseFloat(f.overtimeGt) || 0;
      if (!(ot > t)) return false;
    }

    // ── Monitored employee ──────────────────────────────────────────────────
    if (f.monitored === 'only' && !row.isMonitored) return false;
    if (f.monitored === 'hide' &&  row.isMonitored) return false;

    // ── Biometric ───────────────────────────────────────────────────────────
    for (const bm of f.biometric) {
      if (bm === 'missing_checkin'  && row.checkIn)                   return false;
      if (bm === 'missing_checkout' && row.checkOut)                  return false;
      if (bm === 'no_punches'       && (row.checkIn || row.checkOut)) return false;
      if (bm === 'incomplete'       && row.checkIn && row.checkOut)   return false;
    }

    // ── Departments ─────────────────────────────────────────────────────────
    if (f.departments.length && !f.departments.includes(row.department)) return false;

    return true;
  }, []); // intentionally empty — reads via ref

  // True when any filter differs from empty state
  const isActive = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  return {
    filters,
    updateFilter,
    toggleArrayItem,
    applyQuick,
    clearFilters,
    doesPassFilter,
    isActive,
    gridApiRef,
  };
}
