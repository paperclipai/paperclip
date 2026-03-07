"use strict";
/**
 * Wallet Manager
 *
 * Main wallet management module.
 * Handles wallet creation, storage, and retrieval with per-agent isolation.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createWallet = createWallet;
exports.importWalletFromPrivateKey = importWalletFromPrivateKey;
exports.importWalletFromSeed = importWalletFromSeed;
exports.importWalletFromMnemonic = importWalletFromMnemonic;
exports.generateWallet = generateWallet;
exports.getWallet = getWallet;
exports.listAgentWallets = listAgentWallets;
exports.hasWallet = hasWallet;
exports.removeWallet = removeWallet;
exports.clearAgentWallets = clearAgentWallets;
exports.cacheWalletConnection = cacheWalletConnection;
exports.getCachedConnection = getCachedConnection;
exports.clearCachedConnection = clearCachedConnection;
exports.validateSeedPhraseWrapper = validateSeedPhraseWrapper;
var node_crypto_1 = require("node:crypto");
var wallet_storage_js_1 = require("./wallet-storage.js");
var key_derivation_js_1 = require("./key-derivation.js");
/**
 * In-memory wallet connections cache
 */
var walletConnections = new Map();
/**
 * Generate unique wallet ID
 *
 * @returns Unique wallet ID
 */
function generateWalletId() {
    var bytes = (0, node_crypto_1.randomBytes)(16);
    return "wallet-".concat(bytes.toString('hex'));
}
/**
 * Create a new wallet
 *
 * @param options - Wallet creation options
 * @param storageOptions - Storage options
 * @returns Created wallet data
 */
function createWallet(options, storageOptions) {
    if (storageOptions === void 0) { storageOptions = {}; }
    // Derive wallet key
    var derivedKey = (0, key_derivation_js_1.deriveWalletKey)(options.method, options.seedPhrase, options.privateKey, options.derivationPath, options.chain);
    // Create wallet data object
    var walletData = {
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
    (0, wallet_storage_js_1.saveWallet)(walletData, storageOptions);
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
function importWalletFromPrivateKey(agentId, chain, privateKey, storageOptions) {
    if (storageOptions === void 0) { storageOptions = {}; }
    return createWallet({
        agentId: agentId,
        chain: chain,
        method: 'private-key',
        privateKey: privateKey,
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
function importWalletFromSeed(agentId, chain, seedPhrase, derivationPath, storageOptions) {
    if (storageOptions === void 0) { storageOptions = {}; }
    return createWallet({
        agentId: agentId,
        chain: chain,
        method: 'seed',
        seedPhrase: seedPhrase,
        derivationPath: derivationPath,
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
function importWalletFromMnemonic(agentId, chain, mnemonic, derivationPath, storageOptions) {
    if (storageOptions === void 0) { storageOptions = {}; }
    return createWallet({
        agentId: agentId,
        chain: chain,
        method: 'mnemonic',
        seedPhrase: mnemonic,
        derivationPath: derivationPath,
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
function generateWallet(agentId, chain, storageOptions) {
    if (storageOptions === void 0) { storageOptions = {}; }
    var mnemonic = (0, key_derivation_js_1.generateMnemonic)(128);
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
function getWallet(agentId, walletId, storageOptions) {
    if (storageOptions === void 0) { storageOptions = {}; }
    return (0, wallet_storage_js_1.loadWallet)(agentId, walletId, storageOptions);
}
/**
 * List all wallets for an agent
 *
 * @param agentId - Agent ID
 * @param storageOptions - Storage options
 * @returns Array of wallet IDs
 */
function listAgentWallets(agentId, storageOptions) {
    if (storageOptions === void 0) { storageOptions = {}; }
    return (0, wallet_storage_js_1.listWallets)(agentId, storageOptions);
}
/**
 * Check if wallet exists
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param storageOptions - Storage options
 * @returns True if wallet exists
 */
function hasWallet(agentId, walletId, storageOptions) {
    if (storageOptions === void 0) { storageOptions = {}; }
    return (0, wallet_storage_js_1.walletExists)(agentId, walletId, storageOptions);
}
/**
 * Remove wallet
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param storageOptions - Storage options
 */
function removeWallet(agentId, walletId, storageOptions) {
    if (storageOptions === void 0) { storageOptions = {}; }
    (0, wallet_storage_js_1.deleteWallet)(agentId, walletId, storageOptions);
    // Remove from connections cache
    walletConnections.delete("".concat(agentId, ":").concat(walletId));
}
/**
 * Clear all wallets for an agent
 *
 * @param agentId - Agent ID
 * @param storageOptions - Storage options
 */
function clearAgentWallets(agentId, storageOptions) {
    if (storageOptions === void 0) { storageOptions = {}; }
    var walletIds = (0, wallet_storage_js_1.listWallets)(agentId, storageOptions);
    for (var _i = 0, walletIds_1 = walletIds; _i < walletIds_1.length; _i++) {
        var walletId = walletIds_1[_i];
        (0, wallet_storage_js_1.deleteWallet)(agentId, walletId, storageOptions);
        walletConnections.delete("".concat(agentId, ":").concat(walletId));
    }
}
/**
 * Cache wallet connection
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param provider - Provider instance
 */
function cacheWalletConnection(agentId, walletId, provider) {
    walletConnections.set("".concat(agentId, ":").concat(walletId), provider);
}
/**
 * Get cached wallet connection
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @returns Cached provider or undefined
 */
function getCachedConnection(agentId, walletId) {
    return walletConnections.get("".concat(agentId, ":").concat(walletId));
}
/**
 * Clear wallet connection cache
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 */
function clearCachedConnection(agentId, walletId) {
    walletConnections.delete("".concat(agentId, ":").concat(walletId));
}
/**
 * Validate seed phrase
 *
 * @param seedPhrase - Seed phrase to validate
 * @returns True if valid
 */
function validateSeedPhraseWrapper(seedPhrase) {
    return (0, key_derivation_js_1.validateSeedPhrase)(seedPhrase);
}
