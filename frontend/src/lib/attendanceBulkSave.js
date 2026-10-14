/**
 * attendanceBulkSave.js — saves many attendance cell edits through the EXISTING approved API
 * (PUT /attendance/daily/:id — the same endpoint, validation, authorization, manual-edit lock, audit trail and payroll
 * protection every inline edit already uses). Nothing is written any other way.
 *
 * Guarantees:
 *  - operations on the same attendance record are merged into ONE request ({checkIn, checkOut, status} together), so a
 *    check-in and a check-out pasted for the same day are saved atomically and neither can be lost;
 *  - requests for the same record never overlap (a per-record queue also serialises overlapping batches and retries);
 *    different records are saved with a small bounded concurrency;
 *  - success is reported only after the server answered with the saved row, and the saved row is compared with what was
 *    requested: 'saved' = identical, 'adjusted' = persisted but the server's rule produced a different value (shown to
 *    the user, never hidden), 'failed' = not persisted (kept, with the reason, so it can be retried);
 *  - one failing record never stops the others (partial failure is normal and reported cell by cell).
 */

/** Same shape as normalizeDailyUpdate(): the API row with times as "HH:mm". Kept local so this module stays dependency-free. */
function hhmm(v) {
  if (!v) return null;
  if (typeof v === 'string' && /^\d{2}:\d{2}$/.test(v)) return v;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function describeError(err) {
  const data = err && err.response && err.response.data;
  if (data && typeof data.error === 'string' && data.error) return data.error;
  if (err && err.response && err.response.status) return `فشل الحفظ (HTTP ${err.response.status})`;
  return (err && err.message) || 'فشل الحفظ';
}

/**
 * @param {object} cfg
 * @param {{put:(url:string, body:object)=>Promise<{data:object}>}} cfg.api   axios-like client
 * @param {string} cfg.actor            modifiedByName written to the audit trail
 * @param {string} [cfg.source]         audit source tag (default 'inline-grid' — an approved value)
 * @param {number} [cfg.concurrency]    records saved in parallel (default 3)
 */
export function createBulkSaver({ api, actor, source = 'inline-grid', concurrency = 3 }) {
  const chains = new Map();     // rowId -> tail promise (per-record serialisation across batches)

  const enqueue = (rowId, job) => {
    const prev = chains.get(rowId) || Promise.resolve();
    const run = prev.then(job, job);
    const tail = run.catch(() => {});
    chains.set(rowId, tail);
    tail.then(() => { if (chains.get(rowId) === tail) chains.delete(rowId); });
    return run;
  };

  /**
   * @param {object[]} ops   [{rowId, field, value, ...}] — one entry per cell
   * @param {object} [hooks] { onCell(op, state, info), onRowSaved(updatedRow, rowId) }
   * @returns {Promise<{saved:object[], adjusted:object[], failed:object[], protectedRows:number, rows:number}>}
   */
  async function save(ops, hooks = {}) {
    const result = { saved: [], adjusted: [], failed: [], protectedRows: 0, rows: 0 };
    const byRow = new Map();
    for (const op of ops || []) {
      if (!byRow.has(op.rowId)) byRow.set(op.rowId, new Map());
      byRow.get(op.rowId).set(op.field, op);                 // the last value for a field wins
    }
    result.rows = byRow.size;
    const jobs = [...byRow.entries()].map(([rowId, fields]) => ({ rowId, fields: [...fields.values()] }));

    const runRow = ({ rowId, fields }) => enqueue(rowId, async () => {
      const body = { modifiedByName: actor, source };
      for (const op of fields) body[op.field] = op.value;
      fields.forEach((op) => hooks.onCell && hooks.onCell(op, 'saving'));
      let res;
      try {
        res = await api.put(`/attendance/daily/${rowId}`, body);
      } catch (err) {
        const reason = describeError(err);
        for (const op of fields) { result.failed.push({ ...op, error: reason }); hooks.onCell && hooks.onCell(op, 'failed', { error: reason }); }
        return;
      }
      const row = res && res.data;
      if (!row || row.id !== rowId) {                          // no confirmation of THIS record → not a success
        const reason = 'لم يؤكد الخادم حفظ السجل';
        for (const op of fields) { result.failed.push({ ...op, error: reason }); hooks.onCell && hooks.onCell(op, 'failed', { error: reason }); }
        return;
      }
      const updated = { ...row, checkIn: hhmm(row.checkIn), checkOut: hhmm(row.checkOut) };
      if (updated.payrollProtected) result.protectedRows++;
      hooks.onRowSaved && hooks.onRowSaved(updated, rowId);
      for (const op of fields) {
        const got = updated[op.field];
        if (got === op.value) { result.saved.push(op); hooks.onCell && hooks.onCell(op, 'saved'); }
        else {
          const info = { got, error: `حُفظ بقيمة مختلفة عن المطلوبة (${got ?? '—'})` };
          result.adjusted.push({ ...op, ...info });
          hooks.onCell && hooks.onCell(op, 'adjusted', info);
        }
      }
    });

    // bounded concurrency over records
    let next = 0;
    const worker = async () => { while (next < jobs.length) { const j = jobs[next++]; await runRow(j); } };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, worker));
    return result;
  }

  return { save, pendingRows: () => chains.size };
}
