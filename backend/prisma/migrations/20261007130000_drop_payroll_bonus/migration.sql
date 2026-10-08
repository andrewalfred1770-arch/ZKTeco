-- Remove the retired Bonus feature: drop `payrolls`.`bonus`.
--
-- PETSHROW ERP has no Bonus component. The application no longer reads or writes
-- this column (schema.prisma no longer declares it; the net-salary formula is
-- basic + overtime - deductions - advances).
--
-- Historical amounts are never rewritten. `netSalary` on existing rows already
-- includes whatever bonus was stored at the time and is left exactly as it is.
--
-- Guarded so it can never lose information or fail (same pattern as
-- 20261005150000_drop_unused_employee_hourlyrate):
--   * only when the column exists (idempotent no-op on a database that already lacks it);
--   * only when no row holds a non-zero bonus. A database that does hold historical
--     bonus amounts keeps the (now unused, NOT NULL DEFAULT 0) column untouched, so
--     those figures stay available for audit instead of being silently destroyed.
SET @db := DATABASE();

SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @db AND table_name = 'payrolls' AND column_name = 'bonus');

SET @nz := 0;
SET @sql := IF(@has_col = 1,
  'SELECT COUNT(*) INTO @nz FROM `payrolls` WHERE `bonus` <> 0',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@has_col = 1 AND @nz = 0,
  'ALTER TABLE `payrolls` DROP COLUMN `bonus`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
