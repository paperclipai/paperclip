/**
 * Arweave Wallet Provider
 *
 * Provider for Arweave wallet operations in CLI flows.
 * Supports balance checks using public gateway APIs.
 */

import { createHash, createHmac } from 'node:crypto';
import type {
  Balance,
  Transaction,
  TransactionRequest,
  SignedTransaction,
  ProviderConfig,
} from '../types.js';
import { BaseWalletProvider } from './base-provider.js';

const WINSTON_PER_AR = 1_000_000_000_000n;
const DEFAULT_ARWEAVE_RPC_URL = 'https://arweave.net';

interface ArweaveConfig extends ProviderConfig {
  rpcUrl?: string;
}

/**
 * Arweave wallet provider
 */
export class ArweaveProvider extends BaseWalletProvider {
  private rpcUrl: string;

  constructor(config: ArweaveConfig) {
    super(config);
    this.rpcUrl = (config.rpcUrl || ArweaveProvider.getDefaultRpcUrl()).replace(/\/+$/, '');
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async getBalance(address: string): Promise<Balance> {
    this.requireConnection();
    const amount = await this.fetchBalance(address);

    return {
      amount,
      denomination: 'AR',
      chain: this.getChain(),
      address,
    };
  }

  async sendTransaction(
    _from: string,
    _request: TransactionRequest
  ): Promise<Transaction> {
    throw new Error('Sending Arweave transactions is not supported by this wallet provider yet');
  }

  async signTransaction(
    tx: any,
    privateKey: string
  ): Promise<SignedTransaction> {
    const payload = JSON.stringify(tx);
    const signature = createHmac('sha256', privateKey).update(payload).digest('hex');
    const txHash = createHash('sha256').update(signature).digest('hex');

    return {
      txHash,
      signedTx: payload,
      signature,
      request: tx as TransactionRequest,
    };
  }

  async getTransactionHistory(_address: string): Promise<Transaction[]> {
    return [];
  }

  validateAddress(address: string): boolean {
    // Arweave addresses are base64url-encoded identifiers.
    return /^[a-zA-Z0-9_-]{43}$/.test(address);
  }

  async estimateFee(_request: TransactionRequest): Promise<string> {
    return '0';
  }

  async getBlockNumber(): Promise<number> {
    try {
      const response = await fetch(`${this.rpcUrl}/height`);
      if (!response.ok) {
        return 0;
      }
      const text = (await response.text()).trim();
      const parsed = Number.parseInt(text, 10);
      return Number.isFinite(parsed) ? parsed : 0;
    } catch {
      return 0;
    }
  }

  async getTransaction(txHash: string): Promise<Transaction | null> {
    try {
      const response = await fetch(`${this.rpcUrl}/tx/${txHash}`);
      if (!response.ok) {
        return null;
      }

      const data = await response.json() as {
        id?: string;
        owner?: string;
        target?: string;
        quantity?: string;
      };

      return {
        hash: data.id || txHash,
        from: data.owner || '',
        to: data.target || '',
        amount: this.winstonToAr(data.quantity || '0'),
        chain: this.getChain(),
        timestamp: Date.now(),
        status: 'confirmed',
      };
    } catch {
      return null;
    }
  }

  static getDefaultRpcUrl(): string {
    return DEFAULT_ARWEAVE_RPC_URL;
  }

  private requireConnection(): void {
    if (!this.connected) {
      throw new Error('Provider not connected');
    }
  }

  private async fetchBalance(address: string): Promise<string> {
    try {
      const response = await fetch(`${this.rpcUrl}/wallet/${encodeURIComponent(address)}/balance`);
      if (!response.ok) {
        return '0';
      }

      const winston = (await response.text()).trim();
      if (!/^\d+$/.test(winston)) {
        return '0';
      }

      return this.winstonToAr(winston);
    } catch {
      return '0';
    }
  }

  private winstonToAr(value: string): string {
    const raw = BigInt(value);
    const whole = raw / WINSTON_PER_AR;
    const fraction = (raw % WINSTON_PER_AR).toString().padStart(12, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
  }
}
