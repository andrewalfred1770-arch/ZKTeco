-- AlterTable
ALTER TABLE `payrolls` ADD COLUMN `manualDeductionAdjustment` DOUBLE NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `manual_edit_audit_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `employeeId` INTEGER NOT NULL,
    `attendanceDailyId` INTEGER NULL,
    `payrollId` INTEGER NULL,
    `fieldName` VARCHAR(191) NOT NULL,
    `oldValue` TEXT NULL,
    `newValue` TEXT NULL,
    `reason` TEXT NULL,
    `modifiedBy` INTEGER NOT NULL DEFAULT 0,
    `modifiedByName` VARCHAR(191) NULL,
    `modifiedByRole` VARCHAR(191) NOT NULL DEFAULT 'hr',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `manual_edit_audit_logs_employeeId_idx`(`employeeId`),
    INDEX `manual_edit_audit_logs_attendanceDailyId_idx`(`attendanceDailyId`),
    INDEX `manual_edit_audit_logs_payrollId_idx`(`payrollId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `manual_edit_audit_logs` ADD CONSTRAINT `manual_edit_audit_logs_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
