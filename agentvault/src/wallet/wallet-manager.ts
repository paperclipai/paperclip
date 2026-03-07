/**
 * Wallet Manager
 *
 * Main wallet management module.
 * Handles wallet creation, storage, and retrieval with per-agent isolation.
 * Phase 5A: Added canister sync functionality.
 */

import { randomBytes } from 'node:crypto';
import {
  saveWallet,
  loadWallet,
  deleteWallet,
  listWallets,
  walletExists,
} from './wallet-storage.js';
import {
  deriveWalletKey,
  validateSeedPhrase,
  generateMnemonic,
} from './key-derivation.js';
import type {
  WalletData,
  WalletCreationOptions,
  WalletStorageOptions,
  HsmWalletCreationOptions,
} from './types.js';

// HSM imports (lazy load to keep non-HSM paths free of HSM dependencies)
import type { HsmProvider } from './hsm/types.js';

// Phase 5A: Canister imports (lazy load)
let _createActor: any = null;
let _canisterInitialized = false;

/**
 * Lazy load canister actor
 */
async function loadCanister() {
  if (_canisterInitialized) return;

  try {
     const { createActor } = await import('../canister/actor.js');
    _createActor = createActor;
    _canisterInitialized = true;
  } catch (error) {
    console.warn('Canister integration not available:', error);
  }
}

/**
 * Get or create canister actor
 */
async function getCanisterActor(canisterId: string) {
  await loadCanister();

  if (!_createActor) {
    throw new Error('Canister actor not initialized');
  }

  const { createAnonymousAgent } = await import('../canister/actor.js');
  const agent = createAnonymousAgent();
  return _createActor(canisterId, agent);
}

/**
 * In-memory wallet connections cache
 */
const walletConnections = new Map<string, any>();

/**
 * Generate unique wallet ID
 *
 * @returns Unique wallet ID
 */
function generateWalletId(): string {
  const bytes = randomBytes(16);
  return `wallet-${bytes.toString('hex')}`;
}

/**
 * Create a new wallet
 *
 * @param options - Wallet creation options
 * @param storageOptions - Storage options
 * @returns Created wallet data
 */
export function createWallet(
  options: WalletCreationOptions,
  storageOptions: WalletStorageOptions = {}
): WalletData {
  // Derive wallet key
  const derivedKey = deriveWalletKey(
    options.method,
    options.seedPhrase,
    options.privateKey,
    options.derivationPath,
    options.chain
  );

  // Create wallet data object
  const walletData: WalletData = {
    id: options.walletId || generateWalletId(),
    agentId: options.agentId,
    chain: options.chain,
    address: derivedKey.address,
    privateKey: options.method === 'private-key' ? derivedKey.privateKey : undefined,
    mnemonic: (options.method === 'seed' || options.method === 'mnemonic')
      ? options.seedPhrase
      : undefined,
    seedDerivationPath: derivedKey.derivationPath,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    creationMethod: options.method,
    chainMetadata: options.chainMetadata,
  };

  // Save wallet to storage
  saveWallet(walletData, storageOptions);

  return walletData;
}

/**
 * Import wallet from private key
 *
 * @param agentId - Agent ID
 * @param chain - Blockchain type
 * @param privateKey - Private key (hex)
 * @param storageOptions - Storage options
 * @returns Imported wallet data
 */
export function importWalletFromPrivateKey(
  agentId: string,
  chain: string,
  privateKey: string,
  storageOptions: WalletStorageOptions = {}
): WalletData {
  return createWallet({
    agentId,
    chain: chain as any,
    method: 'private-key',
    privateKey,
  }, storageOptions);
}

/**
 * Import wallet from seed phrase
 *
 * @param agentId - Agent ID
 * @param chain - Blockchain type
 * @param seedPhrase - BIP39 seed phrase
 * @param derivationPath - Optional custom derivation path
 * @param storageOptions - Storage options
 * @returns Imported wallet data
 */
