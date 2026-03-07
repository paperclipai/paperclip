/**
 * Types for canister monitoring
 *
 * Health status, alerts, and resource tracking.
 */

/**
 * Canister health status
 */
export type CanisterHealthStatus = 'healthy' | 'warning' | 'critical' | 'unknown';

/**
 * Alert severity levels
 */
export type AlertSeverity = 'info' | 'warning' | 'critical';

/**
 * Monitoring alert
 */
export interface MonitoringAlert {
  /** Alert severity */
  severity: AlertSeverity;
  /** Human-readable alert message */
  message: string;
  /** Canister ID this alert is for */
  canisterId: string;
  /** Metric being monitored */
  metric: string;
  /** Current value that triggered alert */
  value: string;
  /** Threshold value that was exceeded */
  threshold: string;
  /** When the alert was triggered */
  timestamp: Date;
}

/**
 * Health check thresholds
 */
export interface HealthThresholds {
  /** Cycles below this value trigger a warning */
  cyclesWarning?: bigint;
  /** Cycles below this value trigger a critical alert */
  cyclesCritical?: bigint;
  /** Memory usage above this percentage triggers a warning (0-100) */
  memoryWarningPercent?: number;
  /** Memory usage above this percentage triggers a critical alert (0-100) */
  memoryCriticalPercent?: number;
}

/**
 * Canister status info from monitoring
 */
export interface CanisterStatusInfo {
  /** Canister ID */
  canisterId: string;
  /** Canister status (running, stopped, etc.) */
  status: string;
  /** Memory size in bytes */
  memorySize?: bigint;
  /** Current cycle balance */
  cycles?: bigint;
  /** WASM module hash */
  moduleHash?: string;
  /** Health status */
  health: CanisterHealthStatus;
  /** Timestamp of when this status was captured */
  timestamp: Date;
}

/**
 * Resource usage metrics over time
 */
export interface ResourceUsageSnapshot {
  /** Canister ID */
  canisterId: string;
  /** Memory usage at this snapshot */
  memoryBytes?: bigint;
  /** Cycle balance at this snapshot */
  cycles?: bigint;
  /** When this snapshot was captured */
  timestamp: Date;
}

/**
 * ThoughtForm health check result
 */
export interface ThoughtFormHealthStatus {
  /** Overall status */
  status: 'OK' | 'WARN' | 'CRITICAL' | 'ERROR';
  /** Timestamp of most recent ThoughtForm entry */
  latestTimestamp: number;
  /** Total ThoughtForm entry count */
  count: number;
  /** Canister ID that was checked */
  canisterId: string;
  /** Human-readable message (set on failure) */
  message?: string;
}

/**
 * ThoughtForm health check options
 */
export interface ThoughtFormHealthOptions {
  /** Canister ID to query */
  canisterId: string;
  /** Maximum age of latest entry before alerting, in hours (default: 24) */
  staleThresholdHours?: number;
  /** ICP host URL override */
  host?: string;
}

/**
 * Monitoring query options
 */
export interface MonitoringOptions {
  /** Canister ID or name to monitor */
  canister: string;
  /** Alert thresholds */
  thresholds?: Partial<HealthThresholds>;
  /** How often to poll (milliseconds) */
  pollInterval?: number;
  /** Maximum number of snapshots to keep */
  maxSnapshots?: number;
  /** Whether to generate alerts */
  generateAlerts?: boolean;
}
