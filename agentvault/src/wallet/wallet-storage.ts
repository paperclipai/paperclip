/**
 * Wallet Storage Module
 *
 * Manages encrypted wallet persistence in ~/.agentvault/wallets/
 * Provides per-agent wallet isolation and encryption.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  serializeWallet,
  deserializeWallet,
} from './cbor-serializer.js';
import {
  encryptWalletSecrets,
  decryptWalletSecrets,
} from './wallet-crypto.js';
import type {
  WalletData,
  WalletStorageOptions,
} from './types.js';

/**
 * Get base directory for wallet storage
 *
 * @param options - Storage options
 * @returns Wallet base directory
 */
export function getWalletBaseDir(options: WalletStorageOptions = {}): string {
  const baseDir = options.baseDir || path.join(os.homedir(), '.agentvault', 'wallets');
  return baseDir;
}

/**
 * Get agent-specific wallet directory
 *
 * @param agentId - Agent ID
 * @param options - Storage options
 * @returns Agent wallet directory
 */
export function getAgentWalletDir(
  agentId: string,
  options: WalletStorageOptions = {}
): string {
  const baseDir = getWalletBaseDir(options);
  return path.join(baseDir, agentId);
}

/**
 * Get wallet file path
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param options - Storage options
 * @returns Wallet file path
 */
export function getWalletFilePath(
  agentId: string,
  walletId: string,
  options: WalletStorageOptions = {}
): string {
  const agentDir = getAgentWalletDir(agentId, options);
  return path.join(agentDir, `${walletId}.wallet`);
}

/**
 * Ensure wallet directories exist
 *
 * @param agentId - Agent ID
 * @param options - Storage options
 */
export function ensureWalletDirectories(
  agentId: string,
  options: WalletStorageOptions = {}
): void {
  const agentDir = getAgentWalletDir(agentId, options);

  if (!fs.existsSync(agentDir)) {
    fs.mkdirSync(agentDir, { recursive: true });
  }
}

/**
 * Save wallet to storage, encrypting private keys and mnemonics with
 * AES-256-GCM when options.encryptionKey (a BIP39 mnemonic) is supplied.
 *
 * When encryption is active the on-disk CBOR file will contain an
 * `encryptedSecrets` bundle and the plaintext `privateKey` / `mnemonic`
 * fields will be absent, ensuring no sensitive material is committed to
 * the canister or filesystem in cleartext.
 *
 * @param wallet  - Wallet data to save
 * @param options - Storage options; supply `encryptionKey` to enable at-rest
 *                  encryption of private keys / mnemonics
 */
export function saveWallet(
  wallet: WalletData,
  options: WalletStorageOptions = {}
): void {
  // Ensure directories exist
  ensureWalletDirectories(wallet.agentId, options);

  // Encrypt sensitive fields when a key is available
  const walletToStore = options.encryptionKey
    ? encryptWalletSecrets(wallet, options.encryptionKey)
    : wallet;

  // Serialize wallet to CBOR
  const serialized = serializeWallet(walletToStore);

  // Get wallet file path
  const walletPath = getWalletFilePath(wallet.agentId, wallet.id, options);

  // Write wallet file
  fs.writeFileSync(walletPath, Buffer.from(serialized));
}

/**
 * Load wallet from storage, decrypting secrets when options.encryptionKey
 * is supplied and the wallet contains an encrypted bundle.
 *
 * @param agentId  - Agent ID
 * @param walletId - Wallet ID
 * @param options  - Storage options; supply `encryptionKey` to decrypt secrets
 * @returns Loaded (and optionally decrypted) wallet data, or null if not found
 */
export function loadWallet(
  agentId: string,
  walletId: string,
  options: WalletStorageOptions = {}
): WalletData | null {
  const walletPath = getWalletFilePath(agentId, walletId, options);

  // Check if wallet file exists
  if (!fs.existsSync(walletPath)) {
    return null;
  }

  // Read wallet file
  const data = fs.readFileSync(walletPath);

  // Deserialize wallet (validation is done inside deserializeWallet)
  const wallet = deserializeWallet(new Uint8Array(data));

  // Decrypt secrets when a key is present
  if (options.encryptionKey && wallet.encryptedSecrets) {
    return decryptWalletSecrets(wallet, options.encryptionKey);
  }

  return wallet;
}

/**
 * Delete wallet from storage
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param options - Storage options
 */
export function deleteWallet(
  agentId: string,
  walletId: string,
  options: WalletStorageOptions = {}
): void {
  const walletPath = getWalletFilePath(agentId, walletId, options);

  // Check if wallet file exists
  if (fs.existsSync(walletPath)) {
    fs.unlinkSync(walletPath);
  }
}

/**
 * List all wallets for an agent
 *
 * @param agentId - Agent ID
 * @param options - Storage options
 * @returns Array of wallet IDs
 */
