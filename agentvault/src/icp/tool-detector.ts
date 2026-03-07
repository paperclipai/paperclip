/**
 * Tool Detector
 *
 * Auto-detects availability of ICP tools (ic-wasm, icp, dfx)
 * on the current system. Used for hybrid compatibility strategy:
 * prefer icp-cli when available, fall back to dfx.
 */

import { execa } from 'execa';
import type { ToolName, ToolInfo, ToolchainStatus } from './types.js';

/**
 * Allowed tool names for security - prevents arbitrary command execution
 */
const ALLOWED_TOOLS: readonly ToolName[] = ['ic-wasm', 'icp', 'dfx'] as const;

/**
 * Validate tool name against whitelist to prevent command injection
 */
function validateToolName(name: string): asserts name is ToolName {
  if (!ALLOWED_TOOLS.includes(name as ToolName)) {
    throw new Error(`Unknown tool: ${name}. Allowed tools: ${ALLOWED_TOOLS.join(', ')}`);
  }
}

/**
 * Detect whether a single tool is installed and get its version.
 *
 * @param name - Tool binary name
 * @returns ToolInfo with availability, path, and version
 */
export async function detectTool(name: ToolName): Promise<ToolInfo> {
  // Validate tool name against whitelist (security)
  validateToolName(name);

  const result: ToolInfo = { name, available: false };

  // Locate the binary using array arguments (prevents command injection)
  try {
    const whichResult = await execa('which', [name], {
      reject: false,
      timeout: 5000,
    });
    if (whichResult.exitCode === 0 && whichResult.stdout.trim()) {
      result.path = whichResult.stdout.trim();
    } else {
      return result;
    }
  } catch {
    return result;
  }

  // Get the version using array arguments (prevents command injection)
  try {
    const versionResult = await execa(name, ['--version'], {
      reject: false,
      timeout: 5000,
    });
    if (versionResult.exitCode === 0) {
      const output = versionResult.stdout.trim() || versionResult.stderr.trim();
      // Extract version number from output like "ic-wasm 0.9.11" or "icp 0.1.0" or "dfx 0.25.0"
      const match = output.match(/(\d+\.\d+\.\d+)/);
      if (match) {
        result.version = match[1];
      } else {
        result.version = output;
      }
      result.available = true;
    }
  } catch {
    // Binary exists but version check failed - still mark as available
    result.available = !!result.path;
  }

  return result;
}

/**
 * Detect all ICP tools and determine the preferred toolchain.
 *
 * @returns Complete toolchain status
 */
export async function detectToolchain(): Promise<ToolchainStatus> {
  const [icWasm, icp, dfx] = await Promise.all([
    detectTool('ic-wasm'),
    detectTool('icp'),
    detectTool('dfx'),
  ]);

  let preferredDeployTool: 'icp' | 'dfx' | null = null;
  if (icp.available) {
    preferredDeployTool = 'icp';
  } else if (dfx.available) {
    preferredDeployTool = 'dfx';
  }

  return {
    icWasm,
    icp,
    dfx,
    preferredDeployTool,
    canOptimize: icWasm.available,
  };
}

/**
 * Require a specific tool, throwing a descriptive error if not found.
 *
 * @param name - Tool to require
 * @param purpose - Human-readable description of why it's needed
 * @returns ToolInfo (guaranteed available)
 * @throws Error if tool is not available
 */
export async function requireTool(name: ToolName, purpose: string): Promise<ToolInfo> {
  const tool = await detectTool(name);
  if (!tool.available) {
    const installHints: Record<ToolName, string> = {
      'ic-wasm': 'Install with: cargo install ic-wasm',
      'icp': 'Install from: https://github.com/dfinity/icp-cli',
      'dfx': 'Install with: sh -ci "$(curl -fsSL https://sdk.dfinity.org/install.sh)"',
    };
    throw new Error(
      `Tool '${name}' is required for ${purpose} but was not found.\n${installHints[name]}`
    );
  }
  return tool;
}
