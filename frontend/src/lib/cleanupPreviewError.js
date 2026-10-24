/**
 * cleanupPreviewError.js — turns a failed POST /cleanup/preview into a clear, SAFE Arabic explanation.
 * Pure (no React, no network). Display-only: it never changes the request, the retry behaviour or any cleanup logic.
 *
 * Distinguishes: 401 session expired · 403 insufficient permissions · 400 invalid input · 503 backend unavailable ·
 * timeout · network failure · other server errors. A server-provided message is shown only when it is plainly app-authored:
 * anything that looks like a stack trace, SQL, a Prisma/driver message, a connection string, a credential, a file path or
 * markup is dropped and replaced by the generic explanation for that status.
 */

const UNSAFE = /prisma|invocation|\bat\s+\S+\s+\(.*:\d+:\d+\)|\n\s+at\s|\bSELECT\b|\bINSERT\b|\bUPDATE\b|\bDELETE\s+FROM\b|\bFROM\s+`|\bWHERE\b|mysql:\/\/|postgres(ql)?:\/\/|jdbc:|password|passwd|\bpwd\b|secret|token|api[_-]?key|bearer\s|authorization|node_modules|[A-Za-z]:\\|\/(?:home|usr|var|etc)\/|<\/?[a-z][^>]*>|ECONN\w+|ETIMEDOUT|ENOTFOUND|\bstack\b|Error:\s/i;
const MAX_LEN = 240;

/** The server's message, only if it is safe to show; otherwise null. */
export function safeServerMessage(data) {
  const raw = data && typeof data === 'object' ? data.error : (typeof data === 'string' ? null : null);
  if (typeof raw !== 'string') return null;
  const msg = raw.trim();
  if (!msg || msg.length > MAX_LEN || UNSAFE.test(msg)) return null;
  return msg;
}

function isTimeout(err) {
  return !!err && (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT' || /timeout/i.test(String(err.message || '')));
}

/**
 * @param {any} err  an axios error (or anything thrown)
 * @returns {{kind:'session-expired'|'forbidden'|'invalid-input'|'backend-unavailable'|'timeout'|'network'|'server-error'|'rejected'|'unknown', status:number|null, message:string}}
 */
export function describePreviewError(err) {
  const res = err && err.response;
  if (!res) {
    if (isTimeout(err)) {
      return { kind: 'timeout', status: null, message: 'انتهت مهلة طلب المعاينة قبل أن يردّ الخادم. قد تكون الفترة كبيرة جدًا — جرّب فترة أقصر أو أعد المحاولة.' };
    }
    if (err && (err.request || err.code === 'ERR_NETWORK' || err.message === 'Network Error')) {
      return { kind: 'network', status: null, message: 'تعذّر الاتصال بالخادم. تأكد من أن البرنامج يعمل وأن الاتصال سليم ثم أعد المحاولة.' };
    }
    return { kind: 'unknown', status: null, message: 'تعذّر تنفيذ المعاينة لسبب غير معروف. أعد المحاولة، وإن تكرر فراجع مسؤول النظام.' };
  }
  const status = Number(res.status) || null;
  const server = safeServerMessage(res.data);
  const tag = status ? ` (HTTP ${status})` : '';
  if (status === 401) return { kind: 'session-expired', status, message: `انتهت الجلسة أو لم يعد تسجيل الدخول صالحًا${tag}. سجّل الدخول من جديد ثم أعد المعاينة.` };
  if (status === 403) return { kind: 'forbidden', status, message: `ليست لديك صلاحية استخدام أداة التنظيف${tag} — هذه الأداة لمدير النظام فقط.` };
  if (status === 400) return { kind: 'invalid-input', status, message: `${server || 'بيانات الطلب غير صالحة — راجع الفترة وأنواع البيانات المختارة'}${tag}.` };
  if (status === 503) return { kind: 'backend-unavailable', status, message: `${server || 'الخادم غير جاهز حاليًا'}${tag}. انتظر قليلًا ثم أعد المحاولة، أو راجع حالة الاتصال بقاعدة البيانات.` };
  if (status === 408 || status === 504) return { kind: 'timeout', status, message: `انتهت مهلة المعالجة في الخادم${tag}. جرّب فترة أقصر.` };
  if (status >= 500) return { kind: 'server-error', status, message: `${server || 'حدث خطأ في الخادم أثناء المعاينة'}${tag}. لم يُحذف أي شيء.` };
  return { kind: 'rejected', status, message: `${server || 'رُفض طلب المعاينة'}${tag}.` };
}
