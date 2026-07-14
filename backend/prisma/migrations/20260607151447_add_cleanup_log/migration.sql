-- CreateTable
CREATE TABLE `cleanup_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `fromDate` DATE NOT NULL,
    `toDate` DATE NOT NULL,
    `dataTypes` VARCHAR(191) NOT NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'completed',
    `rawLogsDeleted` INTEGER NOT NULL DEFAULT 0,
    `dailyDeleted` INTEGER NOT NULL DEFAULT 0,
    `payrollDeleted` INTEGER NOT NULL DEFAULT 0,
    `employeesAffected` INTEGER NOT NULL DEFAULT 0,
    `backupTaken` BOOLEAN NOT NULL DEFAULT false,
    `recalcTriggered` BOOLEAN NOT NULL DEFAULT false,
    `optimizeRun` BOOLEAN NOT NULL DEFAULT false,
    `durationMs` INTEGER NOT NULL DEFAULT 0,
    `executedByName` VARCHAR(191) NOT NULL,
    `notes` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cleanup_logs_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

