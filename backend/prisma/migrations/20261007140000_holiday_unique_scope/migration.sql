-- F-09: stop duplicate holidays (same date, same scope).
--
-- Adds `holidays`.`scopeKey` (= branchId, or 0 for an all-branches holiday) so a
-- unique index can cover the global scope too: MySQL treats NULLs as distinct, so
-- a unique index on (date, branchId) would never reject two global holidays.
--
-- Safe and idempotent:
--   * the column is added only if missing, and back-filled from branchId;
--   * the unique index is created only if it does not exist AND the existing data
--     has no (date, scopeKey) duplicate. Existing duplicate rows are NEVER deleted
--     or altered: on a database that already has some, the index is skipped (the
--     API still rejects new duplicates with HTTP 409) and the rows stay for the
--     owner to review.
SET @db := DATABASE();

SET @has_col := (SELECT COUNT(*) FROM information_schema.columns
  WHERE table_schema = @db AND table_name = 'holidays' AND column_name = 'scopeKey');
SET @sql := IF(@has_col = 0,
  'ALTER TABLE `holidays` ADD COLUMN `scopeKey` INTEGER NOT NULL DEFAULT 0',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;

UPDATE `holidays` SET `scopeKey` = IFNULL(`branchId`, 0) WHERE `scopeKey` <> IFNULL(`branchId`, 0);

SET @has_idx := (SELECT COUNT(*) FROM information_schema.statistics
  WHERE table_schema = @db AND table_name = 'holidays' AND index_name = 'holidays_date_scopeKey_key');
SET @dups := (SELECT COUNT(*) FROM (
  SELECT 1 FROM `holidays` GROUP BY `date`, `scopeKey` HAVING COUNT(*) > 1) d);
SET @sql := IF(@has_idx = 0 AND @dups = 0,
  'CREATE UNIQUE INDEX `holidays_date_scopeKey_key` ON `holidays`(`date`, `scopeKey`)',
  'SELECT 1');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
