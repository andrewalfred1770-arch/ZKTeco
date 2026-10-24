// Mock of 'xlsx' for the isolated renderer tests: records the file name passed to writeFile, writes nothing.
const sheet = new Proxy({}, { get: () => () => ({}) });
export const utils = new Proxy({}, { get: (_t, k) => (k === 'book_new' ? () => ({ SheetNames: [], Sheets: {} }) : () => ({ '!ref': 'A1', '!cols': [], '!merges': [], '!rows': [] })) });
export function writeFile(_wb, name) { globalThis.__WRITTEN_FILES = [...(globalThis.__WRITTEN_FILES || []), name]; }
export default { utils, writeFile, sheet };