export function listWallets(
  agentId: string,
  options: WalletStorageOptions = {}
): string[] {
  const agentDir = getAgentWalletDir(agentId, options);

  // Check if agent directory exists
  if (!fs.existsSync(agentDir)) {
    return [];
  }

  // Read all wallet files
  const files = fs.readdirSync(agentDir);

  // Filter and extract wallet IDs
  const walletIds = files
    .filter((file) => file.endsWith('.wallet'))
    .map((file) => file.replace('.wallet', ''));

  return walletIds;
}

/**
 * List all agents with wallets
 *
 * @param options - Storage options
 * @returns Array of agent IDs
 */
export function listAgents(options: WalletStorageOptions = {}): string[] {
  const baseDir = getWalletBaseDir(options);

  // Check if base directory exists
  if (!fs.existsSync(baseDir)) {
    return [];
  }

  // Read all agent directories
  const agents = fs.readdirSync(baseDir);

  // Filter out non-directories
  const agentIds = agents.filter((agent) => {
    const agentPath = path.join(baseDir, agent);
    return fs.statSync(agentPath).isDirectory();
  });

  return agentIds;
}

/**
 * Check if wallet exists
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param options - Storage options
 * @returns True if wallet exists
 */
export function walletExists(
  agentId: string,
  walletId: string,
  options: WalletStorageOptions = {}
): boolean {
  const walletPath = getWalletFilePath(agentId, walletId, options);
  return fs.existsSync(walletPath);
}

/**
 * Get wallet file stats
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param options - Storage options
 * @returns Wallet file stats or null if not found
 */
export function getWalletStats(
  agentId: string,
  walletId: string,
  options: WalletStorageOptions = {}
): {
  size: number;
  modified: Date;
  created: Date;
} | null {
  const walletPath = getWalletFilePath(agentId, walletId, options);

  if (!fs.existsSync(walletPath)) {
    return null;
  }

  const stats = fs.statSync(walletPath);

  return {
    size: stats.size,
    modified: stats.mtime,
    created: stats.birthtime,
  };
}

/**
 * Backup all wallets for an agent
 *
 * @param agentId - Agent ID
 * @param backupPath - Path to save backup
 * @param options - Storage options
 */
export function backupWallets(
  agentId: string,
  backupPath: string,
  options: WalletStorageOptions = {}
): void {
  const agentDir = getAgentWalletDir(agentId, options);

  if (!fs.existsSync(agentDir)) {
    throw new Error(`No wallets found for agent: ${agentId}`);
  }

  // Create backup directory
  const backupDir = path.join(backupPath, agentId);
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  // Copy all wallet files
  const files = fs.readdirSync(agentDir);
  for (const file of files) {
    const srcPath = path.join(agentDir, file);
    const destPath = path.join(backupDir, file);
    fs.copyFileSync(srcPath, destPath);
  }
}

/**
 * Restore wallets from backup
 *
 * @param agentId - Agent ID
 * @param backupPath - Path to backup directory
 * @param options - Storage options
 */
export function restoreWallets(
  agentId: string,
  backupPath: string,
  options: WalletStorageOptions = {}
): void {
  const agentDir = getAgentWalletDir(agentId, options);

  if (!fs.existsSync(backupPath)) {
    throw new Error(`Backup directory not found: ${backupPath}`);
  }

  // Ensure agent directory exists
  ensureWalletDirectories(agentId, options);

  // Copy all wallet files from backup
  const files = fs.readdirSync(backupPath);
  for (const file of files) {
    if (file.endsWith('.wallet')) {
      const srcPath = path.join(backupPath, file);
      const destPath = path.join(agentDir, file);
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * Clear all wallets for an agent
 *
 * @param agentId - Agent ID
 * @param options - Storage options
 */
export function clearWallets(
  agentId: string,
  options: WalletStorageOptions = {}
): void {
  const agentDir = getAgentWalletDir(agentId, options);

  if (!fs.existsSync(agentDir)) {
    return; // Nothing to clear
  }

  // Delete all wallet files
  const files = fs.readdirSync(agentDir);
  for (const file of files) {
    const filePath = path.join(agentDir, file);
    fs.unlinkSync(filePath);
  }
}

/**
 * Get total storage size for an agent
 *
 * @param agentId - Agent ID
 * @param options - Storage options
 * @returns Total size in bytes
 */
export function getWalletStorageSize(
  agentId: string,
  options: WalletStorageOptions = {}
): number {
  const agentDir = getAgentWalletDir(agentId, options);

  if (!fs.existsSync(agentDir)) {
    return 0;
  }

  let totalSize = 0;
  const files = fs.readdirSync(agentDir);

  for (const file of files) {
    const filePath = path.join(agentDir, file);
    const stats = fs.statSync(filePath);
    if (stats.isFile() && file.endsWith('.wallet')) {
      totalSize += stats.size;
    }
  }

  return totalSize;
}
