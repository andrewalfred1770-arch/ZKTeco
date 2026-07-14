-- Migration: Remove Attendance Policy Engine
SET FOREIGN_KEY_CHECKS=0;

DROP TABLE IF EXISTS `penalty_rules`;
DROP TABLE IF EXISTS `attendance_policies`;

ALTER TABLE `employees` DROP FOREIGN KEY `employees_policyId_fkey`;
ALTER TABLE `employees` DROP COLUMN `policyId`;

SET FOREIGN_KEY_CHECKS=1;
