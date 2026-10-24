/**
 * fakeDb.js — a tiny in-memory stand-in for the Prisma client, for ISOLATED consistency tests only.
 * No database, no .env, no network. Supports exactly the where/include/select shapes the attendance + payroll
 * routes use (equality, in/notIn/not/gt/gte/lt/lte, OR/AND/NOT, relation filters `employee:{}` and `attendanceDaily:{some}`).
 */
const RELATIONS = {
  employee: {
    attendanceDaily: { table: 'attendanceDaily', fk: 'employeeId', many: true },
    payroll: { table: 'payroll', fk: 'employeeId', many: true },
    department: { table: 'department', local: 'departmentId' },
    branch: { table: 'branch', local: 'branchId' },
    shift: { table: 'shift', local: 'shiftId' },
  },
  attendanceDaily: { employee: { table: 'employee', local: 'employeeId' } },
  payroll: { employee: { table: 'employee', local: 'employeeId' } },
  advance: { employee: { table: 'employee', local: 'employeeId' } },
  attendanceAdjustment: { employee: { table: 'employee', local: 'employeeId' } },
};
const isDate = (v) => v instanceof Date;
const eq = (a, b) => (isDate(a) && isDate(b) ? a.getTime() === b.getTime() : a === b);
const cmp = (a, b) => (isDate(a) ? a.getTime() : a) - (isDate(b) ? b.getTime() : b);

