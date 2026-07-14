-- EF-006.1 Finding: AttendanceDaily.date has no standalone index.
-- The only existing index (employeeId,date unique) can't serve date-only
-- lookups (e.g. dashboard "today" queries) since employeeId is the leading
-- column. Pure additive index — no data or semantic change.
CREATE INDEX `attendance_daily_date_idx` ON `attendance_daily`(`date`);
