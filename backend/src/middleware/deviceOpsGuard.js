/**
 * deviceOpsGuard.js — keeps a "no scheduler" backend instance away from ZKTeco devices.
 *
 * A ZKTeco device serves ONE TCP session, and services/deviceGate.js (the per-device gate) is process-local. Two backend
 * processes that share a database therefore must not both talk to devices. The LAN-server instance (tools/lan-server) is
 * started with SKIP_SCHEDULER=true: index.js then starts no listeners and no crons. That alone does NOT stop a logged-in
 * user from opening a device session through a manual route (sync, test, ping, user list, scan, listener restart, creating
 * a device — which starts a listener — or deleting an employee from the devices). This guard closes those routes.
 *
 * isSkipSchedulerInstance() is the single definition of "this process does not own the devices". It is exactly the condition
 * index.js uses to skip the scheduler (the literal string 'true'), so the two can never disagree.
 *
 * Order in a route: authenticate -> authorize(role) -> deviceOpsGuard -> handler. A caller without the role still gets 403,
 * and nothing in the handler (validation, DB writes, device I/O) runs when the guard answers 409.
 */
'use strict';

const logger = require('../utils/logger');

const DEVICE_OPERATIONS_DISABLED = Object.freeze({
  code: 'DEVICE_OPERATIONS_DISABLED',
  error: 'لا يمكن تنفيذ عمليات أجهزة البصمة من هذه النسخة (خادم الشبكة) لتفادي التعارض مع برنامج سطح المكتب الذي يملك مزامنة الأجهزة. نفّذ هذه العملية من برنامج CheckIn على جهاز الكمبيوتر.',
});

/** True when this process was started with SKIP_SCHEDULER=true (it must never open a device session). */
function isSkipSchedulerInstance(env = process.env) {
  return env.SKIP_SCHEDULER === 'true';
}

/** Express middleware: 409 on a scheduler-less instance, pass-through otherwise. */
function deviceOpsGuard(req, res, next) {
  if (!isSkipSchedulerInstance()) return next();
  logger.warn(`[DEVICE-OPS-GUARD] refused ${req.method} ${req.originalUrl} — SKIP_SCHEDULER instance does not touch devices`);
  return res.status(409).json({ error: DEVICE_OPERATIONS_DISABLED.error, code: DEVICE_OPERATIONS_DISABLED.code });
}

/** For handlers that only sometimes reach a device (employee delete with includeDevice): answer 409 and return true when refused. */
function refuseDeviceOps(req, res) {
  if (!isSkipSchedulerInstance()) return false;
  logger.warn(`[DEVICE-OPS-GUARD] refused ${req.method} ${req.originalUrl} — SKIP_SCHEDULER instance does not touch devices`);
  res.status(409).json({ error: DEVICE_OPERATIONS_DISABLED.error, code: DEVICE_OPERATIONS_DISABLED.code });
  return true;
}

module.exports = { isSkipSchedulerInstance, deviceOpsGuard, refuseDeviceOps, DEVICE_OPERATIONS_DISABLED };
