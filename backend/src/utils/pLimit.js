/**
 * pLimit(concurrency) — bounds how many of the returned wrapped promises run
 * at once. No external dependency; used to cap DB round-trips fired via
 * Promise.all(items.map(...)) so they don't all hit the connection pool at
 * the same instant (Phase 24.1 — GET /api/payroll pool exhaustion fix).
 */
function pLimit(concurrency) {
  let active = 0;
  const queue = [];

  const runNext = () => {
    if (active >= concurrency || queue.length === 0) return;
    active++;
    const { fn, resolve, reject } = queue.shift();
    fn().then(resolve, reject).finally(() => {
      active--;
      runNext();
    });
  };

  return function limit(fn) {
    return new Promise((resolve, reject) => {
      queue.push({ fn, resolve, reject });
      runNext();
    });
  };
}

module.exports = { pLimit };
