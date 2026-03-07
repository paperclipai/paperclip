/**
 * Chain Dispatcher (Phase 5C)
 *
 * Routes transactions to appropriate blockchain providers.
 * Supports ckETH, Polkadot, Solana, ICP, and Arweave chains.
 */

import type { WalletData, TransactionRequest, Transaction, ChainType } from './types.js';
import { createWalletProvider } from './providers/provider-factory.js';

/**
 * Chain dispatcher configuration
 */
export interface ChainDispatcherConfig {
  isTestnet?: boolean;
  apiKey?: string;
}

/**
 * Chain dispatcher
 *
 * Routes transactions to appropriate blockchain providers based on wallet chain.
 */
export class ChainDispatcher {
  private providers: Map<ChainType, any>;
  private config: ChainDispatcherConfig;

  constructor(config: ChainDispatcherConfig = {}) {
    this.config = {
      isTestnet: config.isTestnet ?? false,
      apiKey: config.apiKey,
    };

    this.providers = new Map();
    const supportedChains: ChainType[] = ['cketh', 'polkadot', 'solana', 'icp', 'arweave'];
    for (const chain of supportedChains) {
      this.providers.set(chain, createWalletProvider(chain, {
        isTestnet: this.config.isTestnet,
      }));
    }
  }

  /**
   * Dispatch transaction to appropriate provider
   *
   * @param wallet - Wallet to use for signing
   * @param request - Transaction request
   * @returns Transaction result
   */
  async dispatchTransaction(
    wallet: WalletData,
    request: TransactionRequest
  ): Promise<Transaction> {
    const provider = this.getProvider(wallet.chain);

    if (!provider) {
      throw new Error(`Unsupported chain: ${wallet.chain}`);
    }

    await provider.connect();

    const tx = await provider.sendTransaction(wallet.address, request);

    return {
      hash: tx.hash,
      from: wallet.address,
      to: request.to,
      amount: request.amount,
      chain: wallet.chain,
      timestamp: Date.now(),
      status: 'pending',
      fee: tx.fee,
    };
  }

  /**
   * Sign transaction without broadcasting
   *
   * @param wallet - Wallet to use for signing
   * @param request - Transaction request
   * @returns Signed transaction
   */
  async signTransaction(
    wallet: WalletData,
    request: TransactionRequest
  ): Promise<{ signedTx: string; signature: string }> {
    const provider = this.getProvider(wallet.chain);

    if (!provider) {
      throw new Error(`Unsupported chain: ${wallet.chain}`);
    }

    await provider.connect();

    const signed = await provider.signTransaction(request, wallet.privateKey);

    return {
      signedTx: signed.signedTx,
      signature: signed.signature || '',
    };
  }

  /**
   * Get wallet balance
   *
   * @param wallet - Wallet to query
   * @returns Wallet balance
   */
  async getBalance(wallet: WalletData): Promise<{ amount: string; denomination: string }> {
    const provider = this.getProvider(wallet.chain);

    if (!provider) {
      throw new Error(`Unsupported chain: ${wallet.chain}`);
    }

    await provider.connect();

    const balance = await provider.getBalance(wallet.address);

    return {
      amount: balance.amount,
      denomination: balance.denomination,
    };
  }

  /**
   * Get transaction history
   *
   * @param wallet - Wallet to query
   * @param limit - Maximum number of transactions
   * @returns Transaction history
   */
  async getTransactionHistory(
    wallet: WalletData,
    limit: number = 20
  ): Promise<Transaction[]> {
    const provider = this.getProvider(wallet.chain);

    if (!provider) {
      throw new Error(`Unsupported chain: ${wallet.chain}`);
    }

    await provider.connect();

    const history = await provider.getTransactionHistory(wallet.address);

    return history.slice(0, limit);
  }

  /**
   * Estimate transaction fee
   *
   * @param wallet - Wallet to use
   * @param request - Transaction request
   * @returns Estimated fee
   */
  async estimateFee(
    wallet: WalletData,
    request: TransactionRequest
  ): Promise<string> {
    const provider = this.getProvider(wallet.chain);

    if (!provider) {
      throw new Error(`Unsupported chain: ${wallet.chain}`);
    }

    await provider.connect();

    const fee = await provider.estimateFee(request);

    return fee;
  }

  /**
   * Validate address
   *
   * @param address - Address to validate
   * @param chain - Chain to validate against
   * @returns True if valid
   */
  async validateAddress(address: string, chain: ChainType): Promise<boolean> {
    const provider = this.getProvider(chain);

    if (!provider) {
      throw new Error(`Unsupported chain: ${chain}`);
    }

    return await provider.validateAddress(address);
  }

  /**
   * Get current block number
   *
   * @param chain - Chain to query
   * @returns Current block number
   */
  async getBlockNumber(chain: ChainType): Promise<number> {
    const provider = this.getProvider(chain);

    if (!provider) {
      throw new Error(`Unsupported chain: ${chain}`);
    }

    await provider.connect();

    const block = await provider.getBlockNumber();

    return block;
  }

  /**
   * Get transaction by hash
   *
   * @param chain - Chain to query
   * @param txHash - Transaction hash
   * @returns Transaction details
   */
  async getTransaction(chain: ChainType, txHash: string): Promise<Transaction | null> {
    const provider = this.getProvider(chain);

    if (!provider) {
      throw new Error(`Unsupported chain: ${chain}`);
    }

    await provider.connect();

    const tx = await provider.getTransaction(txHash);

    if (!tx) {
      return null;
    }

    return {
      hash: tx.hash,
      from: tx.from,
      to: tx.to,
      amount: tx.amount,
      chain,
      timestamp: tx.timestamp,
      status: tx.status,
      fee: tx.fee,
    };
  }

  /**
   * Get provider for chain
   */
  private getProvider(chain: ChainType): any {
    const provider = this.providers.get(chain);

    if (!provider) {
      throw new Error(`No provider found for chain: ${chain}`);
    }

    return provider;
  }

  /**
   * Connect all providers
   */
  async connectAll(): Promise<void> {
    const connections = Array.from(this.providers.entries()).map(async ([chain, provider]) => {
      try {
        await provider.connect();
        return { chain, success: true };
      } catch (error) {
        return { chain, success: false, error };
      }
    });

    await Promise.all(connections);
  }

  /**
   * Disconnect all providers
   */
  async disconnectAll(): Promise<void> {
    const disconnections = Array.from(this.providers.entries()).map(async ([chain, provider]) => {
      try {
        await provider.disconnect();
        return { chain, success: true };
      } catch (error) {
        return { chain, success: false, error };
      }
    });

    await Promise.all(disconnections);
  }
}

/**
 * Create chain dispatcher
 *
 * @param config - Dispatcher configuration
 * @returns Chain dispatcher instance
 */
export function createChainDispatcher(config?: ChainDispatcherConfig): ChainDispatcher {
  return new ChainDispatcher(config);
}
