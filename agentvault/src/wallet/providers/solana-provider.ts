/**
 * Solana Wallet Provider (Full Implementation)
 *
 * Complete provider for Solana wallet operations.
 * Integrates with @solana/web3.js for key derivation.
 * Uses Connection for real RPC network interactions.
 */

import type {
  Balance,
  Transaction,
  TransactionRequest,
  SignedTransaction,
  ProviderConfig,
} from '../types.js';
import { BaseWalletProvider } from './base-provider.js';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction as SolanaTransaction,
  LAMPORTS_PER_SOL,
  type Commitment,
} from '@solana/web3.js';
import { Buffer } from 'buffer';
import { debugLog } from '../../debugging/debug-logger.js';

/**
 * Solana provider configuration
 */
interface SolanaConfig extends ProviderConfig {
  /** Solana JSON-RPC endpoint (HTTP or WebSocket) */
  rpcUrl: string;
  /** Network type (mainnet, devnet) */
  network?: 'mainnet' | 'devnet';
  /** Commitment level */
  commitment?: Commitment;
}

/**
 * Solana wallet provider
 */
export class SolanaProvider extends BaseWalletProvider {
  private connection: Connection | null = null;
  private keypair: Keypair | null = null;
  private network: string;
  private commitment: Commitment;

  constructor(config: SolanaConfig) {
    super(config);
    this.network = config.network || 'mainnet';
    this.commitment = config.commitment || 'confirmed';
  }

  /**
   * Connect to Solana network via RPC
   */
  async connect(): Promise<void> {
    try {
      const rpcUrl = this.config.rpcUrl || this.getDefaultRpcUrl();
      this.connection = new Connection(rpcUrl, this.commitment);

      // Verify connection by getting latest slot
      const slot = await this.connection.getSlot();

      this.connected = true;
      debugLog(`Connected to Solana ${this.network} at slot ${slot}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to connect to Solana network: ${message}`);
    }
  }

  /**
   * Disconnect from Solana network
   */
  async disconnect(): Promise<void> {
    this.connection = null;
    this.keypair = null;
    this.connected = false;
  }

