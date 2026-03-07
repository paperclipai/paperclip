/**
 * ICP Tools Integration Module
 *
 * Provides typed wrappers around ic-wasm and icp-cli tooling,
 * auto-detection of available tools, an optimization pipeline,
 * and environment management.
 */

// Types
export type {
  ToolName,
  ToolInfo,
  ToolchainStatus,
  IcWasmOptLevel,
  IcWasmOptimizeOptions,
  IcWasmShrinkOptions,
  IcWasmResourceOptions,
  IcWasmMetadataOptions,
  IcWasmCheckEndpointsOptions,
  IcWasmInstrumentOptions,
  IcWasmResult,
  IcWasmInfo,
  MetadataVisibility,
  IcWasmOptimizationResult,
  IcWasmOptimizationPipelineOptions,
  IcWasmOptimizationPipelineResult,
  IcpEnvironment,
  IcpDeployMode,
  IcpCommonOptions,
  IcpBuildOptions,
  IcpDeployOptions,
  IcpCanisterStatusOptions,
  IcpCanisterCallOptions,
  IcpCyclesBalanceOptions,
  IcpCyclesMintOptions,
  IcpCyclesTransferOptions,
  IcpIdentityListOptions,
  IcpIdentityNewOptions,
  IcpIdentityExportOptions,
  IcpIdentityImportOptions,
  IcpNetworkStartOptions,
  IcpNetworkStopOptions,
  IcpSyncOptions,
  IcpTokenBalanceOptions,
  IcpTokenTransferOptions,
  IcpEnvironmentListOptions,
  IcpCliResult,
  IcpNetworkConfig,
  IcpCyclesConfig,
  IcpEnvironmentConfig,
  IcpOptimizationConfig,
  IcpProjectConfig,
} from './types.js';

// Re-export monitoring types
export type {
  CanisterHealthStatus,
  AlertSeverity,
  CanisterStatusInfo,
  MonitoringAlert,
  HealthThresholds,
  MonitoringOptions,
  ResourceUsageSnapshot,
} from '../monitoring/types.js';

// Tool detection
export {
  detectTool,
  detectToolchain,
  requireTool,
} from './tool-detector.js';

// ic-wasm wrapper
export * as icwasm from './icwasm.js';

// icp-cli wrapper
export * as icpcli from './icpcli.js';

// Optimization pipeline
export { runOptimizationPipeline } from './optimization.js';

// Environment management
export {
  findConfigFile,
  loadConfig,
  getEnvironment,
  getOptimizationConfig,
  listEnvironments,
  writeConfig,
  generateDefaultConfig,
} from './environment.js';

// Batched canister operations
export * from './batch.js';
