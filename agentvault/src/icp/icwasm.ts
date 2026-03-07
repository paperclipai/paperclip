/**
 * ic-wasm Wrapper
 *
 * TypeScript wrapper around the ic-wasm CLI tool (v0.9.11).
 * Provides typed interfaces for WASM optimization, shrinking,
 * metadata management, resource limiting, endpoint validation,
 * and instrumentation.
 *
 * Usage pattern:
 *   ic-wasm [OPTIONS] <INPUT> <COMMAND>
 *   Output is written with -o <OUTPUT>
 */

import { execa } from 'execa';
import type {
  IcWasmResult,
  IcWasmOptimizeOptions,
  IcWasmShrinkOptions,
  IcWasmResourceOptions,
  IcWasmMetadataOptions,
  IcWasmCheckEndpointsOptions,
  IcWasmInstrumentOptions,
  IcWasmInfo,
} from './types.js';

const IC_WASM_BIN = 'ic-wasm';

/**
 * Execute an ic-wasm command and return the result.
 *
 * @param args - Command-line arguments (after 'ic-wasm')
 * @param timeoutMs - Timeout in milliseconds (default 60s)
 * @returns Structured result with stdout, stderr, exitCode
 */
async function runIcWasm(args: string[], timeoutMs = 60_000): Promise<IcWasmResult> {
  try {
    const result = await execa(IC_WASM_BIN, args, {
      reject: false,
      timeout: timeoutMs,
    });
    return {
      success: result.exitCode === 0,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 1,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return {
      success: false,
      stdout: '',
      stderr: message,
      exitCode: 1,
    };
  }
}

/**
 * Optimize a WASM module using wasm-opt.
 *
 * Applies dead-code elimination, constant folding, and other
 * optimizations to reduce WASM size and improve performance.
 *
 * @param options - Optimization options
 * @returns Command result
 */
export async function optimize(options: IcWasmOptimizeOptions): Promise<IcWasmResult> {
  const args = [options.input, 'optimize', '-o', options.output];
  if (options.level) {
    args.push(`--${options.level}`);
  }
  return runIcWasm(args, 120_000);
}

/**
 * Shrink a WASM module by removing unused functions and debug info.
 *
 * This is a lighter-weight optimization focused purely on size reduction
 * without the full wasm-opt pipeline.
 *
 * @param options - Shrink options
 * @returns Command result
 */
export async function shrink(options: IcWasmShrinkOptions): Promise<IcWasmResult> {
  const args = [options.input, 'shrink', '-o', options.output];
  return runIcWasm(args);
}

/**
 * Set resource limits on a WASM module.
 *
 * Embeds resource constraints (memory, compute) into the WASM metadata
 * so the ICP runtime can enforce them.
 *
 * @param options - Resource limit options
 * @returns Command result
 */
export async function setResource(options: IcWasmResourceOptions): Promise<IcWasmResult> {
  const args = [
    options.input,
    'resource',
    '-o', options.output,
    options.name,
    options.value,
  ];
  return runIcWasm(args);
}

/**
 * List metadata in a WASM module.
 *
 * @param input - Input WASM file path
 * @returns Command result with metadata listing in stdout
 */
export async function listMetadata(input: string): Promise<IcWasmResult> {
  return runIcWasm([input, 'metadata', 'list']);
}

/**
 * Get a specific metadata value from a WASM module.
 *
 * @param input - Input WASM file path
 * @param name - Metadata key name
 * @returns Command result with metadata value in stdout
 */
export async function getMetadata(input: string, name: string): Promise<IcWasmResult> {
  return runIcWasm([input, 'metadata', name]);
}

/**
 * Set metadata on a WASM module.
 *
 * @param options - Metadata options
 * @returns Command result
 */
export async function setMetadata(options: IcWasmMetadataOptions): Promise<IcWasmResult> {
  if (!options.output) {
    return {
      success: false,
      stdout: '',
      stderr: 'Output path is required for set metadata operations',
      exitCode: 1,
    };
  }

  const args = [options.input, 'metadata', options.name, '-o', options.output];

  if (options.data !== undefined) {
    args.push('-d', options.data);
  } else if (options.file) {
    args.push('-f', options.file);
  }

  if (options.visibility) {
    args.push('-v', options.visibility);
  }

  return runIcWasm(args);
}

/**
 * Get detailed information about a WASM canister module.
 *
 * @param input - Input WASM file path
 * @returns Parsed info result
 */
export async function info(input: string): Promise<IcWasmInfo> {
  const result = await runIcWasm([input, 'info']);
  const parsed: IcWasmInfo = { raw: result.stdout };

  // Best-effort parsing of info output into sections
  if (result.success && result.stdout) {
    const sections: Record<string, string> = {};
    const lines = result.stdout.split('\n');
    for (const line of lines) {
      const colonIdx = line.indexOf(':');
      if (colonIdx > 0) {
        const key = line.substring(0, colonIdx).trim();
        const value = line.substring(colonIdx + 1).trim();
        if (key && value) {
          sections[key] = value;
        }
      }
    }
    if (Object.keys(sections).length > 0) {
      parsed.sections = sections;
    }
  }

  return parsed;
}

/**
 * Validate canister endpoints against a Candid interface.
 *
 * Compares the exported functions in the WASM module against the
 * expected interface defined in a .did file. Returns success if
 * all endpoints match.
 *
 * @param options - Check endpoints options
 * @returns Command result (success means validation passed)
 */
export async function checkEndpoints(options: IcWasmCheckEndpointsOptions): Promise<IcWasmResult> {
  return runIcWasm([
    options.input,
    'check-endpoints',
    '--interface', options.candidInterface,
  ]);
}

/**
 * Instrument a WASM module for execution tracing (experimental).
 *
 * Modifies the WASM to emit execution traces to stable memory,
 * useful for debugging and profiling canister behavior.
 *
 * @param options - Instrument options
 * @returns Command result
 */
export async function instrument(options: IcWasmInstrumentOptions): Promise<IcWasmResult> {
  return runIcWasm([options.input, 'instrument', '-o', options.output]);
}
