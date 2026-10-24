// Per-launch secret for the backend's /api/setup/* (Database Setup Wizard) — Electron MAIN process side.
//
// Trust boundary: the secret exists only in this module's memory and in the backend child's memory. It is created at spawn, handed to the
// child over its private stdin pipe (not env, not argv, not a file, not the network), never sent to the renderer, and is never put on
// the wire either: each setup request carries an HMAC of (timestamp, nonce, method, path, body hash) keyed with it. The matching verifier
// is backend/src/utils/setupAuth.js — keep the two canonical forms identical (a parity test loads both).
//
// Hand-off acknowledgement: the child answers the hand-off with `[Setup] HANDOFF_ACK <tag>` on stdout, where tag is a truncated HMAC of a
// constant keyed with the secret (a one-way value: it reveals nothing usable about the secret and cannot be turned into a request MAC).
// Setup is only offered once that tag verified; the hand-off is retried a bounded number of times and then reported as FAILED.
import { randomBytes, createHmac, createHash, timingSafeEqual } from 'crypto';

let launchSecret = null;
let handoffState = 'none';   // none | pending | ready | failed   (applies to the CURRENT launchSecret)

export const ACK_PREFIX = '[Setup] HANDOFF_ACK ';
const ACK_RE = /\[Setup\] HANDOFF_ACK ([0-9a-f]{32})(?![0-9a-f])/g;

/** New 256-bit secret for one backend launch (replaces any previous one — never reused). */
export function createLaunchSecret() {
  launchSecret = randomBytes(32).toString('base64url');
  handoffState = 'pending';
  return launchSecret;
}
export function clearLaunchSecret(expected) {
  if (!expected || expected === launchSecret) { launchSecret = null; handoffState = 'none'; }
}
export function hasLaunchSecret() { return launchSecret !== null; }

/** 'none' (no secret) | 'pending' (handed over, not yet acknowledged) | 'ready' | 'failed' (not acknowledged within the bound). */
export function getHandoffState() { return launchSecret === null ? 'none' : handoffState; }
export function isSetupReady() { return getHandoffState() === 'ready'; }
export function markHandoffFailed(expected) { if (launchSecret !== null && (!expected || expected === launchSecret) && handoffState === 'pending') handoffState = 'failed'; }

/** The line written to the backend's stdin. Contains the secret: never log it. */
export function secretHandoffLine(secret) { return `setup-secret ${secret}\n`; }

/** Truncated one-way tag the backend prints to prove it holds THIS secret. Same derivation as backend/src/utils/setupAuth.js#ackTag. */
export function ackTagFor(secret) {
  return createHmac('sha256', secret).update('checkin-setup-handoff-ack-v1').digest('hex').slice(0, 32);
}

/**
 * Scans a chunk of the backend's stdout. Marks the hand-off acknowledged if it contains the correct tag for the current secret.
 * Returns the chunk with every ack line removed (so it is not logged). A wrong tag is ignored.
 */
export function consumeBackendOutput(chunk, expected = launchSecret) {
  const text = String(chunk);
  let matched = false;
  const cleaned = text.replace(ACK_RE, (_m, tag) => {
    if (expected && expected === launchSecret) {
      const want = Buffer.from(ackTagFor(expected));
      const got = Buffer.from(tag);
      if (want.length === got.length && timingSafeEqual(want, got)) matched = true;
    }
    return '';
  });
  if (matched && (handoffState === 'pending' || handoffState === 'failed')) handoffState = 'ready';   // a late ack (slow backend start) still counts
  return cleaned.replace(/\n{2,}/g, '\n').trim();
}

/**
 * Sends the hand-off line now and re-sends it (bounded) until the backend acknowledges. The backend accepts the SAME value repeatedly
 * (idempotent) and ignores any different one. After `maxAttempts` without an ack the launch is marked FAILED and onGiveUp() runs.
 * `write(line)` may throw; that counts as an unsuccessful attempt. Returns { cancel }.
 */
export function startHandoff({ write, secret, intervalMs = 2000, maxAttempts = 8, onGiveUp = () => {}, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let attempts = 0; let timer = null; let cancelled = false;
  const tick = () => {
    timer = null;
    if (cancelled || secret !== launchSecret) return;
    if (isSetupReady()) return;
    if (attempts >= maxAttempts) { markHandoffFailed(secret); try { onGiveUp(); } catch { /* no secret in any message */ } return; }
    attempts += 1;
    try { write(secretHandoffLine(secret)); } catch { /* counted; retried within the bound */ }
    timer = setTimer(tick, intervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  };
  tick();
  return { cancel() { cancelled = true; if (timer) clearTimer(timer); timer = null; } };
}

export function canonicalSetupMessage({ ts, nonce, method, path, bodyString }) {
  const bodyHash = createHash('sha256').update(bodyString).digest('hex');
  return `${ts}\n${nonce}\n${method.toUpperCase()}\n${path}\n${bodyHash}`;
}

/** Headers authenticating ONE request. `bodyString` must be exactly what the backend will parse ('{}' for a body-less request). Fails closed. */
export function signSetupRequest({ method, path, bodyString }, secret = launchSecret, now = Date.now) {
  if (!secret) throw new Error('setup authorization unavailable');
  const ts = String(now());
  const nonce = randomBytes(18).toString('base64url');
  const mac = createHmac('sha256', secret).update(canonicalSetupMessage({ ts, nonce, method, path, bodyString })).digest('hex');
  return { 'x-checkin-setup-ts': ts, 'x-checkin-setup-nonce': nonce, 'x-checkin-setup-mac': mac };
}
