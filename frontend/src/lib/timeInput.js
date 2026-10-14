/**
 * timeInput.js — strict, dependency-free parsing of a time typed or pasted into an attendance cell.
 *
 * ONE parser for the grid's cell editor and for clipboard paste, so a value that is accepted when typed is accepted when
 * pasted and vice-versa. It never guesses: anything it cannot read unambiguously is REJECTED with a reason — it is never
 * silently turned into "00:00" or any other time. The result is the 24-hour "HH:mm" string the attendance API requires.
 *
 * Accepted (case-insensitive, Arabic-Indic / Persian digits and surrounding whitespace tolerated):
 *   09:00   9:00   09:00:00   9.30   0900   900                 24-hour clock
 *   9:00 AM   09:00 pm   9 AM   12 PM   12:30 am   9:00 a.m.     12-hour clock (hour 1–12)
 *   ٩:٠٠ ص   ٩ م   9:00 مساءً                                      Arabic AM/PM markers (ص / م)
 *   2026-10-07 09:00   2026-10-07T09:00:00                       a date followed by a time → the time part
 *
 * Rejected: empty text, a bare number such as "9" or "09" (ambiguous), hour > 23 (24-hour) or outside 1–12 (with AM/PM),
 * minutes > 59, "24:00", free text.
 */

const EASTERN = '٠١٢٣٤٥٦٧٨٩';   // Arabic-Indic
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';   // Extended Arabic-Indic

/** Latin digits, ASCII colon, single spaces, no zero-width / bidi marks. */
export function normalizeTimeText(raw) {
  return String(raw ?? '')
    .replace(/[‎‏‪-‮⁦-⁩﻿]/g, '')
    .replace(/[   ]/g, ' ')
    .replace(/[٠-٩]/g, (d) => String(EASTERN.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String(PERSIAN.indexOf(d)))
    .replace(/[：︰]/g, ':')
    .replace(/[٫]/g, '.')
    .trim();
}

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * @param {*} raw
 * @returns {{ok:true, value:string, text:string} | {ok:false, empty:boolean, reason:string, text:string}}
 */
export function parseTimeInput(raw) {
  const text = normalizeTimeText(raw);
  if (text === '') return { ok: false, empty: true, reason: 'قيمة فارغة', text };

  let s = text.toLowerCase();
  // date + time → keep the time part only
  const dt = /^\d{4}-\d{1,2}-\d{1,2}[t\s]+(.+)$/.exec(s);
  if (dt) s = dt[1].trim();

  // optional AM/PM marker (Latin or Arabic), glued or space-separated
  let marker = null;
  const mk = /\s*(a\.?\s?m\.?|p\.?\s?m\.?|ص|م|صباحا|صباحاً|مساء|مساءً|مساءا)$/.exec(s);
  if (mk) {
    const m = mk[1].replace(/[.\s]/g, '');
    marker = (m === 'am' || m === 'ص' || m.startsWith('صباح')) ? 'am' : 'pm';
    s = s.slice(0, mk.index).trim();
  }

  let h; let min; let sec = 0;
  let m1;
  if ((m1 = /^(\d{1,2})[:.](\d{1,2})(?::(\d{1,2}))?$/.exec(s))) {
    h = Number(m1[1]); min = Number(m1[2]); sec = m1[3] === undefined ? 0 : Number(m1[3]);
    if (m1[2].length !== 2) return { ok: false, empty: false, reason: 'الدقائق يجب أن تكون من رقمين', text };
  } else if (!marker && (m1 = /^(\d{1,2})(\d{2})$/.exec(s)) && s.length >= 3) {
    h = Number(m1[1]); min = Number(m1[2]);                       // 900 / 0900
  } else if (marker && (m1 = /^(\d{1,2})$/.exec(s))) {
    h = Number(m1[1]); min = 0;                                   // 9 AM
  } else {
    return { ok: false, empty: false, reason: 'صيغة الوقت غير مفهومة (استخدم 09:00 أو 9:00 AM)', text };
  }

  if (sec > 59 || min > 59) return { ok: false, empty: false, reason: 'الدقائق/الثواني يجب ألا تتجاوز 59', text };
  if (marker) {
    if (h < 1 || h > 12) return { ok: false, empty: false, reason: 'الساعة مع AM/PM يجب أن تكون من 1 إلى 12', text };
    if (marker === 'am') h = h === 12 ? 0 : h;
    else h = h === 12 ? 12 : h + 12;
  } else if (h > 23) {
    return { ok: false, empty: false, reason: 'الساعة يجب أن تكون من 0 إلى 23', text };
  }
  return { ok: true, value: `${pad2(h)}:${pad2(min)}`, text };
}
