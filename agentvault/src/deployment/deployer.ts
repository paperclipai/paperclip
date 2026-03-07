/**
 * Agent Deployer
 *
 * Main orchestrator for the ICP canister deployment pipeline.
 * Coordinates validation, client setup, and deployment operations.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  DeployOptions,
  DeployResult,
  DeploymentError,
  CanisterInfo,
  NetworkType,
  DeploymentStatus,
} from './types.js';
import { createICPClient } from './icpClient.js';
import { detectToolchain } from '../icp/tool-detector.js';
import * as icpcli from '../icp/icpcli.js';
import { getEnvironment } from '../icp/environment.js';
import { loadPilotConfig, buildReplicaUrl, listPilotCompanies } from '../pilot/private-replica.js';

/**
 * Extract agent name from WASM file path
 */
function extractAgentName(wasmPath: string): string {
  const basename = path.basename(wasmPath);
  // Remove .wasm extension
  return basename.replace(/\.wasm$/, '');
}

/**
 * Validate deployment options
 */
export function validateDeployOptions(options: DeployOptions): {
  valid: boolean;
  errors: DeploymentError[];
  warnings: string[];
} {
  const errors: DeploymentError[] = [];
  const warnings: string[] = [];

  // Validate WASM path using client
  const client = createICPClient({ network: options.network });
  const wasmValidation = client.validateWasmPath(options.wasmPath);
  if (!wasmValidation.valid) {
    errors.push({
      code: 'INVALID_WASM',
      message: wasmValidation.error!,
    });
  }

  // Validate network - requires standard network name or an explicit environment config
  const knownNetworks = ['local', 'ic', 'mainnet', 'dev', 'staging', 'production', 'private'];
  if (!knownNetworks.includes(options.network)) {
    errors.push({
      code: 'INVALID_NETWORK',
      message: `Network '${options.network}' is not a standard name. Ensure it is defined in your icp.yaml.`,
    });
  }

  // Warn about mainnet deployment
  if (options.network === 'ic' && !options.skipConfirmation) {
    warnings.push(
      'Deploying to IC mainnet will consume cycles. Ensure you have sufficient balance.'
    );
  }

  // Warn about upgrade without canister ID check
  if (options.canisterId) {
    warnings.push(`Upgrading existing canister: ${options.canisterId}`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Get deployment preview/summary
 *
 * Useful for dry-run functionality
 */
export function getDeploySummary(options: DeployOptions): {
  agentName: string;
  wasmPath: string;
  wasmHash: string;
  wasmSize: number;
  network: NetworkType;
  isUpgrade: boolean;
  canisterId?: string;
  validation: ReturnType<typeof validateDeployOptions>;
} {
  const validation = validateDeployOptions(options);

  // Calculate WASM hash if file exists
  let wasmHash = '';
  let wasmSize = 0;
  if (validation.valid) {
    try {
      const client = createICPClient({ network: options.network });
      wasmHash = client.calculateWasmHash(options.wasmPath);
      wasmSize = fs.statSync(options.wasmPath).size;
    } catch {
      // File doesn't exist or can't be read
    }
  }

  return {
    agentName: extractAgentName(options.wasmPath),
    wasmPath: options.wasmPath,
    wasmHash,
    wasmSize,
    network: options.network,
    isUpgrade: !!options.canisterId,
    canisterId: options.canisterId,
    validation,
  };
}

/**
 * Deploy an agent to ICP
 *
 * This is the main entry point for the deployment pipeline.
 * Uses auto-detection to choose between icp-cli and the @dfinity/agent SDK.
 *
 * Priority: icp-cli > @dfinity/agent SDK (with dfx fallback)
 *
 * @param options - Deployment options
 * @returns Deployment result with canister info
 */
export async function deployAgent(options: DeployOptions): Promise<DeployResult> {
  // Validate options
  const validation = validateDeployOptions(options);
  if (!validation.valid) {
    const errorMessages = validation.errors.map((e) => e.message).join('; ');
    throw new Error(`Deployment validation failed: ${errorMessages}`);
  }

  // Private network: resolve replica URL from pilot config (PRD-004)
  if (options.network === 'private') {
    return deployToPrivateReplica(options, validation.warnings);
  }

  // Detect available toolchain
  const toolchain = await detectToolchain();

  // Determine which tool to use
  if (toolchain.icp.available && (options.environment || options.identity)) {
    // Use icp-cli when explicitly requesting environments or identity features
    return deployWithIcpCli(options, validation.warnings);
  } else if (toolchain.preferredDeployTool === 'icp') {
    // Prefer icp-cli when available
    return deployWithIcpCli(options, validation.warnings);
  } else {
    // Fall back to @dfinity/agent SDK
    return deployWithSdk(options, validation.warnings);
  }
}

/**
 * Deploy to a company's private ICP replica (PRD-004).
 *
 * Resolves the replica URL from the pilot config and delegates to
 * the dfx / icp-cli toolchain with --network private.
 */
async function deployToPrivateReplica(
  options: DeployOptions,
  warnings: string[],
): Promise<DeployResult> {
  // Find a pilot config – use environment name as company hint, or the first available
  const company = options.environment ?? listPilotCompanies()[0];
  if (!company) {
    throw new Error(
      'No pilot configuration found. Run `agentvault pilot init --company <name>` first.'
    );
  }

  const pilotConfig = loadPilotConfig(company);
  if (!pilotConfig) {
    throw new Error(
      `No pilot config found for company "${company}". Run \`agentvault pilot init --company "${company}"\` first.`
    );
  }

  const replicaUrl = buildReplicaUrl(pilotConfig.bindAddress, pilotConfig.port);
  warnings.push(`Deploying to private replica for "${company}" at ${replicaUrl}`);

  // Apply proxy env vars from pilot config
  const proxyEnv: Record<string, string> = {};
  if (pilotConfig.proxy.anthropicProxy) {
    proxyEnv['ANTHROPIC_BASE_URL'] = pilotConfig.proxy.anthropicProxy;
  }

  // Inject air-gap env if enabled
  if (pilotConfig.airGap.enabled) {
    proxyEnv['AGENTVAULT_AIR_GAP'] = '1';
    if (pilotConfig.airGap.allowedEndpoints.length > 0) {
      proxyEnv['AGENTVAULT_ALLOWED_ENDPOINTS'] = pilotConfig.airGap.allowedEndpoints.join(',');
    }
    warnings.push('Air-gap mode active: external internet access restricted.');
  }

  const toolchain = await detectToolchain();

  if (toolchain.preferredDeployTool === 'icp' || toolchain.icp.available) {
    const result = await icpcli.deploy({
      environment: 'private',
      identity: options.identity ?? pilotConfig.identityPath,
      mode: options.mode ?? (options.canisterId ? 'upgrade' : 'auto'),
      projectRoot: options.projectRoot,
    });

    if (!result.success) {
      throw new Error(`icp-cli deploy to private replica failed: ${result.stderr || result.stdout}`);
    }

    const canisterIdMatch = result.stdout.match(/([a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{3})/);
    const canisterId = canisterIdMatch?.[1] ?? options.canisterId ?? 'unknown';

    return {
      canister: {
        canisterId,
        network: 'private',
        agentName: path.basename(options.wasmPath).replace(/\.wasm$/, ''),
        deployedAt: new Date(),
      },
      isUpgrade: !!options.canisterId,
      warnings,
      deployTool: 'icp',
    };
  }

  // Fall back to SDK with overridden host
  const client = createICPClient({
    network: 'private',
    host: replicaUrl,
    identity: options.identityPath,
  });

  const deployResult = await client.deploy(options.wasmPath, options.canisterId);

  return {
    canister: {
      canisterId: deployResult.canisterId,
      network: 'private',
      agentName: path.basename(options.wasmPath).replace(/\.wasm$/, ''),
      deployedAt: new Date(),
      wasmHash: deployResult.wasmHash,
    },
    isUpgrade: deployResult.isUpgrade,
    cyclesUsed: deployResult.cyclesUsed,
    warnings,
    deployTool: 'sdk',
  };
}

/**
 * Deploy using icp-cli tool.
 */
async function deployWithIcpCli(
  options: DeployOptions,
  warnings: string[],
): Promise<DeployResult> {
  // Resolve environment from options or network
  const envName = options.environment ?? options.network;
  const envConfig = getEnvironment(envName);
  const identity = options.identity ?? envConfig.identity;

  // Determine deploy mode
  const mode = options.mode ?? (options.canisterId ? 'upgrade' : 'auto');

  const result = await icpcli.deploy({
    environment: envName,
    identity,
    mode,
    projectRoot: options.projectRoot,
  });

  if (!result.success) {
    throw new Error(`icp-cli deploy failed: ${result.stderr || result.stdout}`);
  }

  // Parse canister ID from output (best effort)
  const canisterIdMatch = result.stdout.match(/([a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{5}-[a-z0-9]{3})/);
  const canisterId = canisterIdMatch?.[1] ?? options.canisterId ?? 'unknown';

  const canisterInfo: CanisterInfo = {
    canisterId,
    network: options.network,
    agentName: extractAgentName(options.wasmPath),
    deployedAt: new Date(),
  };

  return {
    canister: canisterInfo,
    isUpgrade: mode === 'upgrade',
    warnings: [...warnings, `Deployed via icp-cli (environment: ${envName})`],
    deployTool: 'icp',
  };
}

/**
 * Deploy using @dfinity/agent SDK (original implementation).
 */
async function deployWithSdk(
  options: DeployOptions,
  warnings: string[],
): Promise<DeployResult> {
  // Create ICP client
  const client = createICPClient({
    network: options.network,
    identity: options.identityPath,
  });

  // Check network connection
  const connectionCheck = await client.checkConnection();
  if (!connectionCheck.connected) {
    throw new Error(
      `Failed to connect to ${options.network} network: ${connectionCheck.error ?? 'Unknown error'}`
    );
  }

  // Deploy the WASM
  const deployResult = await client.deploy(options.wasmPath, options.canisterId);

  // Build canister info
  const canisterInfo: CanisterInfo = {
    canisterId: deployResult.canisterId,
    network: options.network,
    agentName: extractAgentName(options.wasmPath),
    deployedAt: new Date(),
    wasmHash: deployResult.wasmHash,
  };

  return {
    canister: canisterInfo,
    isUpgrade: deployResult.isUpgrade,
    cyclesUsed: deployResult.cyclesUsed,
    warnings,
    deployTool: 'sdk',
  };
}

/**
 * Check if a canister exists and get its status
 */
export async function getCanisterStatus(
  canisterId: string,
  network: NetworkType
): Promise<{
  exists: boolean;
  status?: DeploymentStatus;
  memorySize?: bigint;
  cycles?: bigint;
}> {
  const client = createICPClient({ network });

  try {
    const status = await client.getCanisterStatus(canisterId);
    if (!status.exists) {
      return { exists: false };
    }

    return {
      exists: status.exists,
      status: status.status,
      memorySize: status.memorySize,
      cycles: status.cycles,
    };
  } catch {
    return { exists: false };
  }
}
