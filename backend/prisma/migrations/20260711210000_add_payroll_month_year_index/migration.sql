-- EF-006.2 Finding: Payroll.[month,year] has no usable index.
-- The only existing index (employeeId,month,year unique) can't serve
-- month/year-only lookups (e.g. GET /payroll list, /reports/payroll/export,
-- cleanup.js's month-range scans) since employeeId is the leading column and
-- is unconstrained in these queries. Confirmed via EXPLAIN: possible_keys was
-- null for both query shapes tested. Pure additive index — no data or
-- semantic change.
CREATE INDEX `payroll_month_year_idx` ON `payrolls`(`month`, `year`);
