/**
 * Agent Packaging Module
 *
 * Exports all packaging-related functionality.
 */

// Types
export type {
  AgentType,
  AgentConfig,
  PackageOptions,
  PackageResult,
  ValidationError,
  ValidationResult,
} from './types.js';

// Detection
export { detectAgent, detectAgentType, validateSourcePath } from './detector.js';

// Compilation
export {
  compileToWasm,
  generateWasm,
  generateWat,
  generateStateJson,
  validateWasmFile,
} from './compiler.js';

// WasmEdge Compiler
export {
  generateWasmEdgeWrapper,
  validateWasmEdgeModule,
  generateWasmEdgeConfig,
  generateWasmEdgeManifest,
  type WasmEdgeOptions,
  DEFAULT_WASMEDGE_OPTIONS,
} from './wasmedge-compiler.js';

// Serialization
export {
  serializeState,
  deserializeState,
  writeStateFile,
  readStateFile,
  createEmptyState,
  mergeStates,
  validateState,
} from './serializer.js';

// Parsers
export {
  parseClawdbotConfig,
  findClawdbotConfigs,
  parseGooseConfig,
  findGooseConfigs,
  parseClineConfig,
  findClineConfigs,
  parseGenericConfig,
  findGenericConfigs,
} from './parsers/index.js';

// Config Persistence
export {
  getConfigPath,
  writeAgentConfig,
  readAgentConfig,
  listAgents,
  deleteAgentConfig,
} from './config-persistence.js';

// Config Schemas
export {
  DEFAULT_CLAWDBOT_SETTINGS,
  DEFAULT_GOOSE_CONFIG,
  DEFAULT_CLINE_CONFIG,
} from './config-schemas.js';

// Summary - used by package command
export {
  getPackageSummary,
  packageAgent,
} from './packager.js';

export type {
  Memory,
  Task,
  AgentState,
  SerializedAgentState,
  SerializationOptions,
} from './serializer.js';

// ThoughtForm serializers
export {
  ThoughtStepSchema,
  ThoughtFormManifestSchema,
  ThoughtFormBundleSchema,
  deserializeThoughtFormBundle,
  THOUGHTFORM_SCHEMA_VERSION,
} from './serializers/index.js';

export type {
  ThoughtStep,
  ThoughtFormManifest,
  ThoughtFormBundle,
} from './serializers/index.js';
