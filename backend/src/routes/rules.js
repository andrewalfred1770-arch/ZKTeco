/**
 * /api/rules — Dynamic Rules Engine CRUD + audit trail.
 *
 * Backs the Rules page. Writes invalidate the ruleStore cache so the
 * attendance/payroll engines pick up changes immediately. Auth is disabled in
 * this build, so the audit actor comes from `changedByName` in the body
 * (defaults to "النظام").
 */
const router = require('express').Router();
const { getPrisma } = require('../utils/prisma');
const moment = require('moment');
const { authenticate, authorize } = require('../middleware/auth');
const ruleStore = require('../services/ruleStore');
const { validateRuleValue } = require('../utils/ruleValidation');
const recalcEngine = require('../engines/recalcEngine');
const ruleDependencyMap = require('../engines/ruleDependencyMap');

const prisma = getPrisma();
router.use(authenticate, authorize('admin', 'hr'));

/**
 * Single entry point for "a rule changed" — invalidate the cache, notify every
 * connected client immediately (live runtime update, no refresh needed), and
 * schedule a scoped recalculation of the current month's stored data so
 * Attendance/Payroll screens reflect the new rule without a manual click.
 */
function ruleChanged(io, { keys, action, scope }) {
  ruleStore.invalidate();
  if (io) io.emit('rules:changed', { keys, action, scope: scope || 'all', at: new Date() });
  const affects = [...new Set(keys.flatMap(k => ruleDependencyMap[k]?.affects || []))];
  recalcEngine.scheduleRecalc(
    scope && scope !== 'all' ? scope : {},
    io,
    `تعديل قاعدة: ${keys.join('، ')}${affects.length ? ` — يؤثر على: ${affects.join('، ')}` : ''}`,
  );
}

/** Resolve {branchId/departmentId/employeeId} from a rule's `appliesTo` + `conditionJson`, when present. */
function scopeFromRule(rule) {
  if (!rule || !rule.appliesTo || rule.appliesTo === 'all') return {};
  try {
    const cond = rule.conditionJson ? JSON.parse(rule.conditionJson) : null;
    if (cond?.branchId) return { branchId: parseInt(cond.branchId) };
    if (cond?.departmentId) return { departmentId: parseInt(cond.departmentId) };
    if (cond?.employeeId) return { employeeId: parseInt(cond.employeeId) };
  } catch { /* not a scoping condition — treat as global */ }
  return {};
}

// ─── Conflict prevention: formula cycles + duplicate-effect condition rules ──
const RULE_KEY_TOKEN = /[a-zA-Z_][a-zA-Z0-9_]*/g;

function reachable(graph, start, target, visited = new Set()) {
  if (start === target) return true;
  if (visited.has(start)) return false;
  visited.add(start);
  for (const next of (graph[start] || [])) {
    if (reachable(graph, next, target, visited)) return true;
  }
  return false;
}

/** True if saving `ruleKey = newValue` would create a circular formula reference (A → B → A). */
async function detectFormulaCycle(ruleKey, newValue) {
  const formulaRules = await prisma.rule.findMany({ where: { type: 'formula' }, select: { key: true, value: true } });
  const keys = new Set(formulaRules.map(r => r.key));
  keys.add(ruleKey);

  const graph = {};
  for (const r of formulaRules) {
    const val = r.key === ruleKey ? newValue : (r.value || '');
    graph[r.key] = [...new Set((val.match(RULE_KEY_TOKEN) || []).filter(t => keys.has(t) && t !== r.key))];
  }
  if (!(ruleKey in graph)) {
    graph[ruleKey] = [...new Set((newValue || '').match(RULE_KEY_TOKEN) || [])].filter(t => keys.has(t) && t !== ruleKey);
  }
  return graph[ruleKey].some(dep => reachable(graph, dep, ruleKey));
}

/** Two condition rules have the same real-world effect if they test the same field with the same operator+value. */
function conditionsOverlap(a, b) {
  if (!a || !b || !a.field || !b.field) return false;
  return a.field === b.field && a.op === b.op && String(a.value) === String(b.value);
}

