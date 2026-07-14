-- CreateTable
CREATE TABLE `attendance_adjustments` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `attendanceDailyId` INTEGER NOT NULL,
    `employeeId` INTEGER NOT NULL,
    `date` DATE NOT NULL,
    `snapCheckIn` VARCHAR(191) NULL,
    `snapCheckOut` VARCHAR(191) NULL,
    `snapWorkedMinutes` INTEGER NOT NULL DEFAULT 0,
    `snapLateMinutes` INTEGER NOT NULL DEFAULT 0,
    `snapOvertimeHours` DOUBLE NOT NULL DEFAULT 0,
    `snapMorningOT` DOUBLE NOT NULL DEFAULT 0,
    `snapEveningOT` DOUBLE NOT NULL DEFAULT 0,
    `snapLatePenalty` DOUBLE NOT NULL DEFAULT 0,
    `snapEarlyPenalty` DOUBLE NOT NULL DEFAULT 0,
    `snapTotalDeductions` DOUBLE NOT NULL DEFAULT 0,
    `snapStatus` VARCHAR(191) NOT NULL DEFAULT 'present',
    `snapIsAbsent` BOOLEAN NOT NULL DEFAULT false,
    `adjCheckIn` VARCHAR(191) NULL,
    `adjCheckOut` VARCHAR(191) NULL,
    `adjWorkedMinutes` INTEGER NULL,
    `adjLateMinutes` INTEGER NULL,
    `adjOvertimeHours` DOUBLE NULL,
    `adjMorningOT` DOUBLE NULL,
    `adjEveningOT` DOUBLE NULL,
    `adjLatePenalty` DOUBLE NULL,
    `adjEarlyPenalty` DOUBLE NULL,
    `adjTotalDeductions` DOUBLE NULL,
    `adjStatus` VARCHAR(191) NULL,
    `adjIsAbsent` BOOLEAN NULL,
    `ignoreLate` BOOLEAN NOT NULL DEFAULT false,
    `ignoreEarlyLeave` BOOLEAN NOT NULL DEFAULT false,
    `forcePresent` BOOLEAN NOT NULL DEFAULT false,
    `approvalStatus` VARCHAR(191) NOT NULL DEFAULT 'pending',
    `reason` TEXT NULL,
    `hrComment` TEXT NULL,
    `approvedBy` INTEGER NULL,
    `approvedByName` VARCHAR(191) NULL,
    `approvedAt` DATETIME(3) NULL,
    `createdBy` INTEGER NOT NULL DEFAULT 0,
    `createdByName` VARCHAR(191) NULL,
    `createdByRole` VARCHAR(191) NOT NULL DEFAULT 'system',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `attendance_adjustments_attendanceDailyId_key`(`attendanceDailyId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `adjustment_audit_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `adjustmentId` INTEGER NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `fieldName` VARCHAR(191) NULL,
    `oldValue` TEXT NULL,
    `newValue` TEXT NULL,
    `changedBy` INTEGER NOT NULL DEFAULT 0,
    `changedByName` VARCHAR(191) NULL,
    `changedByRole` VARCHAR(191) NOT NULL DEFAULT 'system',
    `reason` TEXT NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `attendance_adjustments` ADD CONSTRAINT `attendance_adjustments_attendanceDailyId_fkey` FOREIGN KEY (`attendanceDailyId`) REFERENCES `attendance_daily`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attendance_adjustments` ADD CONSTRAINT `attendance_adjustments_employeeId_fkey` FOREIGN KEY (`employeeId`) REFERENCES `employees`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `adjustment_audit_logs` ADD CONSTRAINT `adjustment_audit_logs_adjustmentId_fkey` FOREIGN KEY (`adjustmentId`) REFERENCES `attendance_adjustments`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
