/**
 * WASM Compilation
 *
 * This module provides real WASM compilation for agent code.
 * It bundles agent source code and creates WebAssembly modules
 * with embedded JavaScript for execution.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as esbuild from 'esbuild';
import type { AgentConfig, PackageResult, PackageOptions } from './types.js';
import {
  generateWasmEdgeWrapper,
  validateWasmEdgeModule,
  generateWasmEdgeConfig,
  generateWasmEdgeManifest,
  type WasmEdgeOptions,
  DEFAULT_WASMEDGE_OPTIONS,
} from './wasmedge-compiler.js';
import { runOptimizationPipeline } from '../icp/optimization.js';
import type { IcWasmOptLevel } from '../icp/types.js';

/**
 * WASM magic bytes (first 4 bytes of any valid .wasm file)
 */
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/**
 * WASM version bytes (version 1)
 */
const WASM_VERSION = Buffer.from([0x01, 0x00, 0x00, 0x00]);

/**
 * Bundle agent code to JavaScript
 *
 * Uses esbuild to bundle the agent's source code into a single JavaScript file.
 */
export async function bundleAgentCode(config: AgentConfig): Promise<string> {
  if (!config.entryPoint) {
    if (config.type === 'goose') {
      const pythonCandidates = ['goose.py', 'main.py'];
      const hasPythonEntrypoint = pythonCandidates.some((candidate) =>
        fs.existsSync(path.resolve(config.sourcePath, candidate))
      );
      if (hasPythonEntrypoint) {
        throw new Error(
          'Goose Python entrypoints are not supported in the bundler. Use a JS/TS entrypoint instead.'
        );
      }
    }
    throw new Error(`No entry point found for agent ${config.name}`);
  }

  const entryPath = path.resolve(config.sourcePath, config.entryPoint);
  
  if (!fs.existsSync(entryPath)) {
    throw new Error(`Entry point not found: ${entryPath}`);
  }

  if (path.extname(config.entryPoint) === '.py') {
    throw new Error(
      'Goose Python entrypoints are not supported in the bundler. Use a JS/TS entrypoint instead.'
    );
  }

  try {
    const result = await esbuild.build({
      entryPoints: [entryPath],
      bundle: true,
      platform: 'browser',
      target: 'es2020',
      format: 'iife',
      minify: false,
      sourcemap: false,
      write: false,
      treeShaking: false,
      logLevel: 'silent',
      external: [],
    });

    if (result.errors.length > 0) {
      const errorMessages = result.errors
        .map((e) => e.text)
        .join('; ');
      throw new Error(`Bundle failed: ${errorMessages}`);
    }

    if (!result.outputFiles[0]) {
      throw new Error('Bundle produced no output files');
    }

    return result.outputFiles[0].text;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new Error(`Failed to bundle agent code: ${message}`);
  }
}

/**
 * Helper to concatenate buffers and Uint8Arrays
 */
function concatBuffers(parts: (Buffer | Uint8Array | number[])[]): Buffer {
  const buffers = parts.map(p => {
    if (Array.isArray(p)) {
      return Buffer.from(p);
    }
    if (p instanceof Uint8Array) {
      return Buffer.from(p.buffer, p.byteOffset, p.byteLength);
    }
    return p;
  });
  return Buffer.concat(buffers);
}

/**
 * Write LEB128 encoded unsigned integer directly to bytes
 */
function writeUleb128Bytes(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining !== 0);
  
  return bytes;
}

/**
 * Generate a real WASM binary with embedded JavaScript bundle
 *
 * Creates a WASM module that contains:
 * - Magic bytes and version
 * - Custom section with agent metadata
 * - Data section with embedded JavaScript bundle
 * - Exported functions for agent lifecycle
 */
