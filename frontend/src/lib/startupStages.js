/**
 * startupStages — turns the REAL snapshot from GET /api/startup-status into what the startup screen may claim.
 *
 * Rule: a step is shown as done only when the backend itself reported it. A missing snapshot (the request failed or timed out)
 * means "nothing verified yet" — never a guess, never a fake percentage. Progress is the COUNT of verified steps, nothing else.
 *
 *   snapshot = { dbConnected, servicesStarted, devices: { total, connected }, ready, startup?: { phase, stage?, reason? } } | null
 */
export const STEP_IDS = ['server', 'database', 'services'];

export function deriveStages(snapshot) {
  const s = snapshot && typeof snapshot === 'object' ? snapshot : null;
  const done = {
    server: s !== null,                                  // the server answered this request
    database: s?.dbConnected === true,                   // reported by the backend after a real connection check
    services: s?.servicesStarted === true,               // sync scheduler + realtime listeners were launched
  };
  const total = Number(s?.devices?.total ?? 0);
  const connected = Number(s?.devices?.connected ?? 0);
  // Device link is informational (a slow or offline device must never hold the app back) and is only reported once services started.
  const devices = done.services ? { total: Number.isFinite(total) ? total : 0, connected: Number.isFinite(connected) ? connected : 0 } : null;
  const startup = s?.startup && typeof s.startup === 'object' ? s.startup : null;
  const blocked = !!(startup && (startup.stage || startup.reason) && startup.phase && startup.phase !== 'initializing');
  return {
    done,
    count: STEP_IDS.filter((id) => done[id]).length,
    total: STEP_IDS.length,
    devices,
    blocked,
    blockedInfo: blocked ? { phase: startup.phase, stage: startup.stage || null, reason: startup.reason || null } : null,
  };
}