export function importWalletFromSeed(
  agentId: string,
  chain: string,
  seedPhrase: string,
  derivationPath?: string,
  storageOptions: WalletStorageOptions = {}
): WalletData {
  return createWallet({
    agentId,
    chain: chain as any,
    method: 'seed',
    seedPhrase,
    derivationPath,
  }, storageOptions);
}

/**
 * Import wallet from mnemonic
 *
 * @param agentId - Agent ID
 * @param chain - Blockchain type
 * @param mnemonic - BIP39 mnemonic phrase
 * @param derivationPath - Optional custom derivation path
 * @param storageOptions - Storage options
 * @returns Imported wallet data
 */
export function importWalletFromMnemonic(
  agentId: string,
  chain: string,
  mnemonic: string,
  derivationPath?: string,
  storageOptions: WalletStorageOptions = {}
): WalletData {
  return createWallet({
    agentId,
    chain: chain as any,
    method: 'mnemonic',
    seedPhrase: mnemonic,
    derivationPath,
  }, storageOptions);
}

/**
 * Generate new wallet
 *
 * @param agentId - Agent ID
 * @param chain - Blockchain type
 * @param storageOptions - Storage options
 * @returns Generated wallet data
 */
export function generateWallet(
  agentId: string,
  chain: string,
  storageOptions: WalletStorageOptions = {}
): WalletData {
  const mnemonic = generateMnemonic(128);
  return importWalletFromSeed(agentId, chain, mnemonic, undefined, storageOptions);
}

/**
 * Get wallet by ID
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param storageOptions - Storage options
 * @returns Wallet data or null if not found
 */
export function getWallet(
  agentId: string,
  walletId: string,
  storageOptions: WalletStorageOptions = {}
): WalletData | null {
  return loadWallet(agentId, walletId, storageOptions);
}

/**
 * List all wallets for an agent
 *
 * @param agentId - Agent ID
 * @param storageOptions - Storage options
 * @returns Array of wallet IDs
 */
export function listAgentWallets(
  agentId: string,
  storageOptions: WalletStorageOptions = {}
): string[] {
  return listWallets(agentId, storageOptions);
}

/**
 * Check if wallet exists
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param storageOptions - Storage options
 * @returns True if wallet exists
 */
export function hasWallet(
  agentId: string,
  walletId: string,
  storageOptions: WalletStorageOptions = {}
): boolean {
  return walletExists(agentId, walletId, storageOptions);
}

/**
 * Remove wallet
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param storageOptions - Storage options
 */
export function removeWallet(
  agentId: string,
  walletId: string,
  storageOptions: WalletStorageOptions = {}
): void {
  deleteWallet(agentId, walletId, storageOptions);
  
  // Remove from connections cache
  walletConnections.delete(`${agentId}:${walletId}`);
}

/**
 * Clear all wallets for an agent
 *
 * @param agentId - Agent ID
 * @param storageOptions - Storage options
 */
export function clearAgentWallets(
  agentId: string,
  storageOptions: WalletStorageOptions = {}
): void {
  const walletIds = listWallets(agentId, storageOptions);

  for (const walletId of walletIds) {
    deleteWallet(agentId, walletId, storageOptions);
    walletConnections.delete(`${agentId}:${walletId}`);
  }
}

/**
 * Cache wallet connection
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param provider - Provider instance
 */
export function cacheWalletConnection(
  agentId: string,
  walletId: string,
  provider: any
): void {
  walletConnections.set(`${agentId}:${walletId}`, provider);
}

/**
 * Get cached wallet connection
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @returns Cached provider or undefined
 */
export function getCachedConnection(
  agentId: string,
  walletId: string
): any {
  return walletConnections.get(`${agentId}:${walletId}`);
}

/**
 * Clear wallet connection cache
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 */
export function clearCachedConnection(
  agentId: string,
  walletId: string
): void {
  walletConnections.delete(`${agentId}:${walletId}`);
}

