// React shim for the isolated renderer tests (server rendering, no DOM).
// renderToString never runs effects and keeps no state between calls, so a page that loads its data in useEffect would always render
// its empty state. The tests render TWICE: pass 1 runs every effect once (the mocked API answers), pass 2 re-renders with the
// state those effects produced. useState is backed by an index-keyed store that survives between the two passes. This needs the
// hook call order to be identical in both passes, which holds for the pages under test.
import * as Real from 'REAL_REACT';
export * from 'REAL_REACT';

const store = [];
let counter = 0;
let pass = 1;
export function __resetPass(p) { counter = 0; pass = p; }
export function __clearStore() { store.length = 0; }

export function useState(init) {
  const i = counter++;
  if (!(i in store)) store[i] = typeof init === 'function' ? init() : init;
  const set = (v) => { store[i] = typeof v === 'function' ? v(store[i]) : v; };
  return [store[i], set];
}
function runOnce(fn) { if (pass === 1) { try { fn(); } catch { /* an effect failing must not hide the render */ } } }
export function useEffect(fn) { runOnce(fn); }
export function useLayoutEffect(fn) { runOnce(fn); }
export function useInsertionEffect(fn) { runOnce(fn); }

// useSyncExternalStore has no server snapshot in these client-only pages: read the current snapshot instead of throwing.
export function useSyncExternalStore(_subscribe, getSnapshot) { return getSnapshot(); }

const Default = { ...(Real.default || Real), useState, useEffect, useLayoutEffect, useInsertionEffect, useSyncExternalStore };
export default Default;