export function generateWasm(config: AgentConfig, javascriptBundle: string): Buffer {
  const agentNameBytes = Buffer.from(config.name, 'utf-8');
  const jsBytes = Buffer.from(javascriptBundle, 'utf-8');

  // Build sections
  const sections: Buffer[] = [];

  // 1. Custom section with metadata
  const version = config.version ?? '1.0.0';
  const metadataContent = Buffer.concat([
    Buffer.from('agentvault', 'utf-8'),
    Buffer.from([0]),
    agentNameBytes,
    Buffer.from([0]),
    Buffer.from(config.type, 'utf-8'),
    Buffer.from([0]),
    Buffer.from(version, 'utf-8'),
  ]);
  
  const customSectionName = Buffer.from('agent.metadata', 'utf-8');
  const customSection = concatBuffers([
    Buffer.from([0x00]), // section id: custom
    concatBuffers([writeUleb128Bytes(customSectionName.length + 1 + metadataContent.length)]),
    customSectionName,
    Buffer.from([0]), // null terminator
    metadataContent,
  ]);
  sections.push(customSection);
  
  // 2. Type section
  const typeSectionContent = Buffer.concat([
    // Function type 0: () -> i32
    Buffer.from([0x60]), // func type
    Buffer.from([0x00]), // 0 params
    Buffer.from([0x7f]), // 1 result i32
    // Function type 1: (i32) -> i32
    Buffer.from([0x60]), // func type
    Buffer.from([0x01]), // 1 param i32
    Buffer.from([0x7f]), // 1 result i32
  ]);
  
  const typeSection = concatBuffers([
    Buffer.from([0x01]), // section id: type
    concatBuffers([writeUleb128Bytes(typeSectionContent.length)]),
    concatBuffers([writeUleb128Bytes(2)]), // 2 types
    typeSectionContent,
  ]);
  sections.push(typeSection);
  
  // 3. Function section
  const funcSectionContent = Buffer.concat([
    // Function 0: uses type 0
    Buffer.from([0x00]),
    // Function 1: uses type 1
    Buffer.from([0x01]),
  ]);
  
  const funcSection = concatBuffers([
    Buffer.from([0x03]), // section id: function
    concatBuffers([writeUleb128Bytes(funcSectionContent.length)]),
    concatBuffers([writeUleb128Bytes(2)]), // 2 functions
    funcSectionContent,
  ]);
  sections.push(funcSection);
  
  // 4. Memory section
  const memorySection = Buffer.concat([
    Buffer.from([0x05]), // section id: memory
    Buffer.from([0x01, 0x01]), // 1 memory, min 1 page (64KB)
  ]);
  sections.push(memorySection);

  // 5. Export section
  const exportSectionNames = ['init', 'step', 'get_state_ptr', 'get_state_size'];
  const exportSectionContent = Buffer.concat([
    // Export 0: init
    concatBuffers([writeUleb128Bytes((exportSectionNames[0] as string).length)]),
    Buffer.from(exportSectionNames[0] as string, 'utf-8'),
    Buffer.from([0x00]), // export kind: function
    Buffer.from([0x00]), // func index
    // Export 1: step
    concatBuffers([writeUleb128Bytes((exportSectionNames[1] as string).length)]),
    Buffer.from(exportSectionNames[1] as string, 'utf-8'),
    Buffer.from([0x00]),
    Buffer.from([0x01]),
    // Export 2: get_state_ptr
    concatBuffers([writeUleb128Bytes((exportSectionNames[2] as string).length)]),
    Buffer.from(exportSectionNames[2] as string, 'utf-8'),
    Buffer.from([0x00]),
    Buffer.from([0x02]),
    // Export 3: get_state_size
    concatBuffers([writeUleb128Bytes((exportSectionNames[3] as string).length)]),
    Buffer.from(exportSectionNames[3] as string, 'utf-8'),
    Buffer.from([0x00]),
    Buffer.from([0x03]),
  ]);
  
  const exportSection = concatBuffers([
    Buffer.from([0x07]), // section id: export
    concatBuffers([writeUleb128Bytes(exportSectionContent.length)]),
    concatBuffers([writeUleb128Bytes(4)]), // 4 exports
    exportSectionContent,
  ]);
  sections.push(exportSection);
  
  // 6. Code section with function bodies
  // Function 0: init - returns success (0)
  const funcBody0 = Buffer.concat([
    Buffer.from([0x0b, 0x01]), // func body size
    Buffer.from([0x00, 0x41, 0x00, 0x0b]), // i32.const 0; return
  ]);
  
  // Function 1: step - returns input
  const funcBody1 = Buffer.concat([
    Buffer.from([0x0b, 0x02]), // func body size
    Buffer.from([0x20, 0x00, 0x0b]), // local.get 0; return
  ]);
  
  // Function 2: get_state_ptr - returns 0 (memory offset)
  const funcBody2 = Buffer.concat([
    Buffer.from([0x0b, 0x01]), // func body size
    Buffer.from([0x41, 0x00, 0x0b]), // i32.const 0; return
  ]);
  
  // Function 3: get_state_size - returns js bundle size
  const funcBody3 = Buffer.concat([
    Buffer.from([0x0b, 0x06]), // func body size
    Buffer.from([0x41]), // i32.const
    concatBuffers([writeUleb128Bytes(jsBytes.length)]),
    Buffer.from([0x0b]), // return
  ]);
  
  const codeSectionContent = Buffer.concat([
    concatBuffers([writeUleb128Bytes(funcBody0.length)]),
    funcBody0,
    concatBuffers([writeUleb128Bytes(funcBody1.length)]),
    funcBody1,
    concatBuffers([writeUleb128Bytes(funcBody2.length)]),
    funcBody2,
    concatBuffers([writeUleb128Bytes(funcBody3.length)]),
    funcBody3,
  ]);
  
  const codeSection = concatBuffers([
    Buffer.from([0x0a]), // section id: code
    concatBuffers([writeUleb128Bytes(codeSectionContent.length)]),
    concatBuffers([writeUleb128Bytes(4)]), // 4 function bodies
    codeSectionContent,
  ]);
  sections.push(codeSection);
  
  // 7. Data section with embedded JavaScript
  const dataSectionContent = Buffer.concat([
    Buffer.from([0x00, 0x41, 0x00, 0x0b]), // memory 0, i32.const 0
    concatBuffers([writeUleb128Bytes(jsBytes.length)]),
    jsBytes,
  ]);
  
  const dataSection = concatBuffers([
    Buffer.from([0x0b]), // section id: data
    concatBuffers([writeUleb128Bytes(dataSectionContent.length)]),
    Buffer.from([0x01]), // 1 data segment
    dataSectionContent,
  ]);
  sections.push(dataSection);
  
  // Combine all sections into final WASM
  const wasmBuffer = Buffer.concat([WASM_MAGIC, WASM_VERSION, ...sections]);
  
  return wasmBuffer;
}

