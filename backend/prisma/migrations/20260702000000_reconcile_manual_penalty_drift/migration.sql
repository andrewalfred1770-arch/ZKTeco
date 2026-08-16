-- Reconcile pre-existing db-push drift on `attendance_daily`.
--
-- manualEarlyPenaltyUnits, manualLatePenaltyUnits, manualPenaltyAt,
-- manualPenaltyBy, manualPenaltyByName, manualPenaltyReason are declared in
-- schema.prisma and are actively read/written by attendanceEngine.js,
-- manualEditAudit.js, attendanceRow.js and the daily/movement/manual/monthly
-- attendance routes — but no migration in this history ever created them.
-- They reached already-running databases out-of-band (prisma db push)
-- sometime before 20260704102908_add_condition_deduction_units, whose
-- `ADD COLUMN manualConditionUnits ... AFTER manualEarlyPenaltyUnits` clause
-- silently depends on manualEarlyPenaltyUnits already being present.
--
-- Any database that only ever ran `prisma migrate deploy` from zero (no db
-- push in its history — e.g. a fresh Mac Standalone install) never gets the
-- column and 20260704102908 fails with MySQL 1054 (P3018).
--
-- Guarded with information_schema checks so this is a genuine no-op on every
-- already-drifted database (dev/Windows Server) that already carries these
-- columns, and only backfills them on a database that is missing them.
SET @db := DATABASE();

SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = @db AND table_name = 'attendance_daily' AND column_name = 'manualEarlyPenaltyUnits') = 0,
  'ALTER TABLE `attendance_daily` ADD COLUMN `manualEarlyPenaltyUnits` DOUBLE NULL',
  'SELECT 1'
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = @db AND table_name = 'attendance_daily' AND column_name = 'manualLatePenaltyUnits') = 0,
  'ALTER TABLE `attendance_daily` ADD COLUMN `manualLatePenaltyUnits` DOUBLE NULL',
  'SELECT 1'
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = @db AND table_name = 'attendance_daily' AND column_name = 'manualPenaltyAt') = 0,
  'ALTER TABLE `attendance_daily` ADD COLUMN `manualPenaltyAt` DATETIME(3) NULL',
  'SELECT 1'
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = @db AND table_name = 'attendance_daily' AND column_name = 'manualPenaltyBy') = 0,
  'ALTER TABLE `attendance_daily` ADD COLUMN `manualPenaltyBy` INTEGER NULL',
  'SELECT 1'
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = @db AND table_name = 'attendance_daily' AND column_name = 'manualPenaltyByName') = 0,
  'ALTER TABLE `attendance_daily` ADD COLUMN `manualPenaltyByName` VARCHAR(191) NULL',
  'SELECT 1'
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = @db AND table_name = 'attendance_daily' AND column_name = 'manualPenaltyReason') = 0,
  'ALTER TABLE `attendance_daily` ADD COLUMN `manualPenaltyReason` TEXT NULL',
  'SELECT 1'
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
