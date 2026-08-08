import { useCallback, useRef, useState } from 'react';
import { getSocket, subscribeConnectionStatus } from '../lib/socket';
import api, { LONG_OP } from '../lib/api';

/**
 * useFingerprintSyncWorkflow — drives the "Download Fingerprints" modal off
 * REAL backend checkpoints only.
 *
 * zktecoService.js's pullLogs() already does all of this work synchronously,
 * awaited end-to-end before the HTTP response returns (connect → read/merge
 * → save to DB → recompute AttendanceDaily for touched days) — this hook adds
 * no new backend behavior, it only listens to the `device:sync-step` /
 * `device:synced` / `device:error` / `device:offline` events that step
 * already emits at real checkpoints, and only resolves the "success" phase
 * after (a) the HTTP response for the whole request has actually returned
 * AND (b) the caller's own `reload()` has actually finished — never before.
 */
const STEP_ORDER = ['connecting', 'connected', 'reading', 'saving', 'updating-attendance', 'refreshing-dashboard'];

function initialState() {
  return {
    open: false,
    phase: 'idle', // idle | running | success | partial | error
    currentStep: null,
    stepDetail: null,
    error: null,
    result: null,
    startedAt: null,
    socketStatus: 'connected', // connecting | connected | reconnecting | disconnected
    // Presentation-only carry-forward of values the step events already
    // report. `stepDetail` holds ONLY the latest event, so the device name
    // and the read-so-far count would vanish from the UI the moment the
    // backend moves past the step that reported them; these keep the last
    // real value visible instead of blanking mid-run. Nothing derived here
    // feeds back into the workflow.
    deviceName: null,
    recordsRead: 0,
  };
}

