/**
 * icp-cli Wrapper
 *
 * TypeScript wrapper around the icp CLI tool (v0.1.0).
 * The binary name is `icp` (not `icp-cli`).
 *
 * Provides typed interfaces for build, deploy, canister operations,
 * cycles management, identity management, network management,
 * token operations, sync, and environment queries.
 */

import { execa } from 'execa';
import type {
  IcpCliResult,
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
  IcpCommonOptions,
} from './types.js';

const ICP_BIN = 'icp';

/**
 * Build common arguments from IcpCommonOptions.
 */
function buildCommonArgs(options: IcpCommonOptions): string[] {
  const args: string[] = [];
  if (options.environment) {
    args.push('-e', options.environment);
  }
  if (options.projectRoot) {
    args.push('--project-root-override', options.projectRoot);
  }
  if (options.identity) {
    args.push('--identity', options.identity);
  }
  if (options.identityPasswordFile) {
    args.push('--identity-password-file', options.identityPasswordFile);
  }
  if (options.debug) {
    args.push('--debug');
  }
  return args;
}

/**
 * Execute an icp command and return the result.
 *
 * @param args - Command-line arguments (after 'icp')
 * @param timeoutMs - Timeout in milliseconds (default 120s)
 * @param cwd - Working directory
 * @returns Structured result
 */
