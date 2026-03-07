/**
 * Health Monitoring
 *
 * Performs health checks on canisters and determines overall health status
 * based on resource usage thresholds.
 */

import { getCanisterInfo } from './info.js';
import { createAnonymousAgent, createActor } from '../canister/actor.js';
import type {
  CanisterHealthStatus,
  CanisterStatusInfo,
  HealthThresholds,
  MonitoringOptions,
  MonitoringAlert,
  ThoughtFormHealthStatus,
  ThoughtFormHealthOptions,
} from './types.js';

/**
 * Determine health status based on resource metrics.
 *
 * @param statusInfo - Canister status information
 * @param thresholds - Health check thresholds
 * @returns Health status
 */
export function determineHealthStatus(
  statusInfo: CanisterStatusInfo,
  thresholds: HealthThresholds = {},
): CanisterHealthStatus {
  // Check cycles
  const cycles = statusInfo.cycles;
  if (cycles !== undefined) {
    if (thresholds.cyclesCritical && cycles < thresholds.cyclesCritical) {
      return 'critical';
    } else if (thresholds.cyclesWarning && cycles < thresholds.cyclesWarning) {
      return 'warning';
    }
  }

  // Check memory
  const memoryBytes = statusInfo.memorySize;
  if (memoryBytes !== undefined) {
    const memoryMB = Number(memoryBytes) / (1024 * 1024);
    // IC canisters have ~4GB max memory (4096 MB)
    const maxMemoryMB = 4096;
    const criticalThresholdMB = maxMemoryMB * ((thresholds.memoryCriticalPercent ?? 0) / 100);
    const warningThresholdMB = maxMemoryMB * ((thresholds.memoryWarningPercent ?? 0) / 100);

    if (thresholds.memoryCriticalPercent && memoryMB > criticalThresholdMB) {
      return 'critical';
    } else if (thresholds.memoryWarningPercent && memoryMB > warningThresholdMB) {
      return 'warning';
    }
  }

  // Check canister status
  const status = statusInfo.status?.toLowerCase() ?? '';
  if (status === 'stopped') {
    return 'critical';
  } else if (status === 'stopping') {
    return 'warning';
  }

  return 'healthy';
}

/**
 * Generate alerts based on health status.
 *
 * @param statusInfo - Canister status information
 * @param thresholds - Health check thresholds
 * @param currentHealth - Current health status
 * @returns Generated alerts
 */