/**
 * Validate seed phrase
 *
 * @param seedPhrase - Seed phrase to validate
 * @returns True if valid
 */
export function validateSeedPhraseWrapper(seedPhrase: string): boolean {
  return validateSeedPhrase(seedPhrase);
}

// ==================== HSM / TEE Keygen ====================

/**
 * Create a wallet whose private key is generated and permanently stored inside
 * a hardware secure element (Ledger) or Trusted Execution Environment (SGX).
 *
 * Security guarantees:
 *   - The private key is generated inside the secure boundary.
 *   - The BIP39 mnemonic never exists in this process (Ledger) or is sealed
 *     inside the enclave (SGX).
 *   - Only the public key and chain address cross the hardware boundary.
 *   - The returned WalletData has privateKey=undefined and mnemonic=undefined.
 *
 * @param options        - HSM-specific wallet creation options.
 * @param storageOptions - Where / how to persist the wallet metadata.
 * @returns WalletData with address/publicKey populated, secrets absent.
 *
 * @throws {HsmNotAvailableError}   when device / daemon is unreachable.
 * @throws {HsmCurveUnsupportedError} when the chain's curve is unsupported.
 * @throws {HsmOperationError}      on device-level failures.
 */
export async function createWalletWithHsm(
  options: HsmWalletCreationOptions,
  storageOptions: WalletStorageOptions = {},
): Promise<WalletData> {
  const { createHsmProvider } = await import('./hsm/index.js');
  const { getDefaultDerivationPath } = await import('./key-derivation.js');

  // Determine curve from chain
  const chain = options.chain.toLowerCase();
  const isEd25519Chain = ['solana', 'icp', 'arweave'].includes(chain);
  const curve = isEd25519Chain ? 'ed25519' : 'secp256k1';

  const derivationPath = options.derivationPath ?? getDefaultDerivationPath(chain);

  let provider: HsmProvider | null = null;
  try {
    provider = await createHsmProvider(options.hsmBackend, options.hsmOptions ?? {});

    const pubKeyResult = await provider.getPublicKey(derivationPath, curve);
    const deviceId = await provider.deviceId();

    const walletData: WalletData = {
      id: options.walletId ?? generateWalletId(),
      agentId: options.agentId,
      chain: options.chain,
      address: pubKeyResult.address,
      // No privateKey or mnemonic – they stay inside the hardware boundary.
      privateKey: undefined,
      mnemonic: undefined,
      seedDerivationPath: derivationPath,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      creationMethod: 'hsm',
      chainMetadata: {
        hsm: {
          backend: options.hsmBackend,
          deviceId,
          derivationPath,
          curve,
          createdAt: new Date().toISOString(),
          publicKeyHex: pubKeyResult.publicKeyHex,
        },
      },
    };

    saveWallet(walletData, storageOptions);
    return walletData;
  } finally {
    if (provider) await provider.close();
  }
}

// ==================== Phase 5A: Canister Sync Functions ====================

/**
 * Sync wallet to canister (register wallet metadata)
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param canisterId - Canister ID to sync to
 * @returns Sync result
 */