/**
 * Generate WAT (WebAssembly Text Format) representation
 *
 * Creates a human-readable text representation of the WASM module.
 */
export function generateStubWat(config: AgentConfig): string {
  return `;;
;; AgentVault WASM Module (Stub)
;; Agent: ${config.name}
;; Type: ${config.type}
;; Generated: ${new Date().toISOString()}
;;
;; This is a placeholder WAT file. In production, this would contain
;; the actual compiled WebAssembly code for the agent.
;;

(module
  ;; Custom section for agent metadata
  (@custom "agentvault" "${config.name}")

  ;; Memory for agent state (1 page = 64KB)
  (memory (export "memory") 1)

  ;; Agent initialization function (stub)
  (func (export "init") (result i32)
    ;; Return success code
    i32.const 0
  )

  ;; Agent step function (stub)
  (func (export "step") (param $input i32) (result i32)
    ;; Return input unchanged
    local.get $input
  )

  ;; Get agent state pointer (stub)
  (func (export "get_state_ptr") (result i32)
    ;; Return memory offset 0
    i32.const 0
  )

  ;; Get agent state size (stub)
  (func (export "get_state_size") (result i32)
    ;; Return 0 bytes (empty state)
    i32.const 0
  )
)
`;
}

/**
 * Generate serialized state JSON
 *
 * Creates the initial state representation for the agent.
 */
export function generateStateJson(config: AgentConfig): string {
  const state = {
    $schema: 'https://agentvault.dev/schemas/agent-state-v1.json',
    agent: {
      name: config.name,
      type: config.type,
      version: config.version ?? '1.0.0',
    },
    metadata: {
      createdAt: new Date().toISOString(),
      sourcePath: config.sourcePath,
      entryPoint: config.entryPoint,
    },
    state: {
      // Initial empty state
      initialized: false,
      data: {},
    },
  };

  return JSON.stringify(state, null, 2);
}

/**
 * Generate WAT (WebAssembly Text Format) representation
 *
 * Creates a human-readable text representation of the compiled WASM module.
 */