/** Find an existing ACTIVE condition rule (same scope) whose condition has the same effect as the proposed one. */
async function findDuplicateCondition(conditionJsonStr, appliesTo, excludeId) {
  let cond;
  try { cond = JSON.parse(conditionJsonStr || '{}'); } catch { return null; }
  if (!cond.field) return null;

  const candidates = await prisma.rule.findMany({
    where: {
      isActive: true,
      type: 'condition',
      appliesTo: appliesTo || 'all',
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { id: true, key: true, name: true, conditionJson: true },
  });
  for (const c of candidates) {
    let cCond;
    try { cCond = JSON.parse(c.conditionJson || '{}'); } catch { continue; }
    if (conditionsOverlap(cond, cCond)) return c;
  }
  return null;
}

const EDITABLE = ['name', 'category', 'type', 'value', 'unit', 'priority', 'isActive', 'appliesTo', 'conditionJson', 'description'];
const actor = (req) => (req.body && req.body.changedByName) || 'النظام';

async function audit(ruleId, ruleKey, action, fieldName, oldValue, newValue, changedByName) {
  await prisma.ruleAudit.create({
    data: {
      ruleId, ruleKey, action, fieldName,
      oldValue: oldValue == null ? null : String(oldValue),
      newValue: newValue == null ? null : String(newValue),
      changedByName,
    },
  });
}

// ─── List (filters: category, search, active) ────────────────────────────────
router.get('/', async (req, res) => {
  try {
    const { category, search, active } = req.query;
    const where = {};
    if (category && category !== 'all') where.category = category;
    if (active === 'true')  where.isActive = true;
    if (active === 'false') where.isActive = false;
    if (search) {
      where.OR = [
        { name: { contains: search } },
        { key:  { contains: search } },
        { description: { contains: search } },
      ];
    }
    const rules = await prisma.rule.findMany({
      where,
      orderBy: [{ category: 'asc' }, { priority: 'desc' }, { name: 'asc' }],
    });
    // Attach the real-world impact (screens/engines) from the dependency map — drives
    // the "🔗 يؤثر على:" chip list in RuleDrawer so editors see actual wiring, not guesses.
    res.json(rules.map(r => ({ ...r, affects: ruleDependencyMap[r.key]?.affects || [] })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Category counts ──────────────────────────────────────────────────────────
router.get('/categories', async (_req, res) => {
  try {
    const grouped = await prisma.rule.groupBy({ by: ['category'], _count: { _all: true } });
    const total  = await prisma.rule.count();
    const active = await prisma.rule.count({ where: { isActive: true } });
    res.json({
      total, active,
      categories: grouped.map(g => ({ category: g.category, count: g._count._all })),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Create ───────────────────────────────────────────────────────────────────
router.post('/', async (req, res) => {
  try {
    const { name, key, category, type, value, unit, priority, isActive, appliesTo, conditionJson, description } = req.body;
    if (!name || !key || !category) return res.status(400).json({ error: 'name, key, category required' });

    const exists = await prisma.rule.findUnique({ where: { key } });
    if (exists) return res.status(409).json({ error: `المفتاح "${key}" مستخدم بالفعل` });

    // ── Business validation (same reject-and-explain gate as PUT) ─────────────
    if (value != null && value !== '') {
      const allRules = await prisma.rule.findMany({ select: { key: true, value: true, isActive: true } });
      const violations = validateRuleValue({ key, type: type || 'number', name }, String(value), allRules);
      if (violations.length) {
        return res.status(400).json({ error: violations.join('\n'), violations });
      }
    }

    // ── Conflict prevention ────────────────────────────────────────────────────
    if (type === 'formula' && value) {
      if (await detectFormulaCycle(key, String(value))) {
        return res.status(400).json({ error: `تعريف دائري: معادلة "${key}" تشير إلى نفسها عبر سلسلة من المعادلات الأخرى` });
      }
    }
    if (type === 'condition' && conditionJson && isActive !== false) {
      const dup = await findDuplicateCondition(
        typeof conditionJson === 'string' ? conditionJson : JSON.stringify(conditionJson),
        appliesTo || 'all',
      );
      if (dup) {
        return res.status(409).json({ error: `تعارض: القاعدة "${dup.name}" (${dup.key}) تطبّق نفس الشرط بالفعل لنفس النطاق` });
      }
    }

    const rule = await prisma.rule.create({
      data: {
        name, key, category,
        type: type || 'number',
        value: value == null ? '' : String(value),
        unit: unit || null,
        priority: Number.isFinite(+priority) ? parseInt(priority) : 0,
        isActive: isActive !== false,
        appliesTo: appliesTo || 'all',
        conditionJson: conditionJson ? (typeof conditionJson === 'string' ? conditionJson : JSON.stringify(conditionJson)) : null,
        description: description || null,
        createdByName: actor(req),
      },
    });
    await audit(rule.id, rule.key, 'created', null, null, rule.value, actor(req));
    ruleChanged(req.io, { keys: [rule.key], action: 'created', scope: scopeFromRule(rule) });
    res.status(201).json(rule);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Update (per-field audit) ─────────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.rule.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Rule not found' });

    const data = {};
    const changes = [];
    for (const f of EDITABLE) {
      if (!(f in req.body)) continue;
      let next = req.body[f];
      if (f === 'priority') next = parseInt(next) || 0;
      else if (f === 'isActive') next = next === true || next === 'true';
      else if (f === 'conditionJson') next = next ? (typeof next === 'string' ? next : JSON.stringify(next)) : null;
      else if (f === 'value') next = next == null ? '' : String(next);
      const prev = existing[f];
      if (String(prev ?? '') !== String(next ?? '')) { data[f] = next; changes.push([f, prev, next]); }
    }
    if (!changes.length) return res.json(existing);

    // ── Business validation — the reject-and-explain gate. Never auto-correct:
    // an invalid value is refused with every violation spelled out, so no
    // invalid configuration can ever reach the Rules DB or the engines.
    if ('value' in data) {
      const allRules = await prisma.rule.findMany({ select: { key: true, value: true, isActive: true } });
      const violations = validateRuleValue(existing, data.value, allRules);
      if (violations.length) {
        return res.status(400).json({ error: violations.join('\n'), violations });
      }
    }

    // ── Conflict prevention (validate the EFFECTIVE post-update row) ──────────
    const effectiveType          = data.type ?? existing.type;
    const effectiveValue         = ('value' in data) ? data.value : existing.value;
    const effectiveConditionJson = ('conditionJson' in data) ? data.conditionJson : existing.conditionJson;
    const effectiveAppliesTo     = data.appliesTo ?? existing.appliesTo;
    const effectiveIsActive      = ('isActive' in data) ? data.isActive : existing.isActive;

    if (effectiveType === 'formula' && effectiveValue && (data.value !== undefined || data.type !== undefined)) {
      if (await detectFormulaCycle(existing.key, String(effectiveValue))) {
        return res.status(400).json({ error: `تعريف دائري: معادلة "${existing.key}" تشير إلى نفسها عبر سلسلة من المعادلات الأخرى` });
      }
    }
    if (effectiveType === 'condition' && effectiveConditionJson && effectiveIsActive
        && (data.conditionJson !== undefined || data.appliesTo !== undefined || data.isActive !== undefined || data.type !== undefined)) {
      const dup = await findDuplicateCondition(effectiveConditionJson, effectiveAppliesTo, id);
      if (dup) {
        return res.status(409).json({ error: `تعارض: القاعدة "${dup.name}" (${dup.key}) تطبّق نفس الشرط بالفعل لنفس النطاق` });
      }
    }

    const updated = await prisma.rule.update({ where: { id }, data });
    const by = actor(req);
    for (const [field, oldV, newV] of changes) {
      const action = field === 'isActive' ? (newV ? 'enabled' : 'disabled') : 'updated';
      await audit(id, existing.key, action, field, oldV, newV, by);
    }
    // Only a value/active/scope change actually affects calculations — metadata-only edits (name, description) don't need a recalc.
    const calcFields = changes.filter(([f]) => ['value', 'isActive', 'appliesTo', 'conditionJson', 'priority'].includes(f));
    if (calcFields.length) {
      ruleChanged(req.io, { keys: [updated.key], action: 'updated', scope: scopeFromRule(updated) });
    } else {
      ruleStore.invalidate();
    }
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Quick enable/disable ─────────────────────────────────────────────────────
router.patch('/:id/toggle', async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.rule.findUnique({ where: { id } });
    if (!existing) return res.status(404).json({ error: 'Rule not found' });
    const updated = await prisma.rule.update({ where: { id }, data: { isActive: !existing.isActive } });
    await audit(id, existing.key, updated.isActive ? 'enabled' : 'disabled', 'isActive', existing.isActive, updated.isActive, actor(req));
    ruleChanged(req.io, { keys: [updated.key], action: updated.isActive ? 'enabled' : 'disabled', scope: scopeFromRule(updated) });
    res.json(updated);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Delete ───────────────────────────────────────────────────────────────────
router.delete('/:id', authorize('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const existing = await prisma.rule.findUnique({ where: { id } });
    await prisma.rule.delete({ where: { id } }); // cascades RuleAudit
    if (existing) ruleChanged(req.io, { keys: [existing.key], action: 'deleted', scope: scopeFromRule(existing) });
    else ruleStore.invalidate();
    res.json({ message: 'Rule deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Audit trail for a rule ───────────────────────────────────────────────────
router.get('/:id/audit', async (req, res) => {
  try {
    const audits = await prisma.ruleAudit.findMany({
      where: { ruleId: parseInt(req.params.id) },
      orderBy: { changedAt: 'desc' },
    });
    res.json(audits);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── Manual full-history recalculation ("إعادة احتساب الفترة بالكامل") ────────
// Auto-recalc on rule change is scoped to the current month (cheap, immediate).
// Use this when historical attendance/payroll must reflect a rule that was
// just changed retroactively — explicit, admin-only, bounded by date range.
router.post('/recalculate-full', authorize('admin'), async (req, res) => {
  try {
    const { from, to, branchId, departmentId, employeeId } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'from, to required (YYYY-MM-DD)' });

    const f = moment(from), t = moment(to);
    if (!f.isValid() || !t.isValid() || t.isBefore(f)) {
      return res.status(400).json({ error: 'نطاق تاريخ غير صالح' });
    }

    const result = await recalcEngine.recalcScope({
      from: f.toDate(), to: t.toDate(),
      branchId: branchId ? parseInt(branchId) : undefined,
      departmentId: departmentId ? parseInt(departmentId) : undefined,
      employeeId: employeeId ? parseInt(employeeId) : undefined,
      io: req.io,
      reason: `إعادة احتساب يدوية للفترة ${f.format('YYYY-MM-DD')} → ${t.format('YYYY-MM-DD')} (${actor(req)})`,
    });
    res.json({ message: 'تم إعادة الاحتساب', ...result });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
