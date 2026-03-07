"use strict";
/**
 * Base Wallet Provider
 *
 * Abstract base class for all blockchain wallet providers.
 * Defines common interface for wallet operations.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.BaseWalletProvider = void 0;
/**
 * Abstract base class for wallet providers
 */
var BaseWalletProvider = /** @class */ (function () {
    function BaseWalletProvider(config) {
        this.config = config;
        this.connected = false;
    }
    /**
     * Check connection status
     *
     * @returns True if connected
     */
    BaseWalletProvider.prototype.isConnected = function () {
        return this.connected;
    };
    /**
     * Get chain type
     *
     * @returns Chain type
     */
    BaseWalletProvider.prototype.getChain = function () {
        return this.config.chain;
    };
    /**
     * Get provider configuration
     *
     * @returns Provider configuration
     */
    BaseWalletProvider.prototype.getConfig = function () {
        return this.config;
    };
    /**
     * Get RPC URL
     *
     * @returns RPC endpoint URL
     */
    BaseWalletProvider.prototype.getRpcUrl = function () {
        return this.config.rpcUrl || '';
    };
    /**
     * Check if connected to testnet
     *
     * @returns True if using testnet
     */
    BaseWalletProvider.prototype.isTestnet = function () {
        var _a;
        return (_a = this.config.isTestnet) !== null && _a !== void 0 ? _a : false;
    };
    return BaseWalletProvider;
}());
exports.BaseWalletProvider = BaseWalletProvider;
