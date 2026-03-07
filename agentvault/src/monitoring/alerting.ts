/**
 * Alerting
 *
 * Generates, stores, and retrieves monitoring alerts for canisters.
 * Tracks cycle depletion, memory issues, and performance degradation.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  MonitoringAlert,
  CanisterStatusInfo,
  HealthThresholds,
} from './types.js';

/**
 * Default alert storage path
 */
const ALERTS_DIR = path.join(process.env.HOME || process.cwd(), '.agentvault', 'alerts');

/**
 * Alert storage file path
 */
const getAlertFilePath = (canisterId: string) =>
  path.join(ALERTS_DIR, `${canisterId}.json`);

/**
 * Load alerts from storage.
 *
 * @param canisterId - Canister ID
 * @returns Stored alerts array
 */
export function loadAlerts(canisterId: string): MonitoringAlert[] {
  const alertFile = getAlertFilePath(canisterId);
  if (!fs.existsSync(alertFile)) {
    return [];
  }
  try {
    const content = fs.readFileSync(alertFile, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

/**
 * Save alerts to storage.
 *
 * @param canisterId - Canister ID
 * @param alerts - Alerts to store
 */
export function saveAlerts(canisterId: string, alerts: MonitoringAlert[]): void {
  const alertFile = getAlertFilePath(canisterId);
  const content = JSON.stringify(alerts, null, 2);
  fs.mkdirSync(path.dirname(alertFile), { recursive: true });
  fs.writeFileSync(alertFile, content, 'utf-8');
}

/**
 * Append a new alert to storage.
 *
 * @param canisterId - Canister ID
 * @param alert - Alert to add
 */
export function appendAlert(canisterId: string, alert: MonitoringAlert): void {
  const alerts = loadAlerts(canisterId);
  alerts.push(alert);
  saveAlerts(canisterId, alerts);
}

/**
 * Clear alerts for a canister.
 *
 * @param canisterId - Canister ID
 */
export function clearAlerts(canisterId: string): void {
  const alertFile = getAlertFilePath(canisterId);
  if (fs.existsSync(alertFile)) {
    fs.unlinkSync(alertFile);
  }
}

/**
 * Generate health alerts for a canister based on its current status.
 *
 * @param statusInfo - Canister status information
 * @param thresholds - Health check thresholds
 * @returns Array of alerts
 */
export function generateHealthAlerts(
  statusInfo: CanisterStatusInfo,
  thresholds: HealthThresholds = {},
): MonitoringAlert[] {
  const alerts: MonitoringAlert[] = [];

  const cycles = statusInfo.cycles;
  if (cycles !== undefined) {
    if (thresholds.cyclesCritical !== undefined && cycles < thresholds.cyclesCritical) {
      alerts.push({
        severity: 'critical',
        message: `Cycle balance critically low: ${cycles.toString()}`,
        canisterId: statusInfo.canisterId,
        metric: 'cycles',
        value: cycles.toString(),
        threshold: thresholds.cyclesCritical.toString(),
        timestamp: new Date(),
      });
    } else if (thresholds.cyclesWarning !== undefined && cycles < thresholds.cyclesWarning) {
      alerts.push({
        severity: 'warning',
        message: `Cycle balance low: ${cycles.toString()}`,
        canisterId: statusInfo.canisterId,
        metric: 'cycles',
        value: cycles.toString(),
        threshold: thresholds.cyclesWarning.toString(),
        timestamp: new Date(),
      });
    }
  }

  const memoryBytes = statusInfo.memorySize;
  if (memoryBytes !== undefined) {
    const memoryMB = Number(memoryBytes) / (1024 * 1024);
    // IC canisters have ~4GB max memory (4096 MB)
    const maxMemoryMB = 4096;
    const criticalThresholdMB = maxMemoryMB * ((thresholds.memoryCriticalPercent ?? 0) / 100);
    const warningThresholdMB = maxMemoryMB * ((thresholds.memoryWarningPercent ?? 0) / 100);

    if (thresholds.memoryCriticalPercent !== undefined && memoryMB > criticalThresholdMB) {
      alerts.push({
        severity: 'critical',
        message: `Memory usage critically high: ${memoryMB.toFixed(2)} MB`,
        canisterId: statusInfo.canisterId,
        metric: 'memory',
        value: `${memoryMB.toFixed(2)} MB`,
        threshold: `${thresholds.memoryCriticalPercent}%`,
        timestamp: new Date(),
      });
    } else if (thresholds.memoryWarningPercent !== undefined && memoryMB > warningThresholdMB) {
      alerts.push({
        severity: 'warning',
        message: `Memory usage high: ${memoryMB.toFixed(2)} MB`,
        canisterId: statusInfo.canisterId,
        metric: 'memory',
        value: `${memoryMB.toFixed(2)} MB`,
        threshold: `${thresholds.memoryWarningPercent}%`,
        timestamp: new Date(),
      });
    }
  }

  if (statusInfo.status === 'stopped') {
    alerts.push({
      severity: 'critical',
      message: 'Canister is stopped',
      canisterId: statusInfo.canisterId,
      metric: 'status',
      value: statusInfo.status,
      threshold: 'healthy',
      timestamp: new Date(),
    });
  } else if (statusInfo.status === 'stopping') {
    alerts.push({
      severity: 'warning',
      message: 'Canister is stopping',
      canisterId: statusInfo.canisterId,
      metric: 'status',
      value: statusInfo.status,
      threshold: 'healthy',
      timestamp: new Date(),
    });
  }

  return alerts;
}

/**
 * Get recent alerts for a canister.
 *
 * @param canisterId - Canister ID
 * @param limit - Maximum number of alerts to return (default: 10)
 * @returns Recent alerts (newest first)
 */
export function getRecentAlerts(
  canisterId: string,
  limit: number = 10,
): MonitoringAlert[] {
  const alerts = loadAlerts(canisterId);
  return alerts.slice(-limit);
}
