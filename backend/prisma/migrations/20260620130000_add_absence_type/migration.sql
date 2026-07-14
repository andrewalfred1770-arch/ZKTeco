-- Add absence permission system fields to attendance_daily
-- absenceType: 'with_permission' | 'without_permission' | 'custom'
-- penaltyDays: deduction multiplier (1, 2, or custom number) — null defaults to 1 in engine
-- These fields survive every engine recompute because they are NOT in DAILY_RESET.

ALTER TABLE `attendance_daily`
  ADD COLUMN `absenceType`   VARCHAR(30)   NULL,
  ADD COLUMN `penaltyDays`   FLOAT         NULL,
  ADD COLUMN `absenceReason` TEXT          NULL,
  ADD COLUMN `absenceSetBy`  VARCHAR(200)  NULL,
  ADD COLUMN `absenceSetAt`  DATETIME(3)   NULL;
