/**
 * Wallet Storage Module
 *
 * Manages encrypted wallet persistence in ~/.agentvault/wallets/
 * Provides per-agent wallet isolation and encryption.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { serializeWallet, deserializeWallet, validateCborData, } from './cbor-serializer.js';
/**
 * Get base directory for wallet storage
 *
 * @param options - Storage options
 * @returns Wallet base directory
 */
export function getWalletBaseDir(options = {}) {
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
export function getAgentWalletDir(agentId, options = {}) {
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
export function getWalletFilePath(agentId, walletId, options = {}) {
    const agentDir = getAgentWalletDir(agentId, options);
    return path.join(agentDir, `${walletId}.wallet`);
}
/**
 * Ensure wallet directories exist
 *
 * @param agentId - Agent ID
 * @param options - Storage options
 */
export function ensureWalletDirectories(agentId, options = {}) {
    const agentDir = getAgentWalletDir(agentId, options);
    if (!fs.existsSync(agentDir)) {
        fs.mkdirSync(agentDir, { recursive: true });
    }
}
/**
 * Save wallet to encrypted storage
 *
 * @param wallet - Wallet data to save
 * @param options - Storage options
 */
export function saveWallet(wallet, options = {}) {
    // Ensure directories exist
    ensureWalletDirectories(wallet.agentId, options);
    // Serialize wallet to CBOR
    const serialized = serializeWallet(wallet);
    // Get wallet file path
    const walletPath = getWalletFilePath(wallet.agentId, wallet.id, options);
    // Write wallet file
    fs.writeFileSync(walletPath, Buffer.from(serialized));
}
/**
 * Load wallet from storage
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param options - Storage options
 * @returns Loaded wallet data or null if not found
 */
export function loadWallet(agentId, walletId, options = {}) {
    const walletPath = getWalletFilePath(agentId, walletId, options);
    // Check if wallet file exists
    if (!fs.existsSync(walletPath)) {
        return null;
    }
    // Read wallet file
    const data = fs.readFileSync(walletPath);
    // Validate CBOR data
    if (!validateCborData(new Uint8Array(data))) {
        throw new Error(`Invalid wallet data: ${walletId}`);
    }
    // Deserialize wallet
    const wallet = deserializeWallet(new Uint8Array(data));
    return wallet;
}
/**
 * Delete wallet from storage
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param options - Storage options
 */
export function deleteWallet(agentId, walletId, options = {}) {
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
export function listWallets(agentId, options = {}) {
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
export function listAgents(options = {}) {
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
export function walletExists(agentId, walletId, options = {}) {
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
export function getWalletStats(agentId, walletId, options = {}) {
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
export function backupWallets(agentId, backupPath, options = {}) {
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
export function restoreWallets(agentId, backupPath, options = {}) {
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
export function clearWallets(agentId, options = {}) {
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
export function getWalletStorageSize(agentId, options = {}) {
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
