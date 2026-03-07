/**
 * Types for ICP canister deployment
 */

/**
 * Network target for deployment
 *
 * - 'local': Local dfx/icp replica
 * - 'ic': IC mainnet
 * - 'private': Company-owned private ICP replica (PRD-004)
 * - string: Named environment from icp.yaml (e.g. 'dev', 'staging', 'production')
 */
export type NetworkType = 'local' | 'ic' | 'private' | string;

/**
 * Which tool is being used for deployment
 */
export type DeployToolType = 'icp' | 'dfx' | 'sdk';

/**
 * Deployment status codes
 */
export type DeploymentStatus = 'pending' | 'deploying' | 'deployed' | 'failed' | 'running' | 'stopping' | 'stopped';

/**
 * Information about a deployed canister
 */
export interface CanisterInfo {
  /** Canister ID on the network */
  canisterId: string;
  /** Network where the canister is deployed */
  network: NetworkType;
  /** Agent name associated with this canister */
  agentName: string;
  /** Deployment timestamp */
  deployedAt: Date;
  /** WASM module hash (for verification) */
  wasmHash?: string;
}

/**
 * Options for deployment operation
 */
export interface DeployOptions {
  /** Path to the WASM file to deploy */
  wasmPath: string;
  /** Target network for deployment */
  network: NetworkType;
  /** Existing canister ID (for upgrades) */
  canisterId?: string;
  /** Skip confirmation prompts */
  skipConfirmation?: boolean;
  /** Path to dfx identity to use */
  identityPath?: string;

  // ── icp-cli options ───────────────────────────────────────────────────

  /** Named environment from icp.yaml */
  environment?: string;
  /** Identity name for icp-cli */
  identity?: string;
  /** Cycles allocation for deployment */
  cycles?: string;
  /** Deploy mode (auto, install, reinstall, upgrade) */
  mode?: 'auto' | 'install' | 'reinstall' | 'upgrade';
  /** Override project root for icp.yaml lookup */
  projectRoot?: string;
}

/**
 * Result of a successful deployment
 */
export interface DeployResult {
  /** Deployed canister information */
  canister: CanisterInfo;
  /** Whether this was a new deployment or upgrade */
  isUpgrade: boolean;
  /** Cycles consumed by deployment */
  cyclesUsed?: bigint;
  /** Any warnings during deployment */
  warnings: string[];
  /** Which tool was used for deployment */
  deployTool?: DeployToolType;
}

/**
 * Error that occurred during deployment
 */
export interface DeploymentError {
  /** Error code for programmatic handling */
  code: string;
  /** Human-readable error message */
  message: string;
  /** Network where the error occurred */
  network?: NetworkType;
  /** Canister ID if applicable */
  canisterId?: string;
}

/**
 * Configuration for ICP client
 */
export interface ICPClientConfig {
  /** Target network */
  network: NetworkType;
  /** Host URL (defaults based on network) */
  host?: string;
  /** Path to dfx identity file for signing */
  identity?: string;
  /** Canister ID for operations (optional, used when deploying/upgrading) */
  canisterId?: string;
}
