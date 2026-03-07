/**
 * Types for debugging and instrumentation functionality
 */

/** Log level */
export type LogLevel = 'info' | 'warning' | 'error' | 'debug';

/** Log entry from canister or system */
export interface LogEntry {
  /** Log timestamp */
  timestamp: Date;
  /** Log level */
  level: LogLevel;
  /** Log message */
  message: string;
  /** Source canister ID */
  canisterId: string;
  /** Method that generated the log (if applicable) */
  method?: string;
  /** Additional context */
  context?: Record<string, unknown>;
}

/** Trace filter options */
export interface TraceFilter {
  /** Filter by method name */
  method?: string;
  /** Minimum duration in milliseconds */
  minDuration?: number;
  /** Maximum depth of the call tree */
  maxDepth?: number;
  /** Filter by caller principal */
  caller?: string;
}

/** Method statistics for profiling */
export interface MethodStats {
  /** Number of calls */
  count: number;
  /** Total duration in milliseconds */
  totalDuration: number;
  /** Average duration in milliseconds */
  avgDuration: number;
  /** Maximum duration in milliseconds */
  maxDuration: number;
}

/** Result of profiling a canister */
export interface ProfileResult {
  /** Number of samples collected */
  samples: number;
  /** Duration of profiling in seconds */
  duration: number;
  /** Statistics per method */
  methodStats: Map<string, MethodStats>;
  /** Memory snapshots taken during profiling */
  memorySnapshots: number[];
}

/** Instrument result */
export interface InstrumentResult {
  /** Whether instrumentation succeeded */
  success: boolean;
  /** Path to instrumented WASM */
  outputPath: string;
  /** Any warnings from instrumentation */
  warnings: string[];
}

/** Trace export format */
export type TraceExportFormat = 'json' | 'flamegraph' | 'text';

/** Dashboard metric types */
export interface DashboardMetrics {
  /** Current cycles balance */
  cycles: bigint;
  /** Memory usage in bytes */
  memory: bigint;
  /** Requests per second */
  requestRate: number;
  /** Error rate */
  errorRate: number;
}

/** Alert severity levels */
export type AlertSeverity = 'info' | 'warning' | 'error' | 'critical';

/** Alert entry */
export interface AlertEntry {
  /** Alert timestamp */
  timestamp: Date;
  /** Alert severity */
  severity: AlertSeverity;
  /** Alert message */
  message: string;
  /** Related canister ID */
  canisterId: string;
  /** Alert type/category */
  type: string;
}
