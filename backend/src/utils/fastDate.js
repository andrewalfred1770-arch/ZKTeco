/**
 * Lightweight local-time date/time formatters — same output as
 * moment(d).format('YYYY-MM-DD') / .format('HH:mm') for a Date object, but
 * without constructing a Moment wrapper object per call. Used on hot paths
 * that format thousands of rows per request (Phase 24.2).
 */
function pad(n) { return n < 10 ? '0' + n : String(n); }

function fmtDate(d) {
  const x = d instanceof Date ? d : new Date(d);
  return x.getFullYear() + '-' + pad(x.getMonth() + 1) + '-' + pad(x.getDate());
}

function fmtTime(d) {
  const x = d instanceof Date ? d : new Date(d);
  return pad(x.getHours()) + ':' + pad(x.getMinutes());
}

module.exports = { fmtDate, fmtTime };
