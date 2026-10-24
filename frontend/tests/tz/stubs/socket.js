// Mock of src/lib/socket.js for the isolated renderer tests: an inert socket, no network.
const sock = { on() {}, off() {}, emit() {}, connected: false, io: { on() {}, off() {} } };
export function getSocket() { return sock; }
export function getConnectionStatus() { return 'connected'; }
export function subscribeConnectionStatus() { return () => {}; }
export function shouldBlockWrites() { return false; }
export function retryConnectionNow() {}
export function setSocketUnauthorizedHandler() {}
export function setSocketAuthToken() {}
export function createReconnectScheduler() { return { cancel() {}, state() { return {}; } }; }
export function __setReconnectPolicyForTests() {}
export function __reconnectState() { return {}; }
export default sock;
