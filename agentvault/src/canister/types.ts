/**
 * Canister Types
 *
 * Shared types for canister integration.
 */

/**
 * Wallet information stored in canister (metadata only)
 */
export interface CanisterWalletInfo {
  id: string;
  agentId: string;
  chain: string;
  address: string;
  registeredAt: number;
  status: 'active' | 'inactive' | 'revoked';
}

/**
 * Wallet registration options
 */
export interface RegisterWalletOptions {
  agentId: string;
  chain: string;
  address: string;
  status?: 'active' | 'inactive' | 'revoked';
}

/**
 * Wallet sync status
 */
export interface WalletSyncStatus {
  walletId: string;
  inCanister: boolean;
  canisterStatus?: CanisterWalletInfo;
  localExists: boolean;
  synced: boolean;
  lastSyncedAt?: number;
}

/**
 * Canister connection options
 */
export interface CanisterConnectionOptions {
  canisterId: string;
  host?: string;
  anonymous?: boolean;
}

/**
 * Wallet sync result
 */
export interface WalletSyncResult {
  success: boolean;
  walletId?: string;
  error?: string;
  registeredAt?: number;
}
