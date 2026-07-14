-- CreateTable
CREATE TABLE `historical_rebuild_jobs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `fromDate` DATE NOT NULL,
    `toDate` DATE NOT NULL,
    `employeeId` INTEGER NULL,
    `status` VARCHAR(191) NOT NULL DEFAULT 'running',
    `cursorEmployeeId` INTEGER NULL,
    `cursorDate` DATE NULL,
    `totalEmployees` INTEGER NOT NULL DEFAULT 0,
    `processedEmployees` INTEGER NOT NULL DEFAULT 0,
    `processedDates` INTEGER NOT NULL DEFAULT 0,
    `errorCount` INTEGER NOT NULL DEFAULT 0,
    `lastError` TEXT NULL,
    `triggeredBy` VARCHAR(191) NOT NULL DEFAULT 'manual',
    `reason` TEXT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `historical_rebuild_jobs_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
