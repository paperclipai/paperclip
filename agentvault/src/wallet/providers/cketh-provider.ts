/**
 * ckETH Wallet Provider
 *
 * Provider for Ethereum-compatible wallets on ICP ckETH.
 * Supports balance queries, transactions, and signing.
 */

import { ethers } from 'ethers';
import type {
  Balance,
  Transaction,
  TransactionRequest,
  SignedTransaction,
  ProviderConfig,
} from '../types.js';
import { BaseWalletProvider } from './base-provider.js';

/**
 * Environment variable names for RPC configuration
 */
const ENV_RPC_URL = 'ETHEREUM_RPC_URL';
const ENV_SEPOLIA_RPC_URL = 'SEPOLIA_RPC_URL';
const ENV_INFURA_KEY = 'INFURA_API_KEY';

/**
 * Public RPC endpoints (rate-limited, for fallback only)
 */
const PUBLIC_RPC_URLS = {
  mainnet: [
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth',
    'https://ethereum.publicnode.com',
  ],
  sepolia: [
    'https://rpc.sepolia.org',
    'https://ethereum-sepolia.publicnode.com',
    'https://rpc2.sepolia.org',
  ],
};

/**
 * Environment variable names for Etherscan configuration
 */
const ENV_ETHERSCAN_API_KEY = 'ETHERSCAN_API_KEY';

/**
 * ckETH provider configuration
 */
interface CkEthConfig extends ProviderConfig {
  /** Ethereum JSON-RPC endpoint */
  rpcUrl: string;
  /** Chain ID (1 = Mainnet, 5 = Goerli, 11155111 = Sepolia) */
  chainId?: number;
  /** Etherscan API key (optional, for transaction history) */
  etherscanApiKey?: string;
}

/**
 * ckETH wallet provider
 */
export class CkEthProvider extends BaseWalletProvider {
  private provider: ethers.JsonRpcProvider | null = null;
  private chainId: number;
  private etherscanApiKey: string | undefined;

  constructor(config: CkEthConfig) {
    super(config);
    this.chainId = config.chainId ?? 1;
    this.etherscanApiKey = config.etherscanApiKey;
  }

  /**
   * Resolve the RPC URL to use for connections
   *
   * Priority:
   * 1. Explicitly configured URL
   * 2. Environment variable (ETHEREUM_RPC_URL or SEPOLIA_RPC_URL)
   * 3. Infura with API key from environment
   * 4. Public RPC endpoints (fallback, rate-limited)
   *
   * @returns RPC URL
   */
  private resolveRpcUrl(): string {
    const configUrl = super.getRpcUrl();
    if (configUrl && !configUrl.includes('YOUR-API-KEY')) {
      return configUrl;
    }

    const isTestnet = this.chainId !== 1;
    const envVar = isTestnet ? ENV_SEPOLIA_RPC_URL : ENV_RPC_URL;
    const envUrl = process.env[envVar];

    if (envUrl) {
      return envUrl;
    }

    const infuraKey = process.env[ENV_INFURA_KEY];
    if (infuraKey) {
      return isTestnet
        ? `https://sepolia.infura.io/v3/${infuraKey}`
        : `https://mainnet.infura.io/v3/${infuraKey}`;
    }

    const publicUrls = isTestnet ? PUBLIC_RPC_URLS.sepolia : PUBLIC_RPC_URLS.mainnet;
    const publicUrl = publicUrls[0];

    if (!publicUrl) {
      throw new Error(
        `No RPC URL configured. Set ${envVar} environment variable or provide rpcUrl in config. ` +
        `Example: export ${envVar}=https://eth.example.com/v3/your-api-key`
      );
    }

    console.warn(
      `Warning: Using public RPC endpoint (${publicUrl}). ` +
      `For production, set ${envVar} environment variable for better reliability.`
    );

    return publicUrl;
  }

