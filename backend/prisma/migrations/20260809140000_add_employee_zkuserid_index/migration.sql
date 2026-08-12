-- Phase 23.1: assertActiveNumberAvailable() now locks
-- `WHERE code = ? OR zkUserId = ?` inside a transaction on every employee
-- create/update. `code` already has an index (Phase 22.4); `zkUserId` had
-- none — an unindexed OR-branch under FOR UPDATE risks a full-table scan
-- (and full-table lock) instead of a narrow row/gap lock. Purely additive,
-- no uniqueness implied (duplicates remain possible at the DB layer;
-- uniqueness-among-active is enforced in application code, same as code).
CREATE INDEX `employees_zkuserid_idx` ON `employees`(`zkUserId`);
