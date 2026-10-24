/**
 * socketScopes.js — role-scoped Socket.IO delivery (F7).
 *
 * Every event the backend emits (attendance, device, rules, cleanup, company-settings, rebuild …) is an operational/staff event.
 * With authentication ON, a connected socket receives them only if its account's CURRENT role (set by authenticateSocket from
 * users.role, not from the JWT claim) is a staff role: admin/hr join the 'staff' room, and broadcasts are delivered to that room
 * only. Any other role (employee) stays connected but receives no broadcast. Authentication OFF (desktop / LAN no-login mode)
 * keeps the original behaviour: every connected socket is a trusted operator.
 *
 * socketSessionGuard disconnects a socket whose role changed, so room membership cannot go stale.
 * Events are emitted only through `io.emit(...)` across the code base; installScopedEmit() routes that single call, so no
 * emitter has to change and a future emitter is scoped by default.
 */
const STAFF_ROOM = 'staff';
const STAFF_ROLES = ['admin', 'hr'];

function scopeFor(socket) {
  const role = socket && socket.user && socket.user.role;
  return STAFF_ROLES.includes(role) ? STAFF_ROOM : null;
}

/** Call once per connection (after authenticateSocket). Returns the room joined, or null. */
function joinScopes(socket, authEnabled) {
  if (!authEnabled) return null;
  const room = scopeFor(socket);
  if (room) socket.join(room);
  return room;
}

/** Replaces io.emit so broadcasts reach only the staff room when authentication is on. Idempotent. */
function installScopedEmit(io, authEnabled) {
  if (!authEnabled || io.__scopedEmit) return io;
  io.emit = (...args) => io.to(STAFF_ROOM).emit(...args);   // io.to(...) is a BroadcastOperator: it does not call io.emit again
  io.__scopedEmit = true;
  return io;
}

module.exports = { STAFF_ROOM, STAFF_ROLES, scopeFor, joinScopes, installScopedEmit };
