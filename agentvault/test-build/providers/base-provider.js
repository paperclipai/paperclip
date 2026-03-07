/**
 * Base Wallet Provider
 *
 * Abstract base class for all blockchain wallet providers.
 * Defines common interface for wallet operations.
 */
/**
 * Abstract base class for wallet providers
 */
export class BaseWalletProvider {
    config;
    connected;
    constructor(config) {
        this.config = config;
        this.connected = false;
    }
    /**
     * Check connection status
     *
     * @returns True if connected
     */
    isConnected() {
        return this.connected;
    }
    /**
     * Get chain type
     *
     * @returns Chain type
     */
    getChain() {
        return this.config.chain;
    }
    /**
     * Get provider configuration
     *
     * @returns Provider configuration
     */
    getConfig() {
        return this.config;
    }
    /**
     * Get RPC URL
     *
     * @returns RPC endpoint URL
     */
    getRpcUrl() {
        return this.config.rpcUrl || '';
    }
    /**
     * Check if connected to testnet
     *
     * @returns True if using testnet
     */
    isTestnet() {
        return this.config.isTestnet ?? false;
    }
}
