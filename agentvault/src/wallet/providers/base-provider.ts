/**
 * Base Wallet Provider
 *
 * Abstract base class for all blockchain wallet providers.
 * Defines common interface for wallet operations.
 */

import type {
  ChainType,
  Balance,
  Transaction,
  TransactionRequest,
  SignedTransaction,
  ProviderConfig,
} from '../types.js';

/**
 * Abstract base class for wallet providers
 */
export abstract class BaseWalletProvider {
  protected config: ProviderConfig;
  protected connected: boolean;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.connected = false;
  }

  /**
   * Connect to blockchain network
   */
  abstract connect(): Promise<void>;

  /**
   * Disconnect from blockchain network
   */
  abstract disconnect(): Promise<void>;

  /**
   * Get wallet balance
   *
   * @param address - Wallet address
   * @returns Wallet balance
   */
  abstract getBalance(address: string): Promise<Balance>;

  /**
   * Send transaction
   *
   * @param from - From address
   * @param request - Transaction request
   * @returns Transaction result
   */
  abstract sendTransaction(
    from: string,
    request: TransactionRequest
  ): Promise<Transaction>;

  /**
   * Sign transaction
   *
   * @param tx - Transaction object
   * @param privateKey - Private key for signing
   * @returns Signed transaction
   */
  abstract signTransaction(
    tx: any,
    privateKey: string
  ): Promise<SignedTransaction>;

  /**
   * Get transaction history
   *
   * @param address - Wallet address
   * @returns Transaction history
   */
  abstract getTransactionHistory(address: string): Promise<Transaction[]>;

  /**
   * Validate address format
   *
   * @param address - Address to validate
   * @returns True if address is valid
   */
  abstract validateAddress(address: string): boolean;

  /**
   * Check connection status
   *
   * @returns True if connected
   */
  isConnected(): boolean {
    return this.connected;
  }

  /**
   * Get chain type
   *
   * @returns Chain type
   */
  getChain(): ChainType {
    return this.config.chain;
  }

  /**
   * Get provider configuration
   *
   * @returns Provider configuration
   */
  getConfig(): ProviderConfig {
    return this.config;
  }

  /**
   * Get RPC URL
   *
   * @returns RPC endpoint URL
   */
  getRpcUrl(): string {
    return this.config.rpcUrl || '';
  }

  /**
   * Check if connected to testnet
   *
   * @returns True if using testnet
   */
  isTestnet(): boolean {
    return this.config.isTestnet ?? false;
  }

  /**
   * Estimate transaction fee
   *
   * @param request - Transaction request
   * @returns Estimated fee (as string)
   */
  abstract estimateFee(request: TransactionRequest): Promise<string>;

  /**
   * Get current block number
   *
   * @returns Block number
   */
  abstract getBlockNumber(): Promise<number>;

  /**
   * Get transaction by hash
   *
   * @param txHash - Transaction hash
   * @returns Transaction details
   */
  abstract getTransaction(txHash: string): Promise<Transaction | null>;
}