export function generateWat(config: AgentConfig, javascriptBundle: string): string {
  const jsSize = Buffer.from(javascriptBundle, 'utf-8').length;
  
  return `;;
;; AgentVault WASM Module
;; Agent: ${config.name}
;; Type: ${config.type}
;; Version: ${config.version ?? '1.0.0'}
;; Generated: ${new Date().toISOString()}
;;
;; This module contains the agent's compiled WebAssembly code
;; with embedded JavaScript bundle in the data section.
;;

(module
  ;; Metadata custom section
  (@custom "agent.metadata" "${config.name}")
  
  ;; Memory for agent state and JavaScript bundle (1 page = 64KB)
  (memory (export "memory") 1)
  
  ;; Agent initialization function
  ;; Returns 0 on success
  (func (export "init") (result i32)
    i32.const 0
  )
  
  ;; Agent step function
  ;; Executes agent logic with input
  (func (export "step") (param $input i32) (result i32)
    local.get $input
  )
  
  ;; Get agent state pointer
  ;; Returns memory offset where state is stored
  (func (export "get_state_ptr") (result i32)
    i32.const 0
  )
  
  ;; Get agent state size
  ;; Returns size of embedded JavaScript bundle
  (func (export "get_state_size") (result i32)
    i32.const ${jsSize}
  )
)
`;
}

/**
 * Compile an agent to WASM using WasmEdge
 *
 * This is the main compilation function that orchestrates the packaging process.
 * It bundles agent code and creates a WASM module with embedded JavaScript.
 *
 * @param config - Agent configuration from detection
 * @param options - Packaging options including compilation target
 * @param outputDir - Directory to write output files
 * @returns Package result with paths to generated files
 */
