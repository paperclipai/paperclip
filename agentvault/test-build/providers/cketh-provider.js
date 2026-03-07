/**
 * ckETH Wallet Provider
 *
 * Provider for Ethereum-compatible wallets on ICP ckETH.
 * Supports balance queries, transactions, and signing.
 */
import { ethers } from 'ethers';
import { BaseWalletProvider } from './base-provider.js';
/**
 * ckETH wallet provider
 */
export class CkEthProvider extends BaseWalletProvider {
    provider = null;
    wallet = null;
    chainId;
    constructor(config) {
        super(config);
        this.chainId = config.chainId ?? 1; // Default to mainnet
    }
    /**
     * Connect to Ethereum network via RPC
     */
    async connect() {
        try {
            // Create provider
            this.provider = new ethers.JsonRpcProvider(this.getRpcUrl());
            // Verify connection
            const network = await this.provider.getNetwork();
            this.chainId = Number(network.chainId);
            this.connected = true;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to connect to ckETH network: ${message}`);
        }
    }
    /**
     * Disconnect from network
     */
    async disconnect() {
        this.provider = null;
        this.wallet = null;
        this.connected = false;
    }
    /**
     * Get wallet balance
     */
    async getBalance(address) {
        if (!this.provider || !this.connected) {
            throw new Error('Provider not connected');
        }
        try {
            const balance = await this.provider.getBalance(address);
            const etherBalance = ethers.formatEther(balance);
            return {
                amount: etherBalance,
                denomination: 'ETH',
                chain: this.getChain(),
                address,
                blockNumber: await this.provider.getBlockNumber(),
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to get balance: ${message}`);
        }
    }
    /**
     * Send transaction
     */
    async sendTransaction(from, request) {
        if (!this.provider || !this.connected) {
            throw new Error('Provider not connected');
        }
        try {
            const tx = await this.populateTransaction(from, request);
            const signedTx = await this.signTransaction(tx, from);
            // Send transaction
            const txHash = await this.provider.broadcastTransaction(signedTx.signedTx);
            return {
                hash: txHash,
                from,
                to: request.to,
                amount: request.amount,
                chain: this.getChain(),
                timestamp: Date.now(),
                status: 'pending',
                fee: tx.gasPrice ? ethers.formatEther(BigInt(tx.gasPrice) * BigInt(tx.gasLimit || 21000)) : undefined,
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to send transaction: ${message}`);
        }
    }
    /**
     * Sign transaction
     */
    async signTransaction(tx, privateKey) {
        try {
            const wallet = new ethers.Wallet(privateKey);
            const signedTx = await wallet.signTransaction(tx);
            return {
                txHash: signedTx.hash,
                signedTx: signedTx.serialized,
                signature: signedTx.signature,
                request: tx,
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to sign transaction: ${message}`);
        }
    }
    /**
     * Get transaction history
     */
    async getTransactionHistory(address) {
        // For MVP, return empty array
        // In production, query blockchain or use Etherscan API
        return [];
    }
    /**
     * Validate Ethereum address
     */
    validateAddress(address) {
        try {
            return ethers.isAddress(address);
        }
        catch {
            return false;
        }
    }
    /**
     * Estimate transaction fee
     */
    async estimateFee(request) {
        if (!this.provider || !this.connected) {
            throw new Error('Provider not connected');
        }
        try {
            const gasPrice = await this.provider.getFeeData();
            const gasLimit = await this.provider.estimateGas({
                to: request.to,
                value: ethers.parseEther(request.amount),
            });
            const fee = gasPrice.gasPrice * gasLimit;
            return ethers.formatEther(fee);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to estimate fee: ${message}`);
        }
    }
    /**
     * Get current block number
     */
    async getBlockNumber() {
        if (!this.provider || !this.connected) {
            throw new Error('Provider not connected');
        }
        return await this.provider.getBlockNumber();
    }
    /**
     * Get transaction by hash
     */
    async getTransaction(txHash) {
        if (!this.provider || !this.connected) {
            throw new Error('Provider not connected');
        }
        try {
            const tx = await this.provider.getTransaction(txHash);
            if (!tx) {
                return null;
            }
            const receipt = await this.provider.getTransactionReceipt(txHash);
            return {
                hash: tx.hash,
                from: tx.from,
                to: tx.to || '',
                amount: ethers.formatEther(tx.value),
                chain: this.getChain(),
                timestamp: await (await this.provider.getBlock(tx.blockNumber || 0))?.getTime(),
                status: receipt ? (receipt.status ? 'confirmed' : 'failed') : 'pending',
                fee: tx.gasPrice ? ethers.formatEther(BigInt(tx.gasPrice) * BigInt(tx.gasLimit || 21000)) : undefined,
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : 'Unknown error';
            throw new Error(`Failed to get transaction: ${message}`);
        }
    }
    /**
     * Create transaction from request
     */
    async populateTransaction(from, request) {
        const tx = {
            to: request.to,
            value: ethers.parseEther(request.amount),
            from,
            gasLimit: request.gasLimit ? BigInt(parseInt(request.gasLimit)) : undefined,
            gasPrice: request.gasPrice ? BigInt(parseInt(request.gasPrice)) : undefined,
        };
        return tx;
    }
    /**
     * Get default RPC URL for chain
     */
    static getDefaultRpcUrl(isTestnet = false) {
        if (isTestnet) {
            return 'https://sepolia.infura.io/v3/YOUR-API-KEY'; // Sepolia testnet
        }
        return 'https://mainnet.infura.io/v3/YOUR-API-KEY'; // Ethereum mainnet
    }
    /**
     * Get chain ID
     */
    getChainId() {
        return this.chainId;
    }
}