export async function syncWalletToCanister(
  agentId: string,
  walletId: string,
  canisterId: string
): Promise<{ success: boolean; error?: string; registeredAt?: number }> {
  try {
    await loadCanister();

    if (!_createActor) {
      return { success: false, error: 'Canister not available' };
    }

    const wallet = getWallet(agentId, walletId);
    if (!wallet) {
      return { success: false, error: 'Wallet not found' };
    }

    const actor = await getCanisterActor(canisterId);

    const result = await actor.registerWallet({
      id: walletId,
      agentId,
      chain: wallet.chain,
      address: wallet.address,
      registeredAt: BigInt(wallet.createdAt),
      status: { active: null },
    });

    if ('ok' in result) {
      return {
        success: true,
        registeredAt: wallet.createdAt,
      };
    } else {
      return {
        success: false,
        error: result.err,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Sync all wallets for an agent to canister
 *
 * @param agentId - Agent ID
 * @param canisterId - Canister ID to sync to
 * @returns Sync results
 */
export async function syncAgentWallets(
  agentId: string,
  canisterId: string
): Promise<{ synced: string[]; failed: { walletId: string; error: string }[] }> {
  const walletIds = listAgentWallets(agentId);
  const synced: string[] = [];
  const failed: { walletId: string; error: string }[] = [];

  for (const walletId of walletIds) {
    const result = await syncWalletToCanister(agentId, walletId, canisterId);
    if (result.success) {
      synced.push(walletId);
    } else {
      failed.push({
        walletId,
        error: result.error || 'Unknown error',
      });
    }
  }

  return { synced, failed };
}

/**
 * Get wallet sync status
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param canisterId - Canister ID
 * @returns Wallet sync status
 */
export async function getWalletSyncStatus(
  agentId: string,
  walletId: string,
  canisterId: string
): Promise<{
  walletId: string;
  inCanister: boolean;
  canisterStatus?: any;
  localExists: boolean;
  synced: boolean;
}> {
  try {
    await loadCanister();

    const localExists = hasWallet(agentId, walletId);
    let inCanister = false;
    let canisterStatus;

    if (_createActor) {
      const actor = await getCanisterActor(canisterId);
      const result = await actor.getWallet(walletId);

      if (result && result.length > 0) {
        inCanister = true;
        canisterStatus = result[0];
      }
    }

    const wallet = localExists ? getWallet(agentId, walletId) : null;
    const synced = inCanister && localExists && wallet && canisterStatus;

    return {
      walletId,
      inCanister,
      canisterStatus,
      localExists,
      synced,
    };
  } catch (_error) {
    return {
      walletId,
      inCanister: false,
      localExists: hasWallet(agentId, walletId),
      synced: false,
    };
  }
}

/**
 * List wallets from canister
 *
 * @param agentId - Agent ID
 * @param canisterId - Canister ID
 * @returns Array of canister wallet info
 */
export async function listCanisterWallets(
  agentId: string,
  canisterId: string
): Promise<any[]> {
  try {
    await loadCanister();

    if (!_createActor) {
      return [];
    }

    const actor = await getCanisterActor(canisterId);
    return await actor.listWallets(agentId);
  } catch (error) {
    console.error('Failed to list canister wallets:', error);
    return [];
  }
}

/**
 * Deregister wallet from canister
 *
 * @param walletId - Wallet ID
 * @param canisterId - Canister ID
 * @returns Deregistration result
 */
export async function deregisterWalletFromCanister(
  walletId: string,
  canisterId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await loadCanister();

    if (!_createActor) {
      return { success: false, error: 'Canister not available' };
    }

    const actor = await getCanisterActor(canisterId);
    const result = await actor.deregisterWallet(walletId);

    if ('ok' in result) {
      return { success: true };
    } else {
      return {
        success: false,
        error: result.err,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Update wallet status in canister
 *
 * @param walletId - Wallet ID
 * @param status - New status
 * @param canisterId - Canister ID
 * @returns Update result
 */
export async function updateCanisterWalletStatus(
  walletId: string,
  status: 'active' | 'inactive' | 'revoked',
  canisterId: string
): Promise<{ success: boolean; error?: string }> {
  try {
    await loadCanister();

    if (!_createActor) {
      return { success: false, error: 'Canister not available' };
    }

    const actor = await getCanisterActor(canisterId);

    const statusVariant =
      status === 'active'
        ? { active: null }
        : status === 'inactive'
          ? { inactive: null }
          : { revoked: null };

    const result = await actor.updateWalletStatus(walletId, statusVariant);

    if ('ok' in result) {
      return { success: true };
    } else {
      return {
        success: false,
        error: result.err,
      };
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}
