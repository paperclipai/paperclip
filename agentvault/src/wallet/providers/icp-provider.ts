/**
 * ICP Wallet Provider
 *
 * Provider for ICP wallet operations in CLI flows.
 * Supports balance checks and transaction signing payloads.
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

const ENV_ICP_LEDGER_API_URL = 'ICP_LEDGER_API_URL';
const DEFAULT_ICP_LEDGER_API_URL = 'https://ledger-api.internetcomputer.org';
const ICP_E8S = 100_000_000n;

interface IcpConfig extends ProviderConfig {
  rpcUrl?: string;
}

/**
 * ICP wallet provider
 */
export class IcpProvider extends BaseWalletProvider {
  private apiUrl: string;

  constructor(config: IcpConfig) {
    super(config);
    this.apiUrl = (config.rpcUrl || IcpProvider.getDefaultRpcUrl()).replace(/\/+$/, '');
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
      denomination: 'ICP',
      chain: this.getChain(),
      address,
    };
  }

  async sendTransaction(
    _from: string,
    _request: TransactionRequest
  ): Promise<Transaction> {
    throw new Error('Sending ICP transactions is not supported by this wallet provider yet');
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
    // Accept principal textual format (e.g., aaaaa-aa or long self-authenticating principal text)
    const principalPattern = /^[a-z0-9]{5}(-[a-z0-9]{3,5})+$/;
    return principalPattern.test(address);
  }

  async estimateFee(_request: TransactionRequest): Promise<string> {
    return '0.0001';
  }

  async getBlockNumber(): Promise<number> {
    return 0;
  }

  async getTransaction(_txHash: string): Promise<Transaction | null> {
    return null;
  }

  static getDefaultRpcUrl(): string {
    return process.env[ENV_ICP_LEDGER_API_URL] || DEFAULT_ICP_LEDGER_API_URL;
  }

  private requireConnection(): void {
    if (!this.connected) {
      throw new Error('Provider not connected');
    }
  }

  private async fetchBalance(address: string): Promise<string> {
    try {
      const response = await fetch(
        `${this.apiUrl}/accounts/${encodeURIComponent(address)}/balance`
      );

      if (!response.ok) {
        return '0';
      }

      const contentType = response.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        const data = await response.json() as Record<string, unknown>;
        if (typeof data.e8s === 'number' || typeof data.e8s === 'string') {
          return this.formatE8s(data.e8s);
        }
        if (typeof data.balance === 'string') {
          return data.balance;
        }
        if (typeof data.amount === 'string') {
          return data.amount;
        }
      } else {
        const text = (await response.text()).trim();
        if (/^\d+$/.test(text)) {
          return this.formatE8s(text);
        }
      }

      return '0';
    } catch {
      return '0';
    }
  }

  private formatE8s(value: string | number): string {
    const raw = BigInt(value);
    const whole = raw / ICP_E8S;
    const fraction = (raw % ICP_E8S).toString().padStart(8, '0').replace(/0+$/, '');
    return fraction ? `${whole}.${fraction}` : whole.toString();
  }
}
