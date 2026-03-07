"use strict";
/**
 * Wallet Module
 *
 * Complete wallet management system for ckETH, Polkadot, and Solana.
 * Provides per-agent wallet isolation, encryption, and CBOR serialization.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.SolanaProvider = exports.PolkadotProvider = exports.CkEthProvider = exports.BaseWalletProvider = exports.validateSeedPhraseWrapper = exports.clearCachedConnection = exports.getCachedConnection = exports.cacheWalletConnection = exports.clearAgentWallets = exports.removeWallet = exports.hasWallet = exports.listAgentWallets = exports.getWallet = exports.generateWallet = exports.importWalletFromMnemonic = exports.importWalletFromSeed = exports.importWalletFromPrivateKey = exports.createWallet = exports.deriveWalletKey = exports.getDefaultDerivationPath = exports.generateMnemonic = exports.generateSeedFromMnemonic = exports.validateSeedPhrase = exports.buildDerivationPath = exports.parseDerivationPath = exports.getWalletStorageSize = exports.clearWallets = exports.restoreWallets = exports.backupWallets = exports.getWalletStats = exports.walletExists = exports.listAgents = exports.listWallets = exports.deleteWallet = exports.loadWallet = exports.saveWallet = exports.ensureWalletDirectories = exports.getWalletFilePath = exports.getAgentWalletDir = exports.getWalletBaseDir = exports.validateCborData = exports.deserializeSignedTransaction = exports.serializeSignedTransaction = exports.deserializeTransactionRequest = exports.serializeTransactionRequest = exports.deserializeTransaction = exports.serializeTransaction = exports.deserializeWallet = exports.serializeWallet = void 0;
// Types
__exportStar(require("./types.js"), exports);
// CBOR Serialization
var cbor_serializer_js_1 = require("./cbor-serializer.js");
Object.defineProperty(exports, "serializeWallet", { enumerable: true, get: function () { return cbor_serializer_js_1.serializeWallet; } });
Object.defineProperty(exports, "deserializeWallet", { enumerable: true, get: function () { return cbor_serializer_js_1.deserializeWallet; } });
Object.defineProperty(exports, "serializeTransaction", { enumerable: true, get: function () { return cbor_serializer_js_1.serializeTransaction; } });
Object.defineProperty(exports, "deserializeTransaction", { enumerable: true, get: function () { return cbor_serializer_js_1.deserializeTransaction; } });
Object.defineProperty(exports, "serializeTransactionRequest", { enumerable: true, get: function () { return cbor_serializer_js_1.serializeTransactionRequest; } });
Object.defineProperty(exports, "deserializeTransactionRequest", { enumerable: true, get: function () { return cbor_serializer_js_1.deserializeTransactionRequest; } });
Object.defineProperty(exports, "serializeSignedTransaction", { enumerable: true, get: function () { return cbor_serializer_js_1.serializeSignedTransaction; } });
Object.defineProperty(exports, "deserializeSignedTransaction", { enumerable: true, get: function () { return cbor_serializer_js_1.deserializeSignedTransaction; } });
Object.defineProperty(exports, "validateCborData", { enumerable: true, get: function () { return cbor_serializer_js_1.validateCborData; } });
// Wallet Storage
var wallet_storage_js_1 = require("./wallet-storage.js");
Object.defineProperty(exports, "getWalletBaseDir", { enumerable: true, get: function () { return wallet_storage_js_1.getWalletBaseDir; } });
Object.defineProperty(exports, "getAgentWalletDir", { enumerable: true, get: function () { return wallet_storage_js_1.getAgentWalletDir; } });
Object.defineProperty(exports, "getWalletFilePath", { enumerable: true, get: function () { return wallet_storage_js_1.getWalletFilePath; } });
Object.defineProperty(exports, "ensureWalletDirectories", { enumerable: true, get: function () { return wallet_storage_js_1.ensureWalletDirectories; } });
Object.defineProperty(exports, "saveWallet", { enumerable: true, get: function () { return wallet_storage_js_1.saveWallet; } });
Object.defineProperty(exports, "loadWallet", { enumerable: true, get: function () { return wallet_storage_js_1.loadWallet; } });
Object.defineProperty(exports, "deleteWallet", { enumerable: true, get: function () { return wallet_storage_js_1.deleteWallet; } });
Object.defineProperty(exports, "listWallets", { enumerable: true, get: function () { return wallet_storage_js_1.listWallets; } });
Object.defineProperty(exports, "listAgents", { enumerable: true, get: function () { return wallet_storage_js_1.listAgents; } });
Object.defineProperty(exports, "walletExists", { enumerable: true, get: function () { return wallet_storage_js_1.walletExists; } });
Object.defineProperty(exports, "getWalletStats", { enumerable: true, get: function () { return wallet_storage_js_1.getWalletStats; } });
Object.defineProperty(exports, "backupWallets", { enumerable: true, get: function () { return wallet_storage_js_1.backupWallets; } });
Object.defineProperty(exports, "restoreWallets", { enumerable: true, get: function () { return wallet_storage_js_1.restoreWallets; } });
Object.defineProperty(exports, "clearWallets", { enumerable: true, get: function () { return wallet_storage_js_1.clearWallets; } });
Object.defineProperty(exports, "getWalletStorageSize", { enumerable: true, get: function () { return wallet_storage_js_1.getWalletStorageSize; } });
// Key Derivation
var key_derivation_js_1 = require("./key-derivation.js");
Object.defineProperty(exports, "parseDerivationPath", { enumerable: true, get: function () { return key_derivation_js_1.parseDerivationPath; } });
Object.defineProperty(exports, "buildDerivationPath", { enumerable: true, get: function () { return key_derivation_js_1.buildDerivationPath; } });
Object.defineProperty(exports, "validateSeedPhrase", { enumerable: true, get: function () { return key_derivation_js_1.validateSeedPhrase; } });
Object.defineProperty(exports, "generateSeedFromMnemonic", { enumerable: true, get: function () { return key_derivation_js_1.generateSeedFromMnemonic; } });
Object.defineProperty(exports, "generateMnemonic", { enumerable: true, get: function () { return key_derivation_js_1.generateMnemonic; } });
Object.defineProperty(exports, "getDefaultDerivationPath", { enumerable: true, get: function () { return key_derivation_js_1.getDefaultDerivationPath; } });
Object.defineProperty(exports, "deriveWalletKey", { enumerable: true, get: function () { return key_derivation_js_1.deriveWalletKey; } });
// Wallet Manager
var wallet_manager_js_1 = require("./wallet-manager.js");
Object.defineProperty(exports, "createWallet", { enumerable: true, get: function () { return wallet_manager_js_1.createWallet; } });
Object.defineProperty(exports, "importWalletFromPrivateKey", { enumerable: true, get: function () { return wallet_manager_js_1.importWalletFromPrivateKey; } });
Object.defineProperty(exports, "importWalletFromSeed", { enumerable: true, get: function () { return wallet_manager_js_1.importWalletFromSeed; } });
Object.defineProperty(exports, "importWalletFromMnemonic", { enumerable: true, get: function () { return wallet_manager_js_1.importWalletFromMnemonic; } });
Object.defineProperty(exports, "generateWallet", { enumerable: true, get: function () { return wallet_manager_js_1.generateWallet; } });
Object.defineProperty(exports, "getWallet", { enumerable: true, get: function () { return wallet_manager_js_1.getWallet; } });
Object.defineProperty(exports, "listAgentWallets", { enumerable: true, get: function () { return wallet_manager_js_1.listAgentWallets; } });
Object.defineProperty(exports, "hasWallet", { enumerable: true, get: function () { return wallet_manager_js_1.hasWallet; } });
Object.defineProperty(exports, "removeWallet", { enumerable: true, get: function () { return wallet_manager_js_1.removeWallet; } });
Object.defineProperty(exports, "clearAgentWallets", { enumerable: true, get: function () { return wallet_manager_js_1.clearAgentWallets; } });
Object.defineProperty(exports, "cacheWalletConnection", { enumerable: true, get: function () { return wallet_manager_js_1.cacheWalletConnection; } });
Object.defineProperty(exports, "getCachedConnection", { enumerable: true, get: function () { return wallet_manager_js_1.getCachedConnection; } });
Object.defineProperty(exports, "clearCachedConnection", { enumerable: true, get: function () { return wallet_manager_js_1.clearCachedConnection; } });
Object.defineProperty(exports, "validateSeedPhraseWrapper", { enumerable: true, get: function () { return wallet_manager_js_1.validateSeedPhraseWrapper; } });
// Providers
var base_provider_js_1 = require("./providers/base-provider.js");
Object.defineProperty(exports, "BaseWalletProvider", { enumerable: true, get: function () { return base_provider_js_1.BaseWalletProvider; } });
var cketh_provider_js_1 = require("./providers/cketh-provider.js");
Object.defineProperty(exports, "CkEthProvider", { enumerable: true, get: function () { return cketh_provider_js_1.CkEthProvider; } });
var polkadot_provider_js_1 = require("./providers/polkadot-provider.js");
Object.defineProperty(exports, "PolkadotProvider", { enumerable: true, get: function () { return polkadot_provider_js_1.PolkadotProvider; } });
var solana_provider_js_1 = require("./providers/solana-provider.js");
Object.defineProperty(exports, "SolanaProvider", { enumerable: true, get: function () { return solana_provider_js_1.SolanaProvider; } });
