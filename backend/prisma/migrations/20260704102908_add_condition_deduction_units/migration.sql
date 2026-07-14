-- Root-cause refactor: condition-rule evaluation gets an explicit day/month
-- scope, and every deduction unit that reduces net salary becomes an explicit,
-- HR-overridable, visible field (see plan: unify deduction calculations).

-- AttendanceDaily: day-scoped condition-rule result + its manual override slot
ALTER TABLE `attendance_daily`
  ADD COLUMN `conditionDeductionUnits` DOUBLE NOT NULL DEFAULT 0 AFTER `earlyCheckoutUnits`,
  ADD COLUMN `manualConditionUnits` DOUBLE NULL AFTER `manualEarlyPenaltyUnits`;

-- AttendanceAdjustment: HR override for the day-scoped condition penalty
ALTER TABLE `attendance_adjustments`
  ADD COLUMN `adjConditionUnits` DOUBLE NULL AFTER `adjEarlyPenalty`,
  ADD COLUMN `ignoreConditionUnits` BOOLEAN NOT NULL DEFAULT false AFTER `ignoreEarlyLeave`;

-- Payroll: explicit, visible month-scoped condition-rule line item
ALTER TABLE `payrolls`
  ADD COLUMN `conditionPenaltyUnits` DOUBLE NOT NULL DEFAULT 0 AFTER `penaltyAmount`,
  ADD COLUMN `conditionPenaltyAmount` DOUBLE NOT NULL DEFAULT 0 AFTER `conditionPenaltyUnits`;

-- Tag existing condition rules with an explicit scope so the same field name
-- (e.g. "lateMinutes") can never be reinterpreted across a day/month boundary
-- again. day = per-day context (attendanceEngine); month = monthly-aggregate
-- context (payrollEngine). Rules without a recognized key keep default day
-- scope via the application-level fallback in evaluateConditionRules().
UPDATE `rules`
  SET `conditionJson` = JSON_SET(COALESCE(`conditionJson`, '{}'), '$.scope', 'day')
  WHERE `key` IN ('penalty_excessive_late', 'penalty_friday_absence') AND `conditionJson` IS NOT NULL;

UPDATE `rules`
  SET `conditionJson` = JSON_SET(COALESCE(`conditionJson`, '{}'), '$.scope', 'month')
  WHERE `key` = 'penalty_excessive_absence' AND `conditionJson` IS NOT NULL;
