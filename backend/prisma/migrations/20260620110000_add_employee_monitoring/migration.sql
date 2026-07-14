-- Add isMonitored and monitorColor to employees
ALTER TABLE `employees`
  ADD COLUMN `isMonitored` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN `monitorColor` VARCHAR(20) NULL;
