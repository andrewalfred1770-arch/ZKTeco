import React from 'react';

/**
 * Shown above a grid while it holds edits that were typed but NOT saved (session ended). The values are kept in memory only.
 * "إعادة المحاولة" re-sends them through the page's normal save path, one at a time; "تجاهل" restores the previous cell values.
 */
export default function FailedEditsBanner({ count, unknown = 0, retrying, onRetry, onDiscard }) {
  if (!count) return null;
  return (
    <div className="card px-3 py-2 flex flex-wrap items-center gap-3 text-xs" role="alert" data-testid="failed-edits-banner"
      style={{ borderInlineStart: '3px solid #dc2626' }}>
      <span>
        ⚠ <b>{count}</b> تعديل <b>لم يُحفظ</b>.
        {unknown < count && <> انتهت الجلسة: القيم المكتوبة محفوظة في الذاكرة فقط ولم يصل أي منها إلى الخادم — سجّل الدخول ثم اضغط «إعادة المحاولة».</>}
        {unknown > 0 && <> <b data-testid="failed-edits-unknown">{unknown}</b> منها <b>لم يُتأكد من حفظه</b> (انقطع الاتصال قبل وصول الرد): قد يكون الخادم حفظه فعلاً. «تجاهل» يعيد قراءة البيانات من الخادم.</>}
      </span>
      <button type="button" disabled={retrying} onClick={onRetry} className="btn-secondary text-xs py-0.5 px-2" data-testid="failed-edits-retry">
        {retrying ? 'جارٍ الإرسال…' : 'إعادة المحاولة'}
      </button>
      <button type="button" disabled={retrying} onClick={onDiscard} className="btn-ghost text-xs py-0.5 px-2" data-testid="failed-edits-discard">
        تجاهل التعديلات
      </button>
    </div>
  );
}
