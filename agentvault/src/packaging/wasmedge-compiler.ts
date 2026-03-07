/**
 * WasmEdge Compiler
 *
 * Integrates WasmEdge SDK for compiling JavaScript to WebAssembly.
 * Provides WASI-compliant module generation for agent execution.
 */

import * as path from 'node:path';
import type { AgentConfig } from '../packaging/types.js';

/**
 * Compilation target types
 */
export type CompilationTarget = 'wasmedge' | 'motoko' | 'pure-wasm';

/**
 * WasmEdge compilation options
 */
export interface WasmEdgeOptions {
  /** Enable debugging support */
  debug?: boolean;
  /** Generate source maps */
  sourcemap?: boolean;
  /** Optimization level (0-3) */
  optimize?: number;
  /** Enable WASI support */
  wasi?: boolean;
}

/**
 * Default WasmEdge options
 */
export const DEFAULT_WASMEDGE_OPTIONS: WasmEdgeOptions = {
  debug: true,
  sourcemap: true,
  optimize: 2,
  wasi: true,
};

/**
 * Generate WasmEdge-compatible JavaScript wrapper
 *
 * Creates a JavaScript module that implements the standard agent interface
 * and can be compiled with WasmEdge.
 */
export function generateWasmEdgeWrapper(
  agentCode: string,
  config: AgentConfig
): string {
  const wrapper = `
// AgentVault WasmEdge Module
// Agent: ${config.name}
// Type: ${config.type}
// Generated: ${new Date().toISOString()}

// Agent state management
let _state = {};
let _initialized = false;

// Agent initialization
export function init(configStr) {
  try {
    const config = JSON.parse(configStr);
    _state = {
      name: config.name,
      type: config.type,
      version: config.version,
      memories: [],
      tasks: [],
      createdAt: Date.now(),
    };
    _initialized = true;
    return 0; // Success
  } catch (error) {
    console.error('Init failed:', error);
    return 1; // Error
  }
}

// Agent step function
export function step(input) {
  if (!_initialized) {
    console.error('Agent not initialized');
    return JSON.stringify({ error: 'Agent not initialized' });
  }

  try {
    // Execute agent code with state
    const result = (function() {
      ${agentCode}
    }).call(_state);

    // Update state with execution result
    _state.lastExecuted = Date.now();
    _state.lastResult = result;

    return JSON.stringify({
      success: true,
      result: result,
      state: _state,
    });
  } catch (error) {
    console.error('Step failed:', error);
    return JSON.stringify({
      success: false,
      error: error.message,
      state: _state,
    });
  }
}

// Get agent state as bytes
export function get_state() {
  const stateJson = JSON.stringify(_state);
  const bytes = new TextEncoder().encode(stateJson);
  return bytes;
}

// Get agent state size
export function get_state_size() {
  const stateJson = JSON.stringify(_state);
  return new TextEncoder().encode(stateJson).length;
}

// Add memory entry
export function add_memory(type, content) {
  const memory = {
    type: type,
    content: content,
    timestamp: Date.now(),
    importance: 1,
  };
  if (_state.memories) {
    _state.memories.push(memory);
  }
  return 0;
}

// Get all memories
export function get_memories() {
  return JSON.stringify(_state.memories || []);
}

// Get memories by type
export function get_memories_by_type(memoryType) {
  const memories = (_state.memories || []).filter(m => m.type === memoryType);
  return JSON.stringify(memories);
}

// Clear memories
export function clear_memories() {
  _state.memories = [];
  return 0;
}

// Add task to queue
export function add_task(taskId, description) {
  const task = {
    id: taskId,
    description: description,
    status: 'pending',
    result: null,
    timestamp: Date.now(),
  };
  if (_state.tasks) {
    _state.tasks.push(task);
  }
  return 0;
}

// Get all tasks
export function get_tasks() {
  return JSON.stringify(_state.tasks || []);
}

// Get pending tasks
export function get_pending_tasks() {
  const pending = (_state.tasks || []).filter(t => t.status === 'pending');
  return JSON.stringify(pending);
}

// Update task status
export function update_task_status(taskId, status, result) {
  const task = (_state.tasks || []).find(t => t.id === taskId);
  if (task) {
    task.status = status;
    task.result = result;
    return 0;
  }
  return 1; // Task not found
}

// Clear all tasks
export function clear_tasks() {
  _state.tasks = [];
  return 0;
}

// Export module info
export function get_info() {
  return JSON.stringify({
    name: '${config.name}',
    type: '${config.type}',
    version: '${config.version || '1.0.0'}',
    initialized: _initialized,
    stateSize: get_state_size(),
  });
}
`;

  return wrapper;
}

/**
 * Generate WasmEdge build configuration
 *
 * Creates configuration for WasmEdge compiler.
 */
