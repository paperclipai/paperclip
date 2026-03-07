"use strict";
/**
 * Wallet Storage Module
 *
 * Manages encrypted wallet persistence in ~/.agentvault/wallets/
 * Provides per-agent wallet isolation and encryption.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getWalletBaseDir = getWalletBaseDir;
exports.getAgentWalletDir = getAgentWalletDir;
exports.getWalletFilePath = getWalletFilePath;
exports.ensureWalletDirectories = ensureWalletDirectories;
exports.saveWallet = saveWallet;
exports.loadWallet = loadWallet;
exports.deleteWallet = deleteWallet;
exports.listWallets = listWallets;
exports.listAgents = listAgents;
exports.walletExists = walletExists;
exports.getWalletStats = getWalletStats;
exports.backupWallets = backupWallets;
exports.restoreWallets = restoreWallets;
exports.clearWallets = clearWallets;
exports.getWalletStorageSize = getWalletStorageSize;
var fs = require("node:fs");
var path = require("node:path");
var os = require("node:os");
var cbor_serializer_js_1 = require("./cbor-serializer.js");
/**
 * Get base directory for wallet storage
 *
 * @param options - Storage options
 * @returns Wallet base directory
 */
function getWalletBaseDir(options) {
    if (options === void 0) { options = {}; }
    var baseDir = options.baseDir || path.join(os.homedir(), '.agentvault', 'wallets');
    return baseDir;
}
/**
 * Get agent-specific wallet directory
 *
 * @param agentId - Agent ID
 * @param options - Storage options
 * @returns Agent wallet directory
 */
function getAgentWalletDir(agentId, options) {
    if (options === void 0) { options = {}; }
    var baseDir = getWalletBaseDir(options);
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
function getWalletFilePath(agentId, walletId, options) {
    if (options === void 0) { options = {}; }
    var agentDir = getAgentWalletDir(agentId, options);
    return path.join(agentDir, "".concat(walletId, ".wallet"));
}
/**
 * Ensure wallet directories exist
 *
 * @param agentId - Agent ID
 * @param options - Storage options
 */
function ensureWalletDirectories(agentId, options) {
    if (options === void 0) { options = {}; }
    var agentDir = getAgentWalletDir(agentId, options);
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
function saveWallet(wallet, options) {
    if (options === void 0) { options = {}; }
    // Ensure directories exist
    ensureWalletDirectories(wallet.agentId, options);
    // Serialize wallet to CBOR
    var serialized = (0, cbor_serializer_js_1.serializeWallet)(wallet);
    // Get wallet file path
    var walletPath = getWalletFilePath(wallet.agentId, wallet.id, options);
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
function loadWallet(agentId, walletId, options) {
    if (options === void 0) { options = {}; }
    var walletPath = getWalletFilePath(agentId, walletId, options);
    // Check if wallet file exists
    if (!fs.existsSync(walletPath)) {
        return null;
    }
    // Read wallet file
    var data = fs.readFileSync(walletPath);
    // Validate CBOR data
    if (!(0, cbor_serializer_js_1.validateCborData)(new Uint8Array(data))) {
        throw new Error("Invalid wallet data: ".concat(walletId));
    }
    // Deserialize wallet
    var wallet = (0, cbor_serializer_js_1.deserializeWallet)(new Uint8Array(data));
    return wallet;
}
/**
 * Delete wallet from storage
 *
 * @param agentId - Agent ID
 * @param walletId - Wallet ID
 * @param options - Storage options
 */
function deleteWallet(agentId, walletId, options) {
    if (options === void 0) { options = {}; }
    var walletPath = getWalletFilePath(agentId, walletId, options);
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
function listWallets(agentId, options) {
    if (options === void 0) { options = {}; }
    var agentDir = getAgentWalletDir(agentId, options);
    // Check if agent directory exists
    if (!fs.existsSync(agentDir)) {
        return [];
    }
    // Read all wallet files
    var files = fs.readdirSync(agentDir);
    // Filter and extract wallet IDs
    var walletIds = files
        .filter(function (file) { return file.endsWith('.wallet'); })
        .map(function (file) { return file.replace('.wallet', ''); });
    return walletIds;
}
/**
 * List all agents with wallets
 *
 * @param options - Storage options
 * @returns Array of agent IDs
 */
function listAgents(options) {
    if (options === void 0) { options = {}; }
    var baseDir = getWalletBaseDir(options);
    // Check if base directory exists
    if (!fs.existsSync(baseDir)) {
        return [];
    }
    // Read all agent directories
    var agents = fs.readdirSync(baseDir);
    // Filter out non-directories
    var agentIds = agents.filter(function (agent) {
        var agentPath = path.join(baseDir, agent);
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
function walletExists(agentId, walletId, options) {
    if (options === void 0) { options = {}; }
    var walletPath = getWalletFilePath(agentId, walletId, options);
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
function getWalletStats(agentId, walletId, options) {
    if (options === void 0) { options = {}; }
    var walletPath = getWalletFilePath(agentId, walletId, options);
    if (!fs.existsSync(walletPath)) {
        return null;
    }
    var stats = fs.statSync(walletPath);
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
function backupWallets(agentId, backupPath, options) {
    if (options === void 0) { options = {}; }
    var agentDir = getAgentWalletDir(agentId, options);
    if (!fs.existsSync(agentDir)) {
        throw new Error("No wallets found for agent: ".concat(agentId));
    }
    // Create backup directory
    var backupDir = path.join(backupPath, agentId);
    if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
    }
    // Copy all wallet files
    var files = fs.readdirSync(agentDir);
    for (var _i = 0, files_1 = files; _i < files_1.length; _i++) {
        var file = files_1[_i];
        var srcPath = path.join(agentDir, file);
        var destPath = path.join(backupDir, file);
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
function restoreWallets(agentId, backupPath, options) {
    if (options === void 0) { options = {}; }
    var agentDir = getAgentWalletDir(agentId, options);
    if (!fs.existsSync(backupPath)) {
        throw new Error("Backup directory not found: ".concat(backupPath));
    }
    // Ensure agent directory exists
    ensureWalletDirectories(agentId, options);
    // Copy all wallet files from backup
    var files = fs.readdirSync(backupPath);
    for (var _i = 0, files_2 = files; _i < files_2.length; _i++) {
        var file = files_2[_i];
        if (file.endsWith('.wallet')) {
            var srcPath = path.join(backupPath, file);
            var destPath = path.join(agentDir, file);
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
function clearWallets(agentId, options) {
    if (options === void 0) { options = {}; }
    var agentDir = getAgentWalletDir(agentId, options);
    if (!fs.existsSync(agentDir)) {
        return; // Nothing to clear
    }
    // Delete all wallet files
    var files = fs.readdirSync(agentDir);
    for (var _i = 0, files_3 = files; _i < files_3.length; _i++) {
        var file = files_3[_i];
        var filePath = path.join(agentDir, file);
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
function getWalletStorageSize(agentId, options) {
    if (options === void 0) { options = {}; }
    var agentDir = getAgentWalletDir(agentId, options);
    if (!fs.existsSync(agentDir)) {
        return 0;
    }
    var totalSize = 0;
    var files = fs.readdirSync(agentDir);
    for (var _i = 0, files_4 = files; _i < files_4.length; _i++) {
        var file = files_4[_i];
        var filePath = path.join(agentDir, file);
        var stats = fs.statSync(filePath);
        if (stats.isFile() && file.endsWith('.wallet')) {
            totalSize += stats.size;
        }
    }
    return totalSize;
}