  /**
   * Get wallet balance
   */
  async getBalance(address: string): Promise<Balance> {
    if (!this.connected || !this.connection) {
      throw new Error('Provider not connected');
    }

    try {
      const publicKey = new PublicKey(address);
      const balanceInLamports = await this.connection.getBalance(publicKey);
      const balanceInSol = balanceInLamports / LAMPORTS_PER_SOL;

      const slot = await this.connection.getSlot();

      return {
        amount: balanceInSol.toString(),
        denomination: 'SOL',
        chain: 'solana',
        address,
        blockNumber: slot,
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
    if (!this.connected || !this.connection || !this.keypair) {
      throw new Error('Provider not connected or no wallet loaded');
    }

    try {
      const toPublicKey = new PublicKey(request.to);
      const fromPublicKey = new PublicKey(from);
      const amountInLamports = this.parseSolAmount(request.amount);

      // Get latest blockhash
      const { blockhash } = await this.connection.getLatestBlockhash();

      // Create SystemProgram transfer instruction
      const instruction = SystemProgram.transfer({
        fromPubkey: fromPublicKey,
        toPubkey: toPublicKey,
        lamports: amountInLamports,
      });

      // Create transaction
      const transaction = new SolanaTransaction().add(instruction);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = fromPublicKey;

      // Sign and send transaction
      const signature = await this.connection.sendTransaction(
        transaction,
        [this.keypair]
      );

      const fee = await this.estimateFee(request);

      return {
        hash: signature,
        from,
        to: request.to,
        amount: request.amount,
        chain: 'solana',
        timestamp: Date.now(),
        status: 'pending',
        fee,
        data: { memo: request.memo },
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
    if (!this.connection) {
      throw new Error('Provider not connected');
    }

    try {
      const keypair = this.createKeypairFromPrivateKey(privateKey);
      const toPublicKey = new PublicKey(tx.to);
      const fromPublicKey = keypair.publicKey;
      const amountInLamports = this.parseSolAmount(tx.amount);

      // Get latest blockhash
      const { blockhash } = await this.connection.getLatestBlockhash();

      // Create transaction
      const instruction = SystemProgram.transfer({
        fromPubkey: fromPublicKey,
        toPubkey: toPublicKey,
        lamports: amountInLamports,
      });

      const transaction = new SolanaTransaction().add(instruction);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = fromPublicKey;

      // Sign transaction
      transaction.sign(keypair);

      return {
        txHash: transaction.signature?.toString() || '',
        signedTx: transaction.serialize().toString('base64'),
        signature: Buffer.from(transaction.signature!).toString('hex'),
        request: tx,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to sign transaction: ${message}`);
    }
  }

  /**
   * Get transaction history
   */
  async getTransactionHistory(address: string): Promise<Transaction[]> {
    if (!this.connected || !this.connection) {
      throw new Error('Provider not connected');
    }

    try {
      const publicKey = new PublicKey(address);
      const transactions: Transaction[] = [];

      // Get recent signatures for this address (limit to 20)
      const signatures = await this.connection.getSignaturesForAddress(
        publicKey,
        { limit: 20 }
      );

      // Fetch detailed transaction info for each signature
      for (const sig of signatures) {
        try {
          const tx = await this.connection.getParsedTransaction(
            sig.signature,
            { maxSupportedTransactionVersion: 0 }
          );

          if (!tx || !tx.meta) continue;

          // Find transfer instruction
          const transfer = tx.transaction.message.instructions.find(
            (ix: any) => ix.programId.toBase58() === SystemProgram.programId.toBase58()
          );

          if (!transfer) continue;

          const parsedIx = (transfer as any).parsed;
          if (parsedIx?.type !== 'transfer') continue;

          const { from, to, lamports } = parsedIx.info;

          // Only include transactions involving this address
          if (from !== address && to !== address) continue;

          transactions.push({
            hash: sig.signature,
            from,
            to,
            amount: (lamports / LAMPORTS_PER_SOL).toFixed(9),
            chain: 'solana',
            timestamp: (sig.blockTime || Date.now() / 1000) * 1000,
            status: 'confirmed',
            fee: tx.meta.fee
              ? (tx.meta.fee / LAMPORTS_PER_SOL).toFixed(9)
              : '0',
          });
        } catch (error) {
          debugLog(`Failed to fetch transaction ${sig.signature}:`, error);
          continue;
        }
      }

      return transactions;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      debugLog(`Failed to get transaction history: ${message}`);
      return [];
    }
  }

  /**
   * Validate Solana address (Base58 format)
   */
  validateAddress(address: string): boolean {
    try {
      new PublicKey(address);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Estimate transaction fee
   */
  async estimateFee(request: TransactionRequest): Promise<string> {
    if (!this.connected || !this.connection || !this.keypair) {
      return '0.000005'; // Default minimum
    }

    try {
      const toPublicKey = new PublicKey(request.to);
      const fromPublicKey = this.keypair.publicKey;
      const amountInLamports = this.parseSolAmount(request.amount);

      // Get latest blockhash
      const { blockhash } = await this.connection.getLatestBlockhash();

      // Create transaction
      const instruction = SystemProgram.transfer({
        fromPubkey: fromPublicKey,
        toPubkey: toPublicKey,
        lamports: amountInLamports,
      });

      const transaction = new SolanaTransaction().add(instruction);
      transaction.recentBlockhash = blockhash;
      transaction.feePayer = fromPublicKey;

      // Estimate fee
      const fee = await transaction.getEstimatedFee(this.connection);
      if (!fee) return '0.000005';
      const feeInSol = fee / LAMPORTS_PER_SOL;

      return feeInSol.toFixed(9);
    } catch (_error) {
      return '0.000005';
    }
  }

  /**
   * Get current block number (slot)
   */
  async getBlockNumber(): Promise<number> {
    if (!this.connected || !this.connection) {
      throw new Error('Provider not connected');
    }

    try {
      return await this.connection.getSlot();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get block number: ${message}`);
    }
  }

  /**
   * Get transaction by hash
   */
  async getTransaction(txHash: string): Promise<Transaction | null> {
    if (!this.connected || !this.connection) {
      throw new Error('Provider not connected');
    }

    try {
      const tx = await this.connection.getParsedTransaction(
        txHash,
        { maxSupportedTransactionVersion: 0 }
      );

      if (!tx || !tx.meta) return null;

      // Find transfer instruction
      const transfer = tx.transaction.message.instructions.find(
        (ix: any) => ix.programId.toBase58() === SystemProgram.programId.toBase58()
      );

      if (!transfer) return null;

      const parsedIx = (transfer as any).parsed;
      if (parsedIx?.type !== 'transfer') return null;

      const { from, to, lamports } = parsedIx.info;

      return {
        hash: txHash,
        from,
        to,
        amount: (lamports / LAMPORTS_PER_SOL).toFixed(9),
        chain: 'solana',
        timestamp: (tx.blockTime || Date.now() / 1000) * 1000,
        status: 'confirmed',
        fee: tx.meta.fee
          ? (tx.meta.fee / LAMPORTS_PER_SOL).toFixed(9)
          : '0',
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get transaction: ${message}`);
    }
  }

  /**
   * Initialize keypair from wallet data
   */
  async initKeypair(mnemonic: string, derivationPath?: string): Promise<void> {
    try {
      const { generateSeedFromMnemonic, deriveSolanaKey } = await import('../key-derivation.js');
      const seed = generateSeedFromMnemonic(mnemonic);
      const path = derivationPath || "m/44'/501'/0'/0'/0'";
      const derived = deriveSolanaKey(seed, path);

      const privateKeyBytes = Uint8Array.from(
        Buffer.from(derived.privateKey, 'hex')
      );
      this.keypair = Keypair.fromSecretKey(privateKeyBytes);

      debugLog('Solana keypair initialized for derivation:', path);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to initialize Solana keypair: ${message}`);
    }
  }

  /**
   * Initialize from private key
   */
  async initFromPrivateKey(privateKey: string): Promise<void> {
    try {
      this.keypair = this.createKeypairFromPrivateKey(privateKey);

      debugLog('Solana keypair initialized from private key');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to initialize Solana keypair from private key: ${message}`);
    }
  }

  /**
   * Create Keypair from private key
   */
  private createKeypairFromPrivateKey(privateKeyHex: string): Keypair {
    const privateKeyBytes = Buffer.from(privateKeyHex, 'hex');
    return Keypair.fromSecretKey(privateKeyBytes.subarray(0, 32));
  }

  /**
   * Get address from keypair
   */
  getAddress(): string | null {
    if (!this.keypair) {
      return null;
    }
    return this.keypair.publicKey.toBase58();
  }

  /**
   * Get public key
   */
  getPublicKey(): string | null {
    if (!this.keypair) {
      return null;
    }
    return Buffer.from(this.keypair.publicKey.toBytes()).toString('hex');
  }

  /**
   * Parse SOL amount to lamports
   */
  private parseSolAmount(amountStr: string): number {
    try {
      const cleanAmount = amountStr.replace(/,/g, '').trim();
      const amount = parseFloat(cleanAmount);
      return Math.floor(amount * LAMPORTS_PER_SOL);
    } catch {
      return 0;
    }
  }

  /**
   * Get default RPC URL for network type
   * Checks environment variables first, then falls back to public RPC endpoints
   */
  private getDefaultRpcUrl(): string {
    const envUrls: Record<string, string | undefined> = {
      mainnet: process.env.SOLANA_MAINNET_RPC_URL || process.env.SOLANA_RPC_URL,
      devnet: process.env.SOLANA_DEVNET_RPC_URL || process.env.SOLANA_RPC_URL,
    };

    const publicUrls: Record<string, string> = {
      mainnet: 'https://api.mainnet-beta.solana.com',
      devnet: 'https://api.devnet.solana.com',
    };

    return envUrls[this.network] || publicUrls[this.network] || publicUrls.mainnet!;
  }
}