export function generateHealthAlerts(
  statusInfo: CanisterStatusInfo,
  thresholds: HealthThresholds = {},
  currentHealth: CanisterHealthStatus = 'healthy',
): MonitoringAlert[] {
  const alerts: MonitoringAlert[] = [];

  const cycles = statusInfo.cycles;
  if (cycles !== undefined && thresholds.cyclesCritical !== undefined) {
    if (cycles < thresholds.cyclesCritical) {
      alerts.push({
        severity: 'critical',
        message: `Cycle balance critically low: ${formatCycles(cycles)}`,
        canisterId: statusInfo.canisterId,
        metric: 'cycles',
        value: formatCycles(cycles),
        threshold: formatCycles(thresholds.cyclesCritical),
        timestamp: new Date(),
      });
    } else if (thresholds.cyclesWarning !== undefined && cycles < thresholds.cyclesWarning) {
      alerts.push({
        severity: 'warning',
        message: `Cycle balance low: ${formatCycles(cycles)}`,
        canisterId: statusInfo.canisterId,
        metric: 'cycles',
        value: formatCycles(cycles),
        threshold: formatCycles(thresholds.cyclesWarning),
        timestamp: new Date(),
      });
    }
  }

  const memoryBytes = statusInfo.memorySize;
  if (memoryBytes !== undefined) {
    const memoryMB = Number(memoryBytes) / (1024 * 1024);
    if (thresholds.memoryCriticalPercent !== undefined && memoryMB > 1024 * thresholds.memoryCriticalPercent) {
      alerts.push({
        severity: 'critical',
        message: `Memory usage critically high: ${memoryMB.toFixed(2)} MB`,
        canisterId: statusInfo.canisterId,
        metric: 'memory',
        value: `${memoryMB.toFixed(2)} MB`,
        threshold: `${thresholds.memoryCriticalPercent}%`,
        timestamp: new Date(),
      });
    } else if (thresholds.memoryWarningPercent !== undefined && memoryMB > 1024 * thresholds.memoryWarningPercent) {
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

  if (currentHealth !== 'healthy') {
    alerts.push({
      severity: 'warning',
      message: `Canister status: ${statusInfo.status}`,
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
 * Format cycles bigint to human-readable string.
 */
function formatCycles(cycles: bigint): string {
  if (cycles >= BigInt(1_000_000_000_000)) {
    const value = Number(cycles) / 1_000_000_000_000;
    return `${value.toFixed(2)} T`;
  }
  return cycles.toString();
}

/**
 * Perform a one-time health check.
 *
 * @param options - Monitoring options
 * @returns Canister status with health status
 */
 export async function checkHealth(
  canisterId: string,
  options?: Partial<MonitoringOptions>,
): Promise<CanisterStatusInfo> {
  const monitoringOptions: MonitoringOptions = { canister: canisterId, ...options };
  const statusInfo = await getCanisterInfo(canisterId, monitoringOptions);

  const health = determineHealthStatus(statusInfo, options?.thresholds ?? {});

  return {
    ...statusInfo,
    health,
  };
}

/**
 * Check multiple canisters' health status.
 *
 * @param canisterIds - Array of canister IDs to check
 * @param options - Monitoring options applied to all
 * @returns Array of canister status info
 */
 export async function checkMultipleHealth(
  canisterIds: string[],
  options?: Partial<MonitoringOptions>,
): Promise<CanisterStatusInfo[]> {
  const results = await Promise.all(
    canisterIds.map((id) => getCanisterInfo(id, { canister: id, ...options }))
  );

  return results.map((statusInfo) => ({
    ...statusInfo,
    health: determineHealthStatus(statusInfo, options?.thresholds ?? {}),
  }));
}

/**
 * Check ThoughtForm store health by querying the canister for latest
 * memory timestamp and total count.
 *
 * @param options - ThoughtForm health check options
 * @returns ThoughtForm health status with latest timestamp and count
 */
export async function checkThoughtFormHealth(
  options: ThoughtFormHealthOptions,
): Promise<ThoughtFormHealthStatus> {
  const { canisterId, staleThresholdHours = 24, host } = options;

  try {
    const agent = createAnonymousAgent(host);
    const actor = createActor(canisterId, agent);

    const memories = await actor.getMemories();
    const count = memories.length;

    let latestTimestamp = 0;
    for (const memory of memories) {
      if (memory.timestamp > latestTimestamp) {
        latestTimestamp = memory.timestamp;
      }
    }

    const nowMs = Date.now();
    const staleThresholdMs = staleThresholdHours * 60 * 60 * 1000;
    // Canister timestamps may be in nanoseconds (IC convention) or milliseconds
    const latestMs = latestTimestamp > 1e15 ? latestTimestamp / 1e6 : latestTimestamp;
    const ageMs = nowMs - latestMs;

    if (count === 0) {
      return {
        status: 'WARN',
        latestTimestamp,
        count,
        canisterId,
        message: 'No ThoughtForm entries found',
      };
    }

    if (ageMs > staleThresholdMs) {
      const ageHours = Math.round(ageMs / (60 * 60 * 1000));
      return {
        status: 'WARN',
        latestTimestamp,
        count,
        canisterId,
        message: `No updates in ${ageHours}h (threshold: ${staleThresholdHours}h)`,
      };
    }

    return {
      status: 'OK',
      latestTimestamp,
      count,
      canisterId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      status: 'ERROR',
      latestTimestamp: 0,
      count: 0,
      canisterId,
      message: `Canister unreachable: ${message}`,
    };
  }
}
