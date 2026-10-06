/**
 * dateParam — query-string day bounds for TIMESTAMP columns (createdAt etc.).
 *
 * `new Date('2026-07-15')` is UTC midnight, which is NOT the start of the
 * business (server-local) day: in Cairo it is 02:00/03:00 local, so a `from`
 * filter silently dropped the first hours of that day, and the old
 * `new Date(new Date(to).setHours(23,59,59,999))` only ended the day correctly
 * by accident of the offset's sign. A date-only value ("YYYY-MM-DD") is
 * therefore anchored to LOCAL midnight / 23:59:59.999; anything else (a full
 * datetime) keeps its previous parse unchanged.
 */
const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

function startOfDayParam(value) {
  const m = DATE_ONLY.exec(String(value));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0) : new Date(value);
}

function endOfDayParam(value) {
  const m = DATE_ONLY.exec(String(value));
  return m ? new Date(+m[1], +m[2] - 1, +m[3], 23, 59, 59, 999) : new Date(new Date(value).setHours(23, 59, 59, 999));
}

module.exports = { startOfDayParam, endOfDayParam };
