/**
 * Types for agent packaging
 */

/**
 * Supported agent types that can be packaged
 */
export type AgentType = 'clawdbot' | 'goose' | 'cline' | 'polytician' | 'generic';

/**
 * Agent configuration as detected from the source directory
 */
export interface AgentConfig {
  /** Name of the agent */
  name: string;
  /** Detected agent type */
  type: AgentType;
  /** Source directory path */
  sourcePath: string;
  /** Entry point file (if detected) */
  entryPoint?: string;
  /** Agent version (if detected) */
  version?: string;
}

/**
 * Options for the packaging process
 */
export interface PackageOptions {
  /** Source directory containing the agent */
  sourcePath: string;
  /** Output directory for compiled artifacts */
  outputPath?: string;
  /** Force overwrite of existing output files */
  force?: boolean;
  /** Skip validation steps */
  skipValidation?: boolean;
  /** Compilation target (wasmedge for local, motoko for ICP) */
  target?: 'wasmedge' | 'motoko' | 'pure-wasm';
  /** Enable debugging features (source maps, verbose output) */
  debug?: boolean;
  /** Optimization level (0-3) */
  optimize?: number;

  // ── ic-wasm optimization options ──────────────────────────────────────

  /** Run ic-wasm optimize after WASM generation (requires ic-wasm) */
  icWasmOptimize?: boolean;
  /** Run ic-wasm shrink to remove unused functions (requires ic-wasm) */
  icWasmShrink?: boolean;
  /** Validate WASM against Candid .did interface (requires ic-wasm) */
  candidInterface?: string;
  /** Memory limit to set via ic-wasm resource (e.g. '4GiB') */
  memoryLimit?: string;
  /** Compute quota to set via ic-wasm resource */
  computeQuota?: string;
}

/**
 * Result of a successful packaging operation
 */
export interface PackageResult {
  /** Detected agent configuration */
  config: AgentConfig;
  /** Path to the generated WASM file */
  wasmPath: string;
  /** Path to the generated WAT file (WebAssembly Text format) */
  watPath: string;
  /** Path to the serialized state JSON */
  statePath: string;
  /** Path to the generated JavaScript bundle */
  jsBundlePath?: string;
  /** Path to the generated source map (if enabled) */
  sourceMapPath?: string;
  /** Path to the generated manifest file */
  manifestPath?: string;
  /** Path to the generated Candid interface (if motoko target) */
  didPath?: string;
  /** Size of the WASM file in bytes */
  wasmSize: number;
  /** Compilation target used */
  target: 'wasmedge' | 'motoko' | 'pure-wasm';
  /** Timestamp of the packaging operation */
  timestamp: Date;
  /** Compilation duration in milliseconds */
  duration?: number;
  /** Number of functions exported */
  functionCount?: number;

  // ── ic-wasm optimization results ────────────────────────────────────

  /** Original WASM size before ic-wasm optimization (bytes) */
  originalWasmSize?: number;
  /** Size reduction percentage from optimization (0-100) */
  optimizationReductionPercent?: number;
  /** Whether Candid validation passed */
  candidValidationPassed?: boolean;
  /** Optimization warnings */
  optimizationWarnings?: string[];
}

/**
 * Validation error that occurred during packaging
 */
export interface ValidationError {
  /** Error code for programmatic handling */
  code: string;
  /** Human-readable error message */
  message: string;
  /** File path related to the error (if applicable) */
  filePath?: string;
}

/**
 * Result of agent validation
 */
export interface ValidationResult {
  /** Whether validation passed */
  valid: boolean;
  /** List of validation errors (if any) */
  errors: ValidationError[];
  /** List of validation warnings */
  warnings: string[];
}

/**
 * Parsed agent configuration with agent-specific settings
 */
export interface ParsedAgentConfig {
  base: {
    name: string;
    version?: string;
    description?: string;
  };
  type: 'clawdbot' | 'goose' | 'cline' | 'polytician' | 'generic';
}

/**
 * Config file location
 */
export interface ConfigFilePath {
  path: string;
  type: 'json' | 'yaml' | 'directory';
}
