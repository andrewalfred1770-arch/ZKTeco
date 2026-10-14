/**
 * saveFailure.js — what a form tells the user when a save did not go through.
 *
 * Every form already keeps its typed values when a save fails (the modal stays open, the state is untouched) and only reports success
 * after the server answered. What was missing was an honest message when the SESSION is what failed: a bare "فشل الحفظ" (or the
 * server's own 401 text) does not say that nothing was stored and that the form still holds everything. For session loss this returns
 * that message; any other failure keeps its existing text, so nothing else changes.
 */
import { isSessionLostError } from './unsavedWork';

export const SESSION_NOT_SAVED_MESSAGE = 'لم يُحفظ — انتهت الجلسة. ما كتبته ما زال في النموذج: سجّل الدخول ثم اضغط «حفظ» من جديد.';

export function describeSaveFailure(err, fallback = 'فشل الحفظ') {
  if (isSessionLostError(err)) return SESSION_NOT_SAVED_MESSAGE;
  const server = err && err.response && err.response.data && err.response.data.error;
  return typeof server === 'string' && server ? server : fallback;
}
