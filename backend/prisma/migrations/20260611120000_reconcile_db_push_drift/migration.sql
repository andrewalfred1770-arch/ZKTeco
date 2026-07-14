-- AlterTable
ALTER TABLE `devices` ADD COLUMN `autoSync` BOOLEAN NOT NULL DEFAULT true,
    ADD COLUMN `consecutiveErrors` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `deviceNumber` INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN `errorMessage` VARCHAR(191) NULL,
    ADD COLUMN `isArchived` BOOLEAN NOT NULL DEFAULT false,
    ADD COLUMN `lastPullTotal` INTEGER NULL,
    ADD COLUMN `lastSuccessfulTimestamp` DATETIME(3) NULL,
    ADD COLUMN `lastSyncCount` INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN `syncInterval` INTEGER NOT NULL DEFAULT 5,
    ADD COLUMN `totalLogsCount` INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE `company_setting_audits` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `settingKey` VARCHAR(191) NOT NULL,
    `action` VARCHAR(191) NOT NULL,
    `oldValue` TEXT NULL,
    `newValue` TEXT NULL,
    `changedByName` VARCHAR(191) NOT NULL,
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `company_settings` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `key` VARCHAR(191) NOT NULL,
    `value` TEXT NULL,
    `type` VARCHAR(191) NOT NULL DEFAULT 'text',
    `updatedBy` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `company_settings_key_key`(`key` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `device_sync_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `deviceId` INTEGER NOT NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `completedAt` DATETIME(3) NULL,
    `newLogs` INTEGER NOT NULL DEFAULT 0,
    `totalLogs` INTEGER NOT NULL DEFAULT 0,
    `status` VARCHAR(191) NOT NULL DEFAULT 'running',
    `error` VARCHAR(191) NULL,
    `duration` INTEGER NULL,
    `triggeredBy` VARCHAR(191) NOT NULL DEFAULT 'auto',
    `convergencePasses` INTEGER NULL,
    `dbTotal` INTEGER NULL,
    `duplicateCount` INTEGER NULL,
    `invalidCount` INTEGER NULL,
    `newestTimestamp` DATETIME(3) NULL,
    `oldestTimestamp` DATETIME(3) NULL,
    `returnedCount` INTEGER NULL,
    `skippedOldCount` INTEGER NULL,
    `zkErr` VARCHAR(191) NULL,

    INDEX `device_sync_logs_deviceId_fkey`(`deviceId` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rule_audits` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `ruleId` INTEGER NOT NULL,
    `ruleKey` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `fieldName` VARCHAR(191) NULL,
    `oldValue` TEXT NULL,
    `newValue` TEXT NULL,
    `changedByName` VARCHAR(191) NULL DEFAULT 'النظام',
    `changedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `rule_audits_ruleId_idx`(`ruleId` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rules` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `name` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `category` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL DEFAULT 'number',
    `value` VARCHAR(191) NOT NULL DEFAULT '',
    `unit` VARCHAR(191) NULL,
    `priority` INTEGER NOT NULL DEFAULT 0,
    `isActive` BOOLEAN NOT NULL DEFAULT true,
    `appliesTo` VARCHAR(191) NOT NULL DEFAULT 'all',
    `conditionJson` TEXT NULL,
    `description` TEXT NULL,
    `createdByName` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `rules_category_idx`(`category` ASC),
    UNIQUE INDEX `rules_key_key`(`key` ASC),
    PRIMARY KEY (`id` ASC)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `device_sync_logs` ADD CONSTRAINT `device_sync_logs_deviceId_fkey` FOREIGN KEY (`deviceId`) REFERENCES `devices`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `rule_audits` ADD CONSTRAINT `rule_audits_ruleId_fkey` FOREIGN KEY (`ruleId`) REFERENCES `rules`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

