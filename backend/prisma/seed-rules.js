/**
 * seed-rules.js — default rules for the Dynamic Rules Engine.
 *
 * Idempotent: upsert by unique `key`. On create the full row is written; on
 * re-run only the *definition* metadata (name/category/type/unit/description/
 * conditionJson) is refreshed — a user's edited `value`, `priority`, and
 * `isActive` are preserved.
 *
 * Engine keys (work_start, late_grace, overtime_rounding, overtime_multiplier,
 * weekend_days, min_work_hours, absence_deduct_days, overtime_cap_hours,
 * early_leave_grace, late_penalty_per_minute) mirror today's DEFAULT_RULES in
 * rulesEngine.js so payroll/attendance behaviour is unchanged after seeding.
 *
 *   node prisma/seed-rules.js
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

// key, name, category, type, value, unit, priority, appliesTo, description, conditionJson?
const RULES = [
  // ── Attendance ─────────────────────────────────────────────────────────────
  ['work_start',        'وقت بداية الدوام',        'attendance', 'time',    '09:00', '',       50, 'all', 'الوقت الرسمي لبدء العمل'],
  ['work_end',          'وقت نهاية الدوام',         'attendance', 'time',    '17:00', '',       50, 'all', 'الوقت الرسمي لانتهاء العمل'],
  ['late_grace',        'فترة سماح التأخير',        'attendance', 'number',  '20',    'دقيقة',  40, 'all', 'الدقائق المسموح بها بعد بداية الدوام قبل احتساب التأخير'],
  ['late_limit',        'حد التأخير المسموح',       'attendance', 'number',  '30',    'دقيقة',  30, 'all', 'أقصى تأخير قبل تطبيق الجزاء'],
  ['min_work_hours',    'أقل ساعات عمل',            'attendance', 'number',  '4',     'ساعة',   30, 'all', 'الحد الأدنى لساعات العمل لاعتبار اليوم حضورًا'],
  ['mark_absent_below', 'اعتبار اليوم غياب',        'attendance', 'number',  '2',     'ساعة',   20, 'all', 'إذا قلّت ساعات العمل عن هذا الحد يُعتبر اليوم غيابًا'],
  ['break_minutes',     'وقت البريك',               'attendance', 'number',  '60',    'دقيقة',  10, 'all', 'مدة الاستراحة المسموح بها يوميًا'],
  ['early_leave_grace', 'سماح الانصراف المبكر',     'attendance', 'number',  '0',     'دقيقة',  10, 'all', 'الدقائق المسموح بها قبل انتهاء الدوام'],
  ['weekend_days',      'أيام الإجازة الأسبوعية',   'attendance', 'text',    '',      '',       10, 'all', 'أرقام الأيام: 0=الأحد، 5=الجمعة، 6=السبت (فارغ = لا يوجد يوم إجازة أسبوعية تلقائي)'],
  ['checkin_window_start', 'بداية نافذة الحضور',    'attendance', 'time',    '05:00', '',       15, 'all', 'بداية الفترة التي يمكن أن تُعتبر فيها البصمة "حضور" — أي بصمة بعدها تُعتبر "انصراف" فقط'],
  ['checkin_window_end',   'نهاية نافذة الحضور',    'attendance', 'time',    '12:00', '',       15, 'all', 'نهاية الفترة التي يمكن أن تُعتبر فيها البصمة "حضور" — أي بصمة بعدها تُعتبر "انصراف" فقط'],

  // ── Overtime ───────────────────────────────────────────────────────────────
  ['overtime_start',      'بداية احتساب الإضافي',   'overtime', 'time',    '17:00', '',        40, 'all', 'الوقت الذي يبدأ بعده احتساب الإضافي المسائي'],
  ['overtime_rounding',   'وحدة احتساب الإضافي',    'overtime', 'number',  '50',    'دقيقة',   40, 'all', 'كل N دقيقة = ساعة إضافي (مثال: 50 دقيقة = 1 ساعة)'],
  ['overtime_minimum',    'الحد الأدنى للإضافي',    'overtime', 'number',  '50',    'دقيقة',   30, 'all', 'أقل عدد دقائق لاحتساب أي إضافي'],
  ['overtime_multiplier', 'معامل الإضافي',          'overtime', 'number',  '1.5',   '×',       30, 'all', 'مضاعف أجر ساعة الإضافي'],
  ['overtime_cap_hours',  'أقصى إضافي يومي',        'overtime', 'number',  '0',     'ساعة/يوم',20, 'all', 'الحد الأقصى لساعات الإضافي اليومية (0 = بلا حد)'],
  ['friday_ot_multiplier','معامل إضافي الجمعة',     'overtime', 'number',  '2',     '×',       20, 'all', 'مضاعف أجر الإضافي يوم الجمعة'],
  ['holiday_ot_multiplier','معامل إضافي العطلات',   'overtime', 'number',  '2',     '×',       20, 'all', 'مضاعف أجر الإضافي في العطلات الرسمية'],

  // ── Deductions ─────────────────────────────────────────────────────────────
  ['late_penalty_per_minute', 'خصم التأخير',          'deductions', 'number', '0',   'لكل دقيقة', 40, 'all', 'قيمة الخصم عن كل دقيقة تأخير (0 = بلا خصم)'],
  ['absence_deduct_days',     'خصم الغياب',           'deductions', 'number', '1',   'يوم',       40, 'all', 'عدد الأيام المخصومة عن كل يوم غياب'],
  ['early_leave_penalty',     'خصم الانصراف المبكر',  'deductions', 'number', '1',   'وحدة/ساعة', 30, 'all', 'عدد وحدات الخصم عن كل ساعة انصراف مبكر'],
  ['half_day_deduction',      'خصم نصف يوم',          'deductions', 'number', '0.5', 'يوم',       20, 'all', 'قيمة خصم نصف اليوم'],
  ['advance_max_percent',     'أقصى نسبة سلفة',       'deductions', 'percentage', '50','%',       20, 'all', 'أقصى نسبة سلفة مسموح بها من الراتب الأساسي'],

  // ── Payroll ────────────────────────────────────────────────────────────────
  ['month_days',             'عدد أيام الشهر',        'payroll', 'number',  '30',  'يوم',   40, 'all', 'عدد الأيام المستخدم في حساب أجر اليوم'],
  ['working_days_per_month', 'أيام العمل في الشهر',   'payroll', 'number',  '22',  'يوم',   40, 'all', 'أيام العمل الفعلية في الشهر — للمعلومات فقط، لا يُستخدم في حسابات المرتبات (تستخدم المعادلة month_days)'],
  ['work_hours_per_day',     'ساعات العمل اليومية',   'payroll', 'number',  '8',   'ساعة',  40, 'all', 'عدد ساعات العمل في اليوم'],
  ['day_rate_formula',       'معادلة أجر اليوم',      'payroll', 'formula', 'salary / month_days', '', 30, 'all', 'طريقة حساب أجر اليوم'],
  ['hour_rate_formula',      'معادلة أجر الساعة',     'payroll', 'formula', 'salary / (working_days_per_month * work_hours_per_day)', '', 30, 'all', 'طريقة حساب أجر الساعة'],

  // ── Leaves ─────────────────────────────────────────────────────────────────
  ['annual_leave_days', 'رصيد الإجازة السنوية', 'leaves', 'number', '21', 'يوم', 20, 'all', '⚠️ غير مفعّلة بعد — تحتاج نظام إجازات (لا يوجد جدول إجازات في قاعدة البيانات حاليًا). القيمة محفوظة كإعداد فقط ولا تؤثر على أي حساب.'],
  ['sick_leave_days',   'رصيد الإجازة المرضية', 'leaves', 'number', '15', 'يوم', 20, 'all', '⚠️ غير مفعّلة بعد — تحتاج نظام إجازات (لا يوجد جدول إجازات في قاعدة البيانات حاليًا). القيمة محفوظة كإعداد فقط ولا تؤثر على أي حساب.'],

  // ── Penalties (condition-based examples) ─────────────────────────────────────
  ['penalty_excessive_late', 'جزاء التأخير الزائد', 'penalties', 'condition', '1', 'وحدة', 30, 'all',
    'تطبيق جزاء عند تجاوز حد التأخير', JSON.stringify({ field: 'lateMinutes', op: '>', value: 30 })],
  ['penalty_excessive_absence', 'جزاء كثرة الغياب', 'penalties', 'condition', '2', 'وحدة', 30, 'all',
    'تطبيق جزاء عند تجاوز عدد أيام الغياب', JSON.stringify({ field: 'absentDays', op: '>', value: 3 })],
  ['penalty_friday_absence', 'جزاء غياب الجمعة', 'penalties', 'condition', '1', 'وحدة', 20, 'all',
    'جزاء الغياب يوم الجمعة', JSON.stringify({ field: 'dayOfWeek', op: '==', value: 5 })],

  // ── Shifts ───────────────────────────────────────────────────────────────────
  ['night_shift_start', 'بداية الوردية الليلية', 'shifts', 'time',       '22:00', '', 20, 'all', 'وقت بداية الوردية الليلية'],
  ['night_shift_bonus', 'بدل الوردية الليلية',   'shifts', 'percentage', '10',    '%', 20, 'all', 'نسبة بدل العمل في الوردية الليلية'],
  ['friday_is_weekend', 'الجمعة إجازة',          'shifts', 'boolean',    'false', '',  10, 'all', 'هل يُعتبر يوم الجمعة إجازة أسبوعية؟ (السياسة الحالية: لا — الجمعة يوم عمل بإضافي خاص)'],

  // ── Holidays ───────────────────────────────────────────────────────────────
  ['holiday_pay_multiplier',  'أجر العطلة الرسمية',  'holidays', 'number', '2',   '×', 20, 'all', 'مضاعف الأجر عند العمل في عطلة رسمية'],
  ['weekend_work_multiplier', 'أجر العمل في العطلة الأسبوعية', 'holidays', 'number', '1.5', '×', 20, 'all', 'مضاعف الأجر عند العمل في الإجازة الأسبوعية'],
];

async function main() {
  let created = 0, refreshed = 0;
  for (const [key, name, category, type, value, unit, priority, appliesTo, description, conditionJson] of RULES) {
    const def = { name, category, type, unit, appliesTo, description, conditionJson: conditionJson || null };
    const existing = await prisma.rule.findUnique({ where: { key } });
    if (existing) {
      // Refresh definition metadata; preserve user-edited value/priority/isActive.
      await prisma.rule.update({ where: { key }, data: def });
      refreshed++;
    } else {
      await prisma.rule.create({
        data: { key, value, priority, isActive: true, createdByName: 'النظام', ...def },
      });
      created++;
    }
  }
  console.log(`✓ Rules seeded — ${created} created, ${refreshed} refreshed, ${RULES.length} total.`);
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
