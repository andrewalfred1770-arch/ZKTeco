// Database Setup Wizard bridge — the main-process side of the `setup:request` IPC channel (F1 stage 2).
//
// Kept free of Electron imports so it can be exercised in isolation with an injected `httpRequest` (no listener, no backend). ipc.js wires
// it to the trusted-sender check (security.js secureHandle) and to the real `http.request`.
//
// The renderer never sees the per-launch secret, its signature headers, or any text derived from them: every failure below returns a
// fixed status/code/message.
import { request as realHttpRequest } from 'http';
import { signSetupRequest, getHandoffState } from './setupAuth.js';

export const SETUP_OPS = Object.freeze({ 'current': 'GET', 'test-connection': 'POST', 'save': 'POST' });
const FIELDS = ['host', 'port', 'database', 'username', 'password'];

const unavailable = (code, error) => ({ status: 503, data: { code, error } });
export const SETUP_UNAVAILABLE = {
  none: () => unavailable('SETUP_UNAVAILABLE', 'إعداد قاعدة البيانات غير متاح الآن / Database setup is unavailable'),
  adopted: () => unavailable('SETUP_ADOPTED_BACKEND', 'الخادم يعمل من جلسة سابقة ولا يمكن إعداد قاعدة البيانات منه — أغلق CheckIn تماماً (وأي عملية خادم متبقية) ثم افتحه من جديد / The backend was started by an earlier session and cannot be configured from here — fully quit CheckIn (and any leftover backend process) and start it again'),
  pending: () => unavailable('SETUP_HANDOFF_PENDING', 'الخادم لم يكمل التهيئة بعد، حاول بعد لحظات / The backend is still starting — try again in a moment'),
  failed: () => unavailable('SETUP_HANDOFF_FAILED', 'تعذّر تأمين قناة الإعداد مع الخادم — أعد تشغيل CheckIn / The setup channel to the backend could not be secured — restart CheckIn'),
};

/**
 * @param {{op?:string, body?:object}} arg  untrusted renderer input
 * @param {{ getBackend:()=>{proc:any, adopted:boolean}, port:number, httpRequest?:Function, timeoutMs?:number }} deps
 * @returns {Promise<{status:number, data:any}>}
 */
export async function performSetupRequest(arg, { getBackend, port, httpRequest = realHttpRequest, timeoutMs = 30000 }) {
  const op = arg && typeof arg === 'object' ? arg.op : undefined;
  const method = typeof op === 'string' && Object.prototype.hasOwnProperty.call(SETUP_OPS, op) ? SETUP_OPS[op] : undefined;
  if (!method) return { status: 400, data: { error: 'Unknown setup operation' } };

  const { proc, adopted } = getBackend();
  if (adopted && !proc) return SETUP_UNAVAILABLE.adopted();
  if (!proc || proc.exitCode !== null) return SETUP_UNAVAILABLE.none();
  const hs = getHandoffState();
  if (hs !== 'ready') return (SETUP_UNAVAILABLE[hs] || SETUP_UNAVAILABLE.none)();

  // The signed body is exactly what the backend parses: '{}' for a GET (nothing is sent), the allow-listed fields for a POST.
  let bodyString = '{}';
  if (method === 'POST') {
    const f = arg.body && typeof arg.body === 'object' ? arg.body : {};
    const clean = {};
    for (const k of FIELDS) {
      const v = f[k];
      if (v === undefined || v === null) continue;
      if ((typeof v !== 'string' && typeof v !== 'number') || String(v).length > 256) return { status: 400, data: { error: 'Invalid field' } };
      clean[k] = String(v);
    }
    bodyString = JSON.stringify(clean);
  }

  const path = `/api/setup/${op}`;
  try {
    const headers = { ...signSetupRequest({ method, path, bodyString }) };
    if (method === 'POST') {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(bodyString);
    }   // a GET carries NO body, hence no Content-Length / Content-Type (a declared length would make the server wait for bytes forever)
    return await new Promise((resolve) => {
      const req = httpRequest({ host: '127.0.0.1', port, path, method, headers, timeout: timeoutMs }, (res) => {
        const chunks = [];
        res.on('data', (c) => { if (chunks.length < 64) chunks.push(c); });
        res.on('end', () => {
          let data = null;
          try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* non-JSON */ }
          resolve({ status: res.statusCode || 0, data });
        });
      });
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve({ status: 0, data: { error: 'Backend unreachable' } }));
      if (method === 'POST') req.end(bodyString); else req.end();
    });
  } catch {
    return SETUP_UNAVAILABLE.none();   // never include error text: nothing derived from the secret may leave main
  }
}
