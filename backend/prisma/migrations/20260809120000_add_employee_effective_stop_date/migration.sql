-- Phase 22.1: authoritative employee employment-period source.
-- Nullable, additive only — existing employees remain effectiveStopDate=NULL
-- (no backfill; historical stop dates are unknown and must not be guessed).
ALTER TABLE `employees` ADD COLUMN `effectiveStopDate` DATETIME(3) NULL;