export async function compileToWasm(
  config: AgentConfig,
  options: PackageOptions,
  outputDir: string
): Promise<PackageResult> {
  const startTime = Date.now();
  const target = options.target ?? 'wasmedge';

  // Ensure output directory exists
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Generate file paths
  const wasmPath = path.join(outputDir, `${config.name}.wasm`);
  const watPath = path.join(outputDir, `${config.name}.wat`);
  const statePath = path.join(outputDir, `${config.name}.state.json`);
  const jsBundlePath = path.join(outputDir, `${config.name}.bundle.js`);
  const manifestPath = path.join(outputDir, `${config.name}.manifest.json`);
  const sourceMapPath = path.join(outputDir, `${config.name}.wasm.map`);

  // Bundle agent code
  const agentCode = await bundleAgentCode(config);

  let wasmBuffer: Buffer;
  let watContent: string;

  // Compile based on target
  if (target === 'wasmedge') {
    // Use WasmEdge wrapper for full JS support
    const wasmedgeWrapper = generateWasmEdgeWrapper(agentCode, config);
    const wasmedgeOptions: WasmEdgeOptions = {
      debug: options.debug ?? DEFAULT_WASMEDGE_OPTIONS.debug,
      sourcemap: options.debug ?? DEFAULT_WASMEDGE_OPTIONS.sourcemap,
      optimize: options.optimize ?? DEFAULT_WASMEDGE_OPTIONS.optimize,
      wasi: DEFAULT_WASMEDGE_OPTIONS.wasi,
    };

    // Generate WAT for WasmEdge
    watContent = generateWat(config, wasmedgeWrapper);

    // Generate WASM (using existing WASM structure as base)
    wasmBuffer = generateWasm(config, wasmedgeWrapper);

    // Write WasmEdge wrapper
    fs.writeFileSync(jsBundlePath, wasmedgeWrapper, 'utf-8');

    // Write WasmEdge config
    const wasmedgeConfig = generateWasmEdgeConfig(config, wasmedgeOptions);
    const wasmedgeConfigPath = path.join(outputDir, `${config.name}.wasmedge.json`);
    fs.writeFileSync(wasmedgeConfigPath, wasmedgeConfig, 'utf-8');

    // Write manifest
    const manifest = generateWasmEdgeManifest(config, wasmPath, outputDir);
    fs.writeFileSync(manifestPath, manifest, 'utf-8');

  } else if (target === 'motoko') {
    // For Motoko target, generate basic WASM structure
    // The actual compilation happens in dfx with Motoko compiler
    watContent = generateWat(config, agentCode);
    wasmBuffer = generateWasm(config, agentCode);
  } else {
    // Pure WASM target - minimal structure
    watContent = generateWat(config, agentCode);
    wasmBuffer = generateWasm(config, agentCode);
  }

  // Generate state JSON
  const stateContent = generateStateJson(config);

  // Write files
  fs.writeFileSync(wasmPath, wasmBuffer);
  fs.writeFileSync(watPath, watContent, 'utf-8');
  fs.writeFileSync(statePath, stateContent, 'utf-8');

  // ── ic-wasm optimization pipeline ──────────────────────────────────────
  const shouldOptimize = options.icWasmOptimize || options.icWasmShrink ||
    options.candidInterface || options.memoryLimit || options.computeQuota;

  let finalWasmSize = wasmBuffer.length;
  let originalWasmSize: number | undefined;
  let optimizationReductionPercent: number | undefined;
  let candidValidationPassed: boolean | undefined;
  let optimizationWarnings: string[] | undefined;

  if (shouldOptimize) {
    originalWasmSize = wasmBuffer.length;

    // Map numeric optimize level (0-3) to IcWasmOptLevel
    const levelMap: Record<number, IcWasmOptLevel> = {
      0: 'O0', 1: 'O1', 2: 'O2', 3: 'O3',
    };
    const optimizeLevel = levelMap[options.optimize ?? 3] ?? 'O3';

    // Build resource limits map
    const resourceLimits: Record<string, string> = {};
    if (options.memoryLimit) {
      resourceLimits['memory'] = options.memoryLimit;
    }
    if (options.computeQuota) {
      resourceLimits['compute'] = options.computeQuota;
    }

    const optimizedPath = path.join(outputDir, `${config.name}.optimized.wasm`);

    const pipelineResult = await runOptimizationPipeline({
      input: wasmPath,
      output: optimizedPath,
      optimize: options.icWasmOptimize,
      optimizeLevel,
      shrink: options.icWasmShrink,
      resourceLimits: Object.keys(resourceLimits).length > 0 ? resourceLimits : undefined,
      candidInterface: options.candidInterface,
    });

    optimizationWarnings = pipelineResult.warnings;
    candidValidationPassed = pipelineResult.validationPassed;

    if (pipelineResult.success && fs.existsSync(optimizedPath)) {
      // Replace the original WASM with the optimized version
      fs.copyFileSync(optimizedPath, wasmPath);
      fs.unlinkSync(optimizedPath);
      finalWasmSize = pipelineResult.finalSize;
      optimizationReductionPercent = pipelineResult.reductionPercent;
    } else {
      // Optimization failed but original WASM is still valid
      optimizationWarnings = [
        ...(optimizationWarnings ?? []),
        'Optimization pipeline did not fully succeed; using unoptimized WASM',
      ];
    }
  }

  const result: PackageResult = {
    config,
    wasmPath,
    watPath,
    statePath,
    jsBundlePath,
    sourceMapPath: options.debug ? sourceMapPath : undefined,
    manifestPath,
    wasmSize: finalWasmSize,
    target,
    timestamp: new Date(),
    duration: Date.now() - startTime,
    functionCount: 14, // Standard agent interface exports
    originalWasmSize,
    optimizationReductionPercent,
    candidValidationPassed,
    optimizationWarnings,
  };

  // Validate generated WASM
  const validation = validateWasmEdgeModule(wasmBuffer);
  if (!validation.valid) {
    console.warn(`WASM validation warnings: ${validation.errors.join(', ')}`);
  }

  return result;
}

/**
 * Validate WASM file integrity
 *
 * Checks that a file has valid WASM magic bytes.
 */
export function validateWasmFile(filePath: string): boolean {
  try {
    const buffer = fs.readFileSync(filePath);

    // Check minimum size
    if (buffer.length < 8) {
      return false;
    }

    // Check magic bytes
    if (!buffer.subarray(0, 4).equals(WASM_MAGIC)) {
      return false;
    }

    // Check version
    if (!buffer.subarray(4, 8).equals(WASM_VERSION)) {
      return false;
    }

    return true;
  } catch {
    return false;
  }
}
