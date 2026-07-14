import { io as socketIO } from 'socket.io-client';

// Connection Layer (EP-003 Hybrid Client/Server): same backendBaseUrl
// resolution as lib/api.js — Local Mode or Server Mode, the socket connects
// to whichever backend the main process resolved at startup. Shared here so
// every page that needs live updates reuses ONE connection instead of
// opening a new socket per mounted page.
const backendBase = window.electron?.backendBaseUrl
  ?? (window.electron?.backendPort ? `http://localhost:${window.electron.backendPort}` : 'http://localhost:5000');

let socket = null;

/** Lazily create (once) and return the shared Socket.IO client. */
export function getSocket() {
  if (!socket) {
    socket = socketIO(backendBase, { transports: ['websocket', 'polling'] });
  }
  return socket;
}
