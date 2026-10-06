-- Reconcile pre-existing drift on `manual_edit_audit_logs`.
--
-- ManualEditAuditLog.source (String? @default("inline-grid")) is declared in
-- schema.prisma and is written by utils/manualEditAudit.js writeAudit() and read
-- by GET /api/audit-logs — but 20260613090650_add_manual_edit_audit created the
-- table WITHOUT it, and no later migration added it. It only ever reached
-- databases that were brought up to date out-of-band (prisma db push); any
-- database built purely by `prisma migrate deploy` lacks the column, so the
-- audit-log query fails ("column ... source does not exist") and manual-edit
-- audit rows cannot be recorded there.
--
-- Same approach as 20260611120000 / 20260702000000: guarded with an
-- information_schema check so it is a genuine no-op on every database that
-- already carries the column, and adds it (NULL-able, default 'inline-grid',
-- exactly what Prisma generates for the field) only where it is missing.
-- Existing rows are untouched: ADD COLUMN with a DEFAULT only supplies the
-- default for them, and no data is rewritten.
SET @db := DATABASE();

SET @sql := (SELECT IF(
  (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = @db AND table_name = 'manual_edit_audit_logs' AND column_name = 'source') = 0,
  'ALTER TABLE `manual_edit_audit_logs` ADD COLUMN `source` VARCHAR(191) NULL DEFAULT ''inline-grid''',
  'SELECT 1'
));
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
