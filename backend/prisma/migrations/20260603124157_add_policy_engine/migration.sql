-- AlterTable
ALTER TABLE `attendance_daily` ADD COLUMN `earlyCheckoutUnits` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `eveningOvertimeHours` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `latePenaltyUnits` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `morningOvertimeHours` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `totalDeductionUnits` DOUBLE NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE `employees` ADD COLUMN `policyId` INTEGER NULL;

-- AlterTable
ALTER TABLE `payrolls` ADD COLUMN `eveningOTHours` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `morningOTHours` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `penaltyAmount` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `penaltyUnits` DOUBLE NOT NULL DEFAULT 0,
    ADD COLUMN `totalOTHours` DOUBLE NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `attendance_policies` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NULL,
    `shiftStartTime` VARCHAR(191) NOT NULL DEFAULT '09:00',
    `shiftEndTime` VARCHAR(191) NOT NULL DEFAULT '17:00',
    `morningOTStart` VARCHAR(191) NOT NULL DEFAULT '06:00',
    `eveningOTEnd` VARCHAR(191) NOT NULL DEFAULT '23:59',
    `otToleranceMin` INTEGER NOT NULL DEFAULT 10,
    `workHoursPerDay` DOUBLE NOT NULL DEFAULT 8,
    `isDefault` BOOLEAN NOT NULL DEFAULT false,
    `branchId` INTEGER NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `penalty_rules` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `policyId` INTEGER NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `fromMinute` INTEGER NOT NULL,
    `toMinute` INTEGER NOT NULL,
    `deductionUnits` DOUBLE NOT NULL,
    `label` VARCHAR(191) NULL,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `employees` ADD CONSTRAINT `employees_policyId_fkey` FOREIGN KEY (`policyId`) REFERENCES `attendance_policies`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_policies` ADD CONSTRAINT `attendance_policies_branchId_fkey` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `penalty_rules` ADD CONSTRAINT `penalty_rules_policyId_fkey` FOREIGN KEY (`policyId`) REFERENCES `attendance_policies`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