export function useFingerprintSyncWorkflow() {
  const [state, setState] = useState(initialState());
  const runningRef = useRef(false);
  const lastRunRef = useRef(null);
  // Monotonic run token — incremented on every run() call. A run's socket
  // handlers and setState calls all check their captured token against this
  // ref before touching state, so a run that's been superseded (its own
  // finally already ran, runningRef released, a NEWER run started and
  // finished) can never again mutate what the user sees — closing the exact
  // race this hook is built to avoid: a slow/late-arriving event from an
  // earlier attempt overwriting a newer attempt's already-shown result.
  const runTokenRef = useRef(0);

  const run = useCallback(async ({ endpoint, deviceId = null, reload }) => {
    // Duplicate-download guard — synchronous check-and-set, no await between
    // them, so two rapid clicks (or a click during an in-flight retry) can
    // never both pass.
    if (runningRef.current) return;
    runningRef.current = true;
    lastRunRef.current = { endpoint, deviceId, reload };

    const myToken = ++runTokenRef.current;
    const isCurrent = () => runTokenRef.current === myToken;

    const startedAt = Date.now();
    setState({ ...initialState(), open: true, phase: 'running', currentStep: 'connecting', startedAt });

    const socket = getSocket();
    console.log('[FP-TRACE] run() start, socket.connected=', socket.connected, 'socket.id=', socket.id, 'endpoint=', endpoint);

    const matches = (data) => deviceId == null || data?.deviceId === deviceId;

    // Live per-step UI only — the authoritative final result (success/
    // partial/error, and the exact downloaded/imported/duplicate/failed
    // counts) always comes from the awaited HTTP response below, which is
    // guaranteed to arrive (it's the same request whose completion IS the
    // backend finishing) unlike a broadcast the client could miss mid-sync.
    const onStep = (data) => {
      console.log('[FP-TRACE] device:sync-step received', JSON.stringify(data), 'isCurrent=', isCurrent(), 'matches=', matches(data));
      if (!isCurrent() || !matches(data)) return;
      setState((s) => (s.phase === 'running' ? {
        ...s,
        currentStep: data.step,
        stepDetail: data,
        deviceName: data.name ?? s.deviceName,
        // Monotonic: the convergence loop re-emits `reading` per pass and the
        // merged set only grows, but a late-arriving event from an earlier
        // pass must never make the displayed count go backwards.
        recordsRead: typeof data.recordsSoFar === 'number'
          ? Math.max(s.recordsRead, data.recordsSoFar)
          : s.recordsRead,
      } : s));
    };
    socket.on('device:sync-step', onStep);

    // The connection can drop/reconnect mid-sync (network blip) — a broadcast
    // sent while this client is disconnected is lost (WebSocket, not queued),
    // so a step can appear to "pause" during that window. Surfacing the real
    // connection state honestly (rather than pretending the bar is still
    // live-updating) is the truthful thing to show; the operation itself is
    // unaffected — see the module doc comment for why success/failure always
    // arrives via the awaited HTTP response regardless of socket health.
    const unsubStatus = subscribeConnectionStatus((status) => {
      if (!isCurrent()) return;
      setState((s) => (s.phase === 'running' ? { ...s, socketStatus: status } : s));
    });

    try {
      const { data } = await api.post(endpoint, null, LONG_OP);
      if (!isCurrent()) return; // a newer run has already started/finished — this result is stale

      // /devices/:id/sync resolves one result object; /devices/sync-all
      // resolves { results: [...] } — normalize to a list either way.
      const list = Array.isArray(data?.results) ? data.results : [data];

      // A device already mid-sync (scheduler tick or another manual trigger
      // holding zktecoService.js's per-device lock) returns near-instantly
      // with { skipped: true } rather than success/failure — real work simply
      // never ran. Showing that as an empty "0 downloaded / 0 imported"
      // success or partial dialog would be misleading (it reads as "nothing
      // was there to sync" when actually nothing was ATTEMPTED); this is
      // deliberately its own distinct outcome, not folded into partial/error.
      if (list.length > 0 && list.every((r) => r?.skipped)) {
        setState((s) => ({
          ...s, phase: 'error',
          error: 'الجهاز مشغول بمزامنة أخرى قيد التنفيذ حالياً — حاول مرة أخرى بعد قليل',
        }));
        return;
      }

      const anySuccess = list.some((r) => r?.success === true);
      const anyPartial = list.some((r) => r?.partial === true);
      const allFailed = list.length > 0 && list.every((r) => r?.success === false || r?.error);

      if (allFailed) {
        const first = list.find((r) => r?.error) || list.find((r) => r?.reason);
        setState((s) => ({ ...s, phase: 'error', error: first?.error || first?.reason || 'تعذر الاتصال بالجهاز' }));
        return;
      }

      // "Refreshing Dashboard..." is a REAL step, not a cosmetic delay — it is
      // the caller's own data reload, awaited here so success can never
      // display while the grid still shows stale data.
      setState((s) => (isCurrent() ? { ...s, currentStep: 'refreshing-dashboard' } : s));
      if (reload) await reload();
      if (!isCurrent()) return;

      const downloaded = list.reduce((sum, r) => sum + (r?.total ?? 0), 0);
      const imported    = list.reduce((sum, r) => sum + (r?.count ?? 0), 0);
      const duplicates  = list.reduce((sum, r) => sum + (r?.duplicates ?? 0), 0);
      const failed      = list.reduce((sum, r) => sum + (r?.invalid ?? 0), 0);
      const duration    = Date.now() - startedAt;

      setState((s) => ({
        ...s,
        phase: anySuccess && !anyPartial ? 'success' : 'partial',
        result: {
          downloaded, imported, duplicates, failed, duration,
          reason: list.find((r) => r?.reason)?.reason || null,
          deviceCount: list.length,
        },
      }));
    } catch (err) {
      if (!isCurrent()) return;
      setState((s) => ({ ...s, phase: 'error', error: err?.response?.data?.error || err?.message || 'فشل الاتصال بالخادم' }));
    } finally {
      socket.off('device:sync-step', onStep);
      unsubStatus();
      if (isCurrent()) runningRef.current = false;
    }
  }, []);

  const retry = useCallback(() => {
    if (lastRunRef.current) run(lastRunRef.current);
  }, [run]);

  const close = useCallback(() => {
    // A close while still running never cancels the real backend sync (it
    // has no cancellation path, by design — see zktecoService.js's
    // syncLocks) — it only hides the modal; the button stays disabled via
    // isRunning() until the in-flight request genuinely finishes.
    setState((s) => ({ ...s, open: false }));
  }, []);

  return { state, run, retry, close, isRunning: () => runningRef.current };
}

export { STEP_ORDER };
