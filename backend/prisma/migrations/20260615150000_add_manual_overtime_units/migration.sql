-- AlterTable
ALTER TABLE `attendance_daily`
  ADD COLUMN `manualOvertimeUnits` DOUBLE NULL,
  ADD COLUMN `overtimeRulesUnits` DOUBLE NULL;
