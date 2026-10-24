// Mock of src/lib/api.js for the isolated renderer tests: answers GETs from globalThis.__API_FIXTURES, never touches a network.
const fixtures = () => globalThis.__API_FIXTURES || {};
const respond = (url) => {
  const key = Object.keys(fixtures()).find((k) => String(url).startsWith(k));
  if (key && fixtures()[key] === '__FAIL__') return Promise.reject(Object.assign(new Error('Network Error'), { code: 'ERR_NETWORK' }));   // simulates an unreachable server
  return Promise.resolve({ data: key ? fixtures()[key] : [], status: 200 });
};
const api = {
  get: (url) => respond(url),
  post: () => Promise.resolve({ data: {}, status: 200 }),
  put: () => Promise.resolve({ data: {}, status: 200 }),
  patch: () => Promise.resolve({ data: {}, status: 200 }),
  delete: () => Promise.resolve({ data: {}, status: 200 }),
  defaults: { baseURL: '' },
  interceptors: { request: { use() {} }, response: { use() {} } },
};
export const LONG_OP = { timeout: 600000 };
export function setAuthToken() {}
export function setUnauthorizedHandler() {}
export function setSessionBlocked() {}
export default api;
