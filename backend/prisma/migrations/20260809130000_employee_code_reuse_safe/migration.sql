-- Phase 22.4: allow a business-facing employee code to be reused by a NEW
-- employee once every existing employee holding it is stopped. Employee.id
-- remains the sole immutable relational identity everywhere (Payroll,
-- AttendanceDaily, Advance, audit logs all key on employeeId, never code) —
-- unaffected by this change. Uniqueness among ACTIVE employees is now
-- enforced at the application layer (transactional SELECT...FOR UPDATE in
-- backend/src/routes/employees.js), not by the database, since MySQL has no
-- filtered/partial unique index to express "unique only when status=true".
DROP INDEX `employees_code_key` ON `employees`;
CREATE INDEX `employees_code_idx` ON `employees`(`code`);
