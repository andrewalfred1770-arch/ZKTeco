-- CreateIndex
CREATE INDEX `attendance_logs_zkUserId_employeeId_idx` ON `attendance_logs`(`zkUserId`, `employeeId`);

-- CreateIndex
CREATE INDEX `attendance_logs_deviceId_timestamp_idx` ON `attendance_logs`(`deviceId`, `timestamp`);

-- CreateIndex
CREATE INDEX `attendance_logs_employeeId_timestamp_idx` ON `attendance_logs`(`employeeId`, `timestamp`);