async function runIcp(
  args: string[],
  timeoutMs = 120_000,
  cwd?: string,
): Promise<IcpCliResult> {
  try {
    const result = await execa(ICP_BIN, args, {
      reject: false,
      timeout: timeoutMs,
      cwd,
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

// ─── Build ─────────────────────────────────────────────────────────────────

/**
 * Build canisters using icp build.
 *
 * @param options - Build options
 * @returns Command result
 */
export async function build(options: IcpBuildOptions = {}): Promise<IcpCliResult> {
  const args = ['build', ...buildCommonArgs(options)];
  if (options.canisters && options.canisters.length > 0) {
    args.push(...options.canisters);
  }
  return runIcp(args, 300_000, options.projectRoot);
}

// ─── Deploy ────────────────────────────────────────────────────────────────

/**
 * Deploy project to an environment.
 *
 * @param options - Deploy options
 * @returns Command result
 */
export async function deploy(options: IcpDeployOptions = {}): Promise<IcpCliResult> {
  const args = ['deploy', ...buildCommonArgs(options)];
  if (options.mode) {
    args.push('-m', options.mode);
  }
  if (options.canisters && options.canisters.length > 0) {
    args.push(...options.canisters);
  }
  return runIcp(args, 300_000, options.projectRoot);
}

// ─── Canister Operations ───────────────────────────────────────────────────

/**
 * Get canister status.
 *
 * @param options - Canister status options
 * @returns Command result with status in stdout
 */
export async function canisterStatus(options: IcpCanisterStatusOptions): Promise<IcpCliResult> {
  const args = ['canister', 'status', options.canister, ...buildCommonArgs(options)];
  return runIcp(args, 30_000, options.projectRoot);
}

/**
 * Call a canister method.
 *
 * @param options - Canister call options
 * @returns Command result with response in stdout
 */
export async function canisterCall(options: IcpCanisterCallOptions): Promise<IcpCliResult> {
  const args = ['canister', 'call', options.canister, options.method, ...buildCommonArgs(options)];
  if (options.args) {
    args.push(options.args);
  }
  return runIcp(args, 30_000, options.projectRoot);
}

/**
 * List canisters in the project.
 *
 * @param options - Common options
 * @returns Command result with canister list in stdout
 */
export async function canisterList(options: IcpCommonOptions = {}): Promise<IcpCliResult> {
  const args = ['canister', 'list', ...buildCommonArgs(options)];
  return runIcp(args, 15_000, options.projectRoot);
}

/**
 * Start a stopped canister.
 *
 * @param canister - Canister ID or name
 * @param options - Common options
 * @returns Command result
 */
export async function canisterStart(canister: string, options: IcpCommonOptions = {}): Promise<IcpCliResult> {
  const args = ['canister', 'start', canister, ...buildCommonArgs(options)];
  return runIcp(args, 30_000, options.projectRoot);
}

/**
 * Stop a running canister.
 *
 * @param canister - Canister ID or name
 * @param options - Common options
 * @returns Command result
 */
export async function canisterStop(canister: string, options: IcpCommonOptions = {}): Promise<IcpCliResult> {
  const args = ['canister', 'stop', canister, ...buildCommonArgs(options)];
  return runIcp(args, 30_000, options.projectRoot);
}

/**
 * Delete a canister.
 *
 * @param canister - Canister ID or name
 * @param options - Common options
 * @returns Command result
 */
export async function canisterDelete(canister: string, options: IcpCommonOptions = {}): Promise<IcpCliResult> {
  const args = ['canister', 'delete', canister, ...buildCommonArgs(options)];
  return runIcp(args, 30_000, options.projectRoot);
}

// ─── Cycles Management ────────────────────────────────────────────────────

/**
 * Check cycle balance of a canister.
 *
 * @param options - Cycles balance options
 * @returns Command result with balance in stdout
 */
export async function cyclesBalance(options: IcpCyclesBalanceOptions): Promise<IcpCliResult> {
  const args = ['cycles', 'balance', options.canister, ...buildCommonArgs(options)];
  return runIcp(args, 15_000, options.projectRoot);
}

/**
 * Mint cycles.
 *
 * @param options - Mint options
 * @returns Command result
 */
export async function cyclesMint(options: IcpCyclesMintOptions): Promise<IcpCliResult> {
  const args = ['cycles', 'mint', options.amount, ...buildCommonArgs(options)];
  return runIcp(args, 30_000, options.projectRoot);
}

/**
 * Transfer cycles to a canister.
 *
 * @param options - Transfer options
 * @returns Command result
 */
export async function cyclesTransfer(options: IcpCyclesTransferOptions): Promise<IcpCliResult> {
  const args = ['cycles', 'transfer', options.amount, '--to', options.to, ...buildCommonArgs(options)];
  return runIcp(args, 30_000, options.projectRoot);
}

// ─── Identity Management ──────────────────────────────────────────────────

/**
 * List available identities.
 *
 * @param options - Common options
 * @returns Command result with identity list in stdout
 */
export async function identityList(options: IcpIdentityListOptions = {}): Promise<IcpCliResult> {
  const args = ['identity', 'list', ...buildCommonArgs(options)];
  return runIcp(args, 15_000, options.projectRoot);
}

/**
 * Create a new identity.
 *
 * @param options - New identity options
 * @returns Command result
 */
export async function identityNew(options: IcpIdentityNewOptions): Promise<IcpCliResult> {
  const args = ['identity', 'new', ...(options.name ? [options.name] : []), ...buildCommonArgs(options)];
  return runIcp(args, 15_000, options.projectRoot);
}

/**
 * Export an identity.
 *
 * @param options - Export options
 * @returns Command result with PEM data in stdout
 */
export async function identityExport(options: IcpIdentityExportOptions): Promise<IcpCliResult> {
  const args = ['identity', 'export', ...(options.name ? [options.name] : []), ...buildCommonArgs(options)];
  return runIcp(args, 15_000, options.projectRoot);
}

/**
 * Import an identity from a PEM file.
 *
 * @param options - Import options
 * @returns Command result
 */
export async function identityImport(options: IcpIdentityImportOptions): Promise<IcpCliResult> {
  const args = ['identity', 'import', ...(options.name ? [options.name] : []), ...(options.pemFile ? [options.pemFile] : []), ...buildCommonArgs(options)];
  return runIcp(args, 15_000, options.projectRoot);
}

/**
 * Get the principal of the current or named identity.
 *
 * @param options - Common options (use identity field to specify which identity)
 * @returns Command result with principal in stdout
 */
export async function identityPrincipal(options: IcpCommonOptions = {}): Promise<IcpCliResult> {
  const args = ['identity', 'principal', ...buildCommonArgs(options)];
  return runIcp(args, 15_000, options.projectRoot);
}

/**
 * Get the default identity name.
 *
 * @param options - Common options
 * @returns Command result with default identity name in stdout
 */
export async function identityDefault(options: IcpCommonOptions = {}): Promise<IcpCliResult> {
  const args = ['identity', 'default', ...buildCommonArgs(options)];
  return runIcp(args, 15_000, options.projectRoot);
}

// ─── Network Management ───────────────────────────────────────────────────

/**
 * Start a local test network.
 *
 * @param options - Network start options
 * @returns Command result
 */
export async function networkStart(options: IcpNetworkStartOptions = {}): Promise<IcpCliResult> {
  const args = ['network', 'start', ...buildCommonArgs(options)];
  if (options.network) {
    args.push(options.network);
  }
  return runIcp(args, 60_000, options.projectRoot);
}

/**
 * Stop a local test network.
 *
 * @param options - Network stop options
 * @returns Command result
 */
export async function networkStop(options: IcpNetworkStopOptions = {}): Promise<IcpCliResult> {
  const args = ['network', 'stop', ...buildCommonArgs(options)];
  if (options.network) {
    args.push(options.network);
  }
  return runIcp(args, 30_000, options.projectRoot);
}

/**
 * Get network status.
 *
 * @param options - Common options
 * @returns Command result with status in stdout
 */
export async function networkStatus(options: IcpCommonOptions = {}): Promise<IcpCliResult> {
  const args = ['network', 'status', ...buildCommonArgs(options)];
  return runIcp(args, 15_000, options.projectRoot);
}

/**
 * List available networks.
 *
 * @param options - Common options
 * @returns Command result with network list in stdout
 */
export async function networkList(options: IcpCommonOptions = {}): Promise<IcpCliResult> {
  const args = ['network', 'list', ...buildCommonArgs(options)];
  return runIcp(args, 15_000, options.projectRoot);
}

/**
 * Ping a network to check connectivity.
 *
 * @param options - Common options
 * @returns Command result
 */
export async function networkPing(options: IcpCommonOptions = {}): Promise<IcpCliResult> {
  const args = ['network', 'ping', ...buildCommonArgs(options)];
  return runIcp(args, 15_000, options.projectRoot);
}

// ─── Sync ──────────────────────────────────────────────────────────────────

/**
 * Synchronize canisters with the network.
 *
 * @param options - Sync options
 * @returns Command result
 */
export async function sync(options: IcpSyncOptions = {}): Promise<IcpCliResult> {
  const args = ['sync', ...buildCommonArgs(options)];
  return runIcp(args, 120_000, options.projectRoot);
}

// ─── Token Operations ─────────────────────────────────────────────────────

/**
 * Get token balance.
 *
 * @param options - Token balance options
 * @returns Command result with balance in stdout
 */
export async function tokenBalance(options: IcpTokenBalanceOptions = {}): Promise<IcpCliResult> {
  const args = ['token', 'balance', ...buildCommonArgs(options)];
  if (options.canister) {
    args.push('--canister', options.canister);
  }
  return runIcp(args, 15_000, options.projectRoot);
}

/**
 * Transfer tokens.
 *
 * @param options - Token transfer options
 * @returns Command result
 */
export async function tokenTransfer(options: IcpTokenTransferOptions): Promise<IcpCliResult> {
  const args = ['token', 'transfer', options.amount, '--to', options.to, ...buildCommonArgs(options)];
  if (options.canister) {
    args.push('--canister', options.canister);
  }
  return runIcp(args, 30_000, options.projectRoot);
}

// ─── Environment ──────────────────────────────────────────────────────────

/**
 * List project environments.
 *
 * @param options - Common options
 * @returns Command result with environments in stdout
 */
export async function environmentList(options: IcpEnvironmentListOptions = {}): Promise<IcpCliResult> {
  const args = ['environment', 'list', ...buildCommonArgs(options)];
  return runIcp(args, 15_000, options.projectRoot);
}

// ─── Project ──────────────────────────────────────────────────────────────

/**
 * Show project information (effective YAML config).
 *
 * @param options - Common options
 * @returns Command result with project info in stdout
 */
export async function projectShow(options: IcpCommonOptions = {}): Promise<IcpCliResult> {
  const args = ['project', 'show', ...buildCommonArgs(options)];
  return runIcp(args, 15_000, options.projectRoot);
}