function createFakeDb(seed = {}) {
  const tables = {};
  const t = (name) => (tables[name] ||= []);
  for (const [k, rows] of Object.entries(seed)) tables[k] = rows.map((r) => structuredClone(r));
  const nextId = {};
  const failures = [];   // { model, op, remaining, error } — injected write faults
  const maybeFail = (name, op) => {
    const f = failures.find((x) => x.model === name && x.op === op && x.remaining > 0);
    if (f) { f.remaining--; throw f.error; }
  };
  const stamp = (name, row) => { if (name === 'attendanceDaily') row.updatedAt = new Date(); };   // Prisma @updatedAt
  const writeLog = []; // every mutation, so tests can prove "a read did not write"

  function matches(model, row, where) {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;                  // Prisma ignores undefined filters
      if (key === 'OR') { if (!cond.some((w) => matches(model, row, w))) return false; continue; }
      if (key === 'AND') { if (!(Array.isArray(cond) ? cond : [cond]).every((w) => matches(model, row, w))) return false; continue; }
      if (key === 'NOT') { if ((Array.isArray(cond) ? cond : [cond]).some((w) => matches(model, row, w))) return false; continue; }
      const rel = RELATIONS[model] && RELATIONS[model][key];
      if (rel) {
        if (rel.many) {
          const kids = t(rel.table).filter((k) => k[rel.fk] === row.id);
          if (cond.some) { if (!kids.some((k) => matches(rel.table, k, cond.some))) return false; }
          else if (cond.none) { if (kids.some((k) => matches(rel.table, k, cond.none))) return false; }
          else if (!kids.some((k) => matches(rel.table, k, cond))) return false;
        } else {
          const parent = t(rel.table).find((p) => p.id === row[rel.local]);
          if (!parent || !matches(rel.table, parent, cond)) return false;
        }
        continue;
      }
      const v = row[key] === undefined ? null : row[key];
      if (cond === null) { if (v !== null) return false; continue; }
      if (isDate(cond) || typeof cond !== 'object') { if (!eq(v, cond)) return false; continue; }
      for (const [op, arg] of Object.entries(cond)) {
        if (op === 'equals') { if (!eq(v, arg)) return false; }
        else if (op === 'in') { if (!arg.some((a) => eq(v, a))) return false; }
        else if (op === 'notIn') { if (arg.some((a) => eq(v, a))) return false; }
        else if (op === 'not') { if (arg === null ? v === null : eq(v, arg)) return false; }
        else if (op === 'gte') { if (v === null || cmp(v, arg) < 0) return false; }
        else if (op === 'gt') { if (v === null || cmp(v, arg) <= 0) return false; }
        else if (op === 'lte') { if (v === null || cmp(v, arg) > 0) return false; }
        else if (op === 'lt') { if (v === null || cmp(v, arg) >= 0) return false; }
        else throw new Error(`fakeDb: unsupported operator ${op} on ${model}.${key}`);
      }
    }
    return true;
  }

  function attach(model, row, spec) {
    const out = structuredClone(row);
    if (!spec) return out;
    for (const [k, v] of Object.entries(spec)) {
      const rel = RELATIONS[model] && RELATIONS[model][k];
      if (!rel || !v) continue;
      if (rel.many) { out[k] = t(rel.table).filter((c) => c[rel.fk] === row.id).map((c) => structuredClone(c)); continue; }
      const parent = t(rel.table).find((p) => p.id === row[rel.local]);
      const sub = typeof v === 'object' ? (v.include || v.select || null) : null;
      out[k] = parent ? attach(rel.table, parent, sub) : (['department', 'branch', 'shift'].includes(k) ? { name: '' } : null);
    }
    return out;
  }

  function orderRows(rows, orderBy) {
    if (!orderBy) return rows;
    const pick = (r, ob) => { const [k, d] = Object.entries(ob)[0]; return typeof d === 'object' ? pick(r[k] || {}, d) : [r[k], d]; };
    return rows.sort((a, b) => {
      const [x, dir] = pick(a, orderBy); const [y] = pick(b, orderBy);
      const c = x < y ? -1 : x > y ? 1 : 0;
      return dir === 'desc' ? -c : c;
    });
  }

  const flattenUnique = (where) => {
    const w = { ...where };
    for (const [k, v] of Object.entries(w)) {
      if (v && typeof v === 'object' && !isDate(v) && /_/.test(k)) { delete w[k]; Object.assign(w, v); }
    }
    return w;
  };

  const model = (name, journal = null) => ({
    async findMany(args = {}) {
      let rows = t(name).filter((r) => matches(name, r, args.where));
      rows = orderRows(rows.slice(), args.orderBy);
      if (args.distinct) {
        const seen = new Set();
        rows = rows.filter((r) => { const k = args.distinct.map((f) => r[f]).join('|'); if (seen.has(k)) return false; seen.add(k); return true; });
      }
      if (args.take) rows = rows.slice(0, args.take);
      return rows.map((r) => attach(name, r, args.include || args.select));
    },
    async findFirst(args = {}) { return (await this.findMany({ ...args, take: 1 }))[0] || null; },
    async findUnique(args) {
      const r = t(name).find((x) => matches(name, x, flattenUnique(args.where)));
      return r ? attach(name, r, args.include || args.select) : null;
    },
    async count(args = {}) { return t(name).filter((r) => matches(name, r, args.where)).length; },
    async updateMany(args) {
      maybeFail(name, 'updateMany');
      const rows = t(name).filter((r) => matches(name, r, args.where));
      rows.forEach((r) => { if (journal) journal.push({ name, id: r.id, before: structuredClone(r) }); Object.assign(r, args.data); stamp(name, r); });
      if (rows.length) writeLog.push({ op: 'updateMany', model: name, ids: rows.map((r) => r.id), data: args.data });
      return { count: rows.length };
    },
    async update(args) {
      maybeFail(name, 'update');
      const r = t(name).find((x) => matches(name, x, flattenUnique(args.where)));
      if (!r) throw new Error(`fakeDb: ${name}.update target not found`);
      if (journal) journal.push({ name, id: r.id, before: structuredClone(r) });
      Object.assign(r, args.data); stamp(name, r); writeLog.push({ op: 'update', model: name, ids: [r.id], data: args.data });
      return structuredClone(r);
    },
    async create(args) {
      maybeFail(name, 'create');
      const key = flattenUnique({ ...args.data });
      if (name === 'payroll' && t(name).some((x) => x.employeeId === key.employeeId && x.month === key.month && x.year === key.year)) {
        const e = new Error('Unique constraint'); e.code = 'P2002'; throw e;
      }
      const row = { id: args.data.id ?? (nextId[name] = (nextId[name] || 1000) + 1), ...(name === 'payroll' ? { status: 'draft' } : {}), createdAt: new Date(), ...args.data };   // createdAt @default(now())
      stamp(name, row); if (journal) journal.push({ name, id: row.id, before: null }); t(name).push(structuredClone(row)); writeLog.push({ op: 'create', model: name, ids: [row.id], data: args.data });
      return structuredClone(row);
    },
    async upsert(args) {
      maybeFail(name, 'upsert');
      const r = t(name).find((x) => matches(name, x, flattenUnique(args.where)));
      return r ? this.update({ where: { id: r.id }, data: args.update }) : this.create({ data: args.create });
    },
    async delete(args) {
      const i = t(name).findIndex((x) => matches(name, x, flattenUnique(args.where)));
      if (i >= 0) { if (journal) journal.push({ name, id: t(name)[i].id, before: structuredClone(t(name)[i]) }); writeLog.push({ op: 'delete', model: name, ids: [t(name)[i].id] }); t(name).splice(i, 1); }
    },
  });

  const db = new Proxy({}, {
    get(_, prop) {
      if (prop === '_tables') return tables;
      if (prop === '_writeLog') return writeLog;
      if (prop === '_reset') {
        return (newSeed = {}) => {
          for (const k of Object.keys(tables)) delete tables[k];
          writeLog.length = 0;
          for (const [k, rows] of Object.entries(newSeed)) tables[k] = rows.map((r) => structuredClone(r));
        };
      }
      if (prop === '$on') return () => {};
      if (prop === '$connect' || prop === '$disconnect') return async () => {};
      if (prop === '_failNext') return (modelName, op, error = new Error('injected write failure'), times = 1) => failures.push({ model: modelName, op, remaining: times, error });
      if (prop === '_clearFailures') return () => { failures.length = 0; };
      if (prop === '$transaction') {
        return async (fn) => {
          if (typeof fn !== 'function') return Promise.all(fn);
          // like the real thing: a throw undoes what THIS transaction's client wrote — and only that (a write made through the shared
          // client during the transaction is NOT rolled back)
          const journal = [];
          const tx = new Proxy({}, { get(_, p) { if (p === '$queryRaw') return async () => []; if (typeof p === 'symbol' || p === 'then') return undefined; return model(String(p), journal); } });
          try { return await fn(tx); }
          catch (e) {
            for (const j of journal.reverse()) {
              const rows = t(j.name); const i = rows.findIndex((r) => r.id === j.id);
              if (j.before === null) { if (i >= 0) rows.splice(i, 1); } else if (i >= 0) rows[i] = j.before; else rows.push(j.before);
            }
            writeLog.push({ op: 'rollback' });
            throw e;
          }
        };
      }
      if (prop === '$queryRaw') return async () => [];
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return model(String(prop));
    },
  });
  return db;
}

module.exports = { createFakeDb };
