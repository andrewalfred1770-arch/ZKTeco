-- Drop the orphaned `employees.hourlyRate` column.
--
-- 20260603095953_init created `employees`.`hourlyRate` DOUBLE NULL, but the
-- Employee model in schema.prisma has never declared it (only `payrolls`.
-- `hourlyRate` — a different, still-used column — exists in the schema). The
-- application cannot read or write it: Prisma never selects it, every
-- "hourlyRate" in the code is either Payroll.hourlyRate or the value computed
-- from Employee.salary (payrollEngine.computeRates), and prisma/seed.js — a
-- developer-only demo seeder that is never run automatically — is the sole place
-- that ever tried to set it. Databases built from migrations therefore carry a
-- permanently-NULL column that `prisma migrate diff` reports as drift.
--
-- Guarded twice so this can never lose information or fail:
--   * only when the column exists (no-op on a database that already lacks it);
--   * only when it holds NO non-NULL value (a database where someone stored data
--     in it out-of-band keeps its column untouched rather than silently losing it).
SET @db := DATABASE();

SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @db AND table_name = 'employees' AND column_name = 'hourlyRate');

SET @nn := 0;
SET @sql := IF(@has_col = 1,
  'SELECT COUNT(*) INTO @nn FROM `employees` WHERE `hourlyRate` IS NOT NULL',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

SET @sql := IF(@has_col = 1 AND @nn = 0,
  'ALTER TABLE `employees` DROP COLUMN `hourlyRate`',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
