/**
 * Wallet Manager
 *
 * Main wallet management module.
 * Handles wallet creation, storage, and retrieval with per-agent isolation.
 */
import { randomBytes } from 'node:crypto';
import { saveWallet, loadWallet, deleteWallet, listWallets, walletExists, } from './wallet-storage.js';
import { deriveWalletKey, validateSeedPhrase, generateMnemonic, } from './key-derivation.js';
/**
 * In-memory wallet connections cache
 */
const walletConnections = new Map();
/**
 * Generate unique wallet ID
 *
 * @returns Unique wallet ID
 */
function generateWalletId() {
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
export function createWallet(options, storageOptions = {}) {
    // Derive wallet key
    const derivedKey = deriveWalletKey(options.method, options.seedPhrase, options.privateKey, options.derivationPath, options.chain);
    // Create wallet data object
    const walletData = {
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
export function importWalletFromPrivateKey(agentId, chain, privateKey, storageOptions = {}) {
    return createWallet({
        agentId,
        chain: chain,
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
export function importWalletFromSeed(agentId, chain, seedPhrase, derivationPath, storageOptions = {}) {
    return createWallet({
        agentId,
        chain: chain,
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
export function importWalletFromMnemonic(agentId, chain, mnemonic, derivationPath, storageOptions = {}) {
    return createWallet({
        agentId,
        chain: chain,
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
export function generateWallet(agentId, chain, storageOptions = {}) {
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
export function getWallet(agentId, walletId, storageOptions = {}) {
    return loadWallet(agentId, walletId, storageOptions);
}
/**
 * List all wallets for an agent
 *
 * @param agentId - Agent ID
 * @param storageOptions - Storage options
 * @returns Array of wallet IDs
 */
export function listAgentWallets(agentId, storageOptions = {}) {
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
export function hasWallet(agentId, walletId, storageOptions = {}) {
    return walletExists(agentId, walletId, storageOptions);
}
/**
 * Remove wallet
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param storageOptions - Storage options
 */
export function removeWallet(agentId, walletId, storageOptions = {}) {
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
export function clearAgentWallets(agentId, storageOptions = {}) {
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
export function cacheWalletConnection(agentId, walletId, provider) {
    walletConnections.set(`${agentId}:${walletId}`, provider);
}
/**
 * Get cached wallet connection
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @returns Cached provider or undefined
 */
export function getCachedConnection(agentId, walletId) {
    return walletConnections.get(`${agentId}:${walletId}`);
}
/**
 * Clear wallet connection cache
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 */
export function clearCachedConnection(agentId, walletId) {
    walletConnections.delete(`${agentId}:${walletId}`);
}
/**
 * Validate seed phrase
 *
 * @param seedPhrase - Seed phrase to validate
 * @returns True if valid
 */
export function validateSeedPhraseWrapper(seedPhrase) {
    return validateSeedPhrase(seedPhrase);
}