export function generateWasmEdgeConfig(
  config: AgentConfig,
  options: WasmEdgeOptions = DEFAULT_WASMEDGE_OPTIONS
): string {
  const buildConfig = {
    module_name: config.name,
    module_type: 'wasi',
    output_type: 'wasm',
    optimization_level: options.optimize ?? 2,
    debug: options.debug ?? true,
    generate_source_map: options.sourcemap ?? true,
    enable_wasi: options.wasi ?? true,
    target: 'wasm32',
    features: ['bulk-memory', 'mutable-globals', 'sign-ext'],
    exports: [
      'init',
      'step',
      'get_state',
      'get_state_size',
      'add_memory',
      'get_memories',
      'get_memories_by_type',
      'clear_memories',
      'add_task',
      'get_tasks',
      'get_pending_tasks',
      'update_task_status',
      'clear_tasks',
      'get_info',
    ],
  };

  return JSON.stringify(buildConfig, null, 2);
}

/**
 * Validate WasmEdge module
 *
 * Checks that a compiled module is valid WasmEdge WASM.
 */
export function validateWasmEdgeModule(wasmBuffer: Buffer): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  // Check minimum size
  if (wasmBuffer.length < 8) {
    errors.push('WASM file too small (minimum 8 bytes)');
  }

  // Check WASM magic bytes
  const magic = wasmBuffer.subarray(0, 4);
  const expectedMagic = Buffer.from([0x00, 0x61, 0x73, 0x6d]);
  if (!magic.equals(expectedMagic)) {
    errors.push('Invalid WASM magic bytes');
  }

  // Check version
  const version = wasmBuffer.subarray(4, 8);
  const expectedVersion = Buffer.from([0x01, 0x00, 0x00, 0x00]);
  if (!version.equals(expectedVersion)) {
    errors.push('Invalid WASM version (must be 1)');
  }

  // Check for required exports
  // In a real implementation, this would parse the WASM binary
  // and check the export section for required functions
  // For now, we'll just check the file is not empty
  if (wasmBuffer.length < 100) {
    errors.push('WASM file appears to be empty or incomplete');
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Generate WasmEdge build command
 *
 * Returns the command line to compile JavaScript to WasmEdge WASM.
 * This is a placeholder - actual WasmEdge SDK usage would be integrated.
 */
export function getWasmEdgeBuildCommand(
  sourcePath: string,
  outputPath: string,
  options: WasmEdgeOptions = DEFAULT_WASMEDGE_OPTIONS
): string {
  const args = [
    sourcePath,
    '--output', outputPath,
    '--target', 'wasm32',
    '--opt', String(options.optimize ?? 2),
  ];

  if (options.debug) {
    args.push('--debug');
  }

  if (options.sourcemap) {
    args.push('--sourcemap');
  }

  if (options.wasi) {
    args.push('--wasi');
  }

  return `wasmedge-compile ${args.join(' ')}`;
}

/**
 * Extract compilation errors from WasmEdge output
 *
 * Parses error messages from WasmEdge compiler output.
 */
export function parseWasmEdgeErrors(output: string): string[] {
  const errors: string[] = [];
  const lines = output.split('\n');

  for (const line of lines) {
    if (line.includes('error:')) {
      errors.push(line.trim());
    } else if (line.includes('Error:')) {
      errors.push(line.trim());
    } else if (line.includes('ERROR')) {
      errors.push(line.trim());
    }
  }

  return errors;
}

/**
 * Get source map path for compiled WASM
 *
 * Returns the expected source map file path.
 */
export function getSourceMapPath(wasmPath: string): string {
  const dir = path.dirname(wasmPath);
  const basename = path.basename(wasmPath, '.wasm');
  return path.join(dir, `${basename}.wasm.map`);
}

/**
 * Generate module manifest for WasmEdge
 *
 * Creates a manifest file with module metadata.
 */
export function generateWasmEdgeManifest(
  config: AgentConfig,
  wasmPath: string,
  _outputPath: string
): string {
  const manifest = {
    module_name: config.name,
    module_type: 'agent',
    version: config.version || '1.0.0',
    agent_type: config.type,
    wasm_path: path.basename(wasmPath),
    created_at: new Date().toISOString(),
    features: {
      wasi: true,
      bulk_memory: true,
      mutable_globals: true,
      multi_value: false,
    },
    exports: [
      'init',
      'step',
      'get_state',
      'get_state_size',
      'add_memory',
      'get_memories',
      'get_memories_by_type',
      'clear_memories',
      'add_task',
      'get_tasks',
      'get_pending_tasks',
      'update_task_status',
      'clear_tasks',
      'get_info',
    ],
  };

  return JSON.stringify(manifest, null, 2);
}