  /**
   * Connect to Ethereum network via RPC
   */
  async connect(): Promise<void> {
    try {
      // Create provider
      this.provider = new ethers.JsonRpcProvider(this.resolveRpcUrl());
      
      // Verify connection
      const network = await this.provider.getNetwork();
      this.chainId = Number(network.chainId);

      this.connected = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to connect to ckETH network: ${message}`);
    }
  }

  /**
   * Disconnect from network
   */
  async disconnect(): Promise<void> {
    this.provider = null;
    this.connected = false;
  }

  /**
   * Get wallet balance
   */
  async getBalance(address: string): Promise<Balance> {
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
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get balance: ${message}`);
    }
  }

  /**
   * Send transaction
   */
  async sendTransaction(
    from: string,
    request: TransactionRequest
  ): Promise<Transaction> {
    if (!this.provider || !this.connected) {
      throw new Error('Provider not connected');
    }

    try {
      const tx = await this.populateTransaction(from, request);
      const signedTx = await this.signTransaction(tx, from);

      // Send transaction
      const txResponse = await this.provider.broadcastTransaction(signedTx.signedTx);

      return {
        hash: txResponse.hash,
        from,
        to: request.to,
        amount: request.amount,
        chain: this.getChain(),
        timestamp: Date.now(),
        status: 'pending',
        fee: tx.gasPrice ? ethers.formatEther(BigInt(tx.gasPrice) * BigInt(tx.gasLimit || 21000)) : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to send transaction: ${message}`);
    }
  }

  /**
   * Sign transaction
   */
  async signTransaction(
    tx: any,
    privateKey: string
  ): Promise<SignedTransaction> {
    try {
      const wallet = new ethers.Wallet(privateKey);
      const signedTxSerialized = await wallet.signTransaction(tx);

      return {
        txHash: tx.hash || '0x0',
        signedTx: signedTxSerialized,
        signature: '0x',
        request: tx,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to sign transaction: ${message}`);
    }
  }

  /**
   * Get transaction history
   *
   * Uses Etherscan API to fetch transaction history.
   * Requires ETHERSCAN_API_KEY environment variable or etherscanApiKey in config.
   *
   * @param address - Wallet address to get history for
   * @returns Array of transactions
   */
  async getTransactionHistory(address: string): Promise<Transaction[]> {
    const apiKey = this.etherscanApiKey || process.env[ENV_ETHERSCAN_API_KEY];

    if (!apiKey) {
      console.warn(
        'Etherscan API key not configured. Set ETHERSCAN_API_KEY environment variable ' +
        'or provide etherscanApiKey in config for transaction history.'
      );
      return [];
    }

    try {
      const isTestnet = this.chainId !== 1;
      const baseUrl = isTestnet
        ? 'https://api-sepolia.etherscan.io/api'
        : 'https://api.etherscan.io/api';

      const url = `${baseUrl}?module=account&action=txlist&address=${address}&startblock=0&endblock=99999999&sort=desc&apikey=${apiKey}`;

      const response = await fetch(url);
      const data = await response.json() as { status: string; result: Array<{
        hash: string;
        from: string;
        to: string;
        value: string;
        timeStamp: string;
        gasUsed: string;
        gasPrice: string;
        isError: string;
      }> };

      if (data.status !== '1' || !Array.isArray(data.result)) {
        console.warn('Etherscan API returned no results or error');
        return [];
      }

      return data.result.slice(0, 50).map((tx) => ({
        hash: tx.hash,
        from: tx.from,
        to: tx.to,
        amount: ethers.formatEther(BigInt(tx.value)),
        chain: this.getChain(),
        timestamp: parseInt(tx.timeStamp, 10) * 1000,
        status: tx.isError === '1' ? 'failed' : 'confirmed',
        fee: ethers.formatEther(BigInt(tx.gasUsed) * BigInt(tx.gasPrice)),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.warn(`Failed to get transaction history: ${message}`);
      return [];
    }
  }

  /**
   * Validate Ethereum address
   */
  validateAddress(address: string): boolean {
    try {
      return ethers.isAddress(address);
    } catch {
      return false;
    }
  }

  /**
   * Estimate transaction fee
   */
  async estimateFee(request: TransactionRequest): Promise<string> {
    if (!this.provider || !this.connected) {
      throw new Error('Provider not connected');
    }

    try {
      const feeData = await this.provider.getFeeData();
      const gasLimit = await this.provider.estimateGas({
        to: request.to,
        value: ethers.parseEther(request.amount),
      });

      const gasPrice = feeData.gasPrice || feeData.maxFeePerGas || BigInt(0);
      const fee = gasPrice * gasLimit;
      return ethers.formatEther(fee);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to estimate fee: ${message}`);
    }
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    if (!this.provider || !this.connected) {
      throw new Error('Provider not connected');
    }

    return await this.provider.getBlockNumber();
  }

  /**
   * Get transaction by hash
   */
  async getTransaction(txHash: string): Promise<Transaction | null> {
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
        timestamp: (await this.provider.getBlock(tx.blockNumber || 0))?.timestamp || 0,
        status: receipt ? (receipt.status ? 'confirmed' : 'failed') : 'pending',
        fee: tx.gasPrice ? ethers.formatEther(BigInt(tx.gasPrice) * BigInt(tx.gasLimit || 21000)) : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get transaction: ${message}`);
    }
  }

  /**
   * Create transaction from request
   */
  private async populateTransaction(
    from: string,
    request: TransactionRequest
  ): Promise<any> {
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
   *
   * @param isTestnet - Whether to get testnet URL
   * @returns RPC URL from environment or public endpoint
   * @throws Error if no RPC URL is configured
   */
  static getDefaultRpcUrl(isTestnet: boolean = false): string {
    const envVar = isTestnet ? ENV_SEPOLIA_RPC_URL : ENV_RPC_URL;
    const envUrl = process.env[envVar];

    if (envUrl) {
      return envUrl;
    }

    const infuraKey = process.env[ENV_INFURA_KEY];
    if (infuraKey) {
      return isTestnet
        ? `https://sepolia.infura.io/v3/${infuraKey}`
        : `https://mainnet.infura.io/v3/${infuraKey}`;
    }

    const publicUrls = isTestnet ? PUBLIC_RPC_URLS.sepolia : PUBLIC_RPC_URLS.mainnet;
    const publicUrl = publicUrls[0];

    if (publicUrl) {
      console.warn(
        `Warning: Using public RPC endpoint (${publicUrl}). ` +
        `For production, set ${envVar} environment variable.`
      );
      return publicUrl;
    }

    throw new Error(
      `No RPC URL configured. Set ${envVar} environment variable. ` +
      `Example: export ${envVar}=https://mainnet.infura.io/v3/your-api-key`
    );
  }

  /**
   * Get chain ID
   */
  getChainId(): number {
    return this.chainId;
  }
}
