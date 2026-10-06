-- Task 5: structured, persistent fingerprint-device audit trail.
-- No foreign key to `devices` on purpose: audit history must outlive the device.
CREATE TABLE `device_audit_logs` (
    `id` INTEGER NOT NULL AUTO_INCREMENT,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `actorType` VARCHAR(191) NOT NULL DEFAULT 'system',
    `actorId` INTEGER NULL,
    `actorName` VARCHAR(191) NULL,
    `actorRole` VARCHAR(191) NULL,
    `action` VARCHAR(191) NOT NULL,
    `result` VARCHAR(191) NOT NULL,
    `entityType` VARCHAR(191) NOT NULL DEFAULT 'device',
    `deviceId` INTEGER NULL,
    `deviceName` VARCHAR(191) NULL,
    `deviceIp` VARCHAR(191) NULL,
    `devicePort` INTEGER NULL,
    `errorCode` VARCHAR(191) NULL,
    `errorMessage` TEXT NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `metadata` JSON NULL,

    INDEX `device_audit_logs_createdAt_idx`(`createdAt`),
    INDEX `device_audit_logs_deviceId_createdAt_idx`(`deviceId`, `createdAt`),
    INDEX `device_audit_logs_action_idx`(`action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
