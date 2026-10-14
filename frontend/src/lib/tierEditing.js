/**
 * tierEditing.js — pure helpers for the tier tables on the Attendance Settings page (late_rules / early_rules).
 *
 * Why this exists: both the backend (utils/ruleValidation.js) and the page validator require late_rules to cover work_start → 23:59 with no
 * gap and no overlap. Nothing in the data model, the validators or the engine stops at 16:00 — but the old "add tier" button created a
 * 00:00 → 23:59 row, which overlaps every existing tier, so extending a table that ended earlier (e.g. at 04:00 PM) meant hand-editing two
 * 12-hour time inputs just to get a valid row. nextTier() starts the new row right after the last covered minute and runs it to 23:59.
 *
 * Nothing here saves anything or changes any stored value: it only proposes a draft row the user can edit; Save still goes through the same
 * validation (page + server) and the same PUT /rules as before.
 */
const DAY_END_MIN = 23 * 60 + 59;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const timeToMin = (hhmm) => {
  if (typeof hhmm !== 'string' || !TIME_RE.test(hhmm)) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
export const minToTime = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** "16:00" → "04:00 م" (the 12-hour form the browser's time input shows), for hints only. */
export function to12h(hhmm) {
  const m = timeToMin(hhmm);
  if (m === null) return '';
  const h = Math.floor(m / 60);
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${String(h12).padStart(2, '0')}:${String(m % 60).padStart(2, '0')} ${h >= 12 ? 'م' : 'ص'}`;
}

/** The tier whose toTime is latest (ignoring malformed rows), or null. */
export function lastTier(tiers) {
  let best = null;
  for (const t of Array.isArray(tiers) ? tiers : []) {
    const to = t && timeToMin(t.toTime);
    if (to === null || to === undefined) continue;
    if (best === null || to >= timeToMin(best.toTime)) best = t;
  }
  return best;
}

/** How far the table reaches: { lastTo, reachesDayEnd }. lastTo is null for an empty / unusable table. */
export function coverage(tiers) {
  const last = lastTier(tiers);
  if (!last) return { lastTo: null, reachesDayEnd: false };
  return { lastTo: last.toTime, reachesDayEnd: timeToMin(last.toTime) >= DAY_END_MIN };
}

/**
 * The draft row "add tier" appends.
 *  - table reaches 23:59, is empty / unusable, or has only ONE minute left (ends at 23:58 — a valid tier needs from < to, so no new row
 *    can fit; the user extends the last tier instead): the long-standing 00:00 → 23:59 / 0 row (the user then places it);
 *  - otherwise: starts one minute after the last covered minute and runs to 23:59, carrying the last tier's units (the rule keeps
 *    applying later in the day until the user changes it — they see and edit the row before saving).
 */
export function nextTier(tiers) {
  const last = lastTier(tiers);
  const to = last ? timeToMin(last.toTime) : null;
  if (to === null || to >= DAY_END_MIN - 1) return { fromTime: '00:00', toTime: '23:59', units: 0 };
  const units = Number.isFinite(Number(last.units)) ? Number(last.units) : 0;
  return { fromTime: minToTime(to + 1), toTime: '23:59', units };
}
