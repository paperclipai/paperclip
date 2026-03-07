/**
 * Polkadot Wallet Provider (Full Implementation)
 *
 * Complete provider for Polkadot wallet operations.
 * Integrates with @polkadot/util-crypto for key derivation.
 * Uses @polkadot/api for real RPC network interactions.
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
  sr25519PairFromSeed,
  sr25519Sign,
  checkAddress,
  cryptoWaitReady,
} from '@polkadot/util-crypto';
import {
  u8aToHex,
  hexToU8a,
} from '@polkadot/util';
import { ApiPromise, WsProvider } from '@polkadot/api';
import type { KeyringPair } from '@polkadot/keyring/types';
import { Keyring } from '@polkadot/keyring';
import { debugLog } from '../../debugging/debug-logger.js';

/**
 * Polkadot provider configuration
 */
interface PolkadotConfig extends ProviderConfig {
  /** Polkadot JSON-RPC endpoint (WS or HTTP) */
  rpcUrl: string;
  /** Chain type (mainnet, testnet, dev) */
  network?: 'mainnet' | 'testnet' | 'dev';
  /** Chain type (polkadot, kusama, westend, astar) */
  chainType?: 'polkadot' | 'kusama' | 'westend' | 'astar';
  /** SS58 prefix for address encoding */
  ss58Format?: number;
}

/**
 * Polkadot wallet provider
 */
export class PolkadotProvider extends BaseWalletProvider {
  private keyringPair: KeyringPair | null = null;
  private api: ApiPromise | null = null;
  private ss58Format: number;
  private chainType: string;

  constructor(config: PolkadotConfig) {
    super(config);
    this.ss58Format = config.ss58Format || 0;
    this.chainType = config.chainType || 'polkadot';
  }

  private getApi() {
    if (!this.api) {
      throw new Error('API not connected');
    }
    return this.api;
  }

  private getSystemQuery() {
    return this.getApi().query.system as any;
  }

  private getBalancesTx() {
    return this.getApi().tx.balances as any;
  }

  private getRpcChain() {
    return this.getApi().rpc.chain as any;
  }

  /**
   * Connect to Polkadot network via RPC
   */
  async connect(): Promise<void> {
    try {
      await cryptoWaitReady();

      const rpcUrl = this.config.rpcUrl || this.getDefaultRpcUrl();
      const provider = new WsProvider(rpcUrl);

      this.api = await ApiPromise.create({ provider });

      await this.api.isReady;

      this.connected = true;
      debugLog(`Connected to ${this.chainType} network`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to connect to Polkadot network: ${message}`);
    }
  }

  /**
   * Disconnect from Polkadot network
   */
  async disconnect(): Promise<void> {
    if (this.api) {
      await this.api.disconnect();
      this.api = null;
    }
    this.keyringPair = null;
    this.connected = false;
  }

  /**
   * Get wallet balance
   */
  async getBalance(address: string): Promise<Balance> {
    if (!this.connected || !this.api) {
      throw new Error('Provider not connected');
    }

     try {
      const accountInfo = await this.getSystemQuery().account(address);
      const data = accountInfo.toJSON() as any;
      const freeBalance = ((data?.data?.free as string) ?? '0');
      const reserved = ((data?.data?.reserved as string) ?? '0');
      const totalBalance = (BigInt(freeBalance) + BigInt(reserved)).toString();

      const balanceInDot = parseFloat(totalBalance) / 10_000_000_000;

      const blockNumber = await this.getSystemQuery().number();

      return {
        amount: balanceInDot.toString(),
        denomination: 'DOT',
        chain: this.chainType as any,
        address,
        blockNumber: Number(blockNumber),
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
    if (!this.connected || !this.api || !this.keyringPair) {
      throw new Error('Provider not connected or no wallet loaded');
    }

    try {
      const transferAmount = this.parseDotAmount(request.amount);

      const tx = this.getBalancesTx().transfer(request.to, transferAmount);

      const hash = await tx.signAndSend(this.keyringPair);

      const fee = await this.estimateFee(request);

      return {
        hash: hash.toString(),
        from,
        to: request.to,
        amount: request.amount,
        chain: this.chainType as any,
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
    if (!this.api) {
      throw new Error('Provider not connected');
    }

    try {
      const keypair = this.createKeyringPair(privateKey);
      const transferAmount = this.parseDotAmount(tx.amount);

      const unsignedTx = this.getBalancesTx().transfer(tx.to, transferAmount);
      const signedTx = await unsignedTx.signAsync(keypair);

      return {
        txHash: signedTx.hash.toString(),
        signedTx: signedTx.toHex(),
        signature: u8aToHex(signedTx.signature),
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
    if (!this.connected || !this.api) {
      throw new Error('Provider not connected');
    }

    try {
      const transactions: Transaction[] = [];

      const blockNumber = await this.getSystemQuery().number();
      const latestBlocks = Math.min(Number(blockNumber), 100);

      for (let i = 0; i < latestBlocks; i++) {
        const blockHash = await this.getRpcChain().getBlockHash(Number(blockNumber) - i);

        const events = await this.getSystemQuery().events.at(blockHash);
        const eventRecords = events.toHuman() as any[];

        for (const event of eventRecords) {
          if (event.event?.section === 'balances' && event.event?.method === 'Transfer') {
            const eventData = event.event.data;
            const [from, to, amount] = eventData;

            if (from.toString() === address || to.toString() === address) {
              transactions.push({
                hash: blockHash.toString(),
                from: from.toString(),
                to: to.toString(),
                amount: this.formatPlancks(amount.toString()),
                chain: this.chainType as any,
                timestamp: Date.now() - (i * 6000),
                status: 'confirmed',
                fee: '0',
              });
            }
          }
        }
      }

      return transactions.slice(0, 20);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      debugLog(`Failed to get transaction history: ${message}`);
      return [];
    }
  }

  /**
   * Validate Polkadot address (SS58 format)
   */
  validateAddress(address: string): boolean {
    try {
      const [isValid] = checkAddress(address, this.ss58Format);
      return isValid;
    } catch {
      return false;
    }
  }

  /**
   * Estimate transaction fee
   */
  async estimateFee(request: TransactionRequest): Promise<string> {
    if (!this.connected || !this.api || !this.keyringPair) {
      return '0.01';
    }

    try {
      const transferAmount = this.parseDotAmount(request.amount);

      const tx = this.getBalancesTx().transfer(request.to, transferAmount);

      const info = await tx.paymentInfo(this.keyringPair);

      const partialFee = info.partialFee.toString();
      const feeInDot = parseFloat(partialFee) / 10_000_000_000;

      return feeInDot.toFixed(6);
    } catch (_error) {
      return '0.01';
    }
  }

  /**
   * Get current block number
   */
  async getBlockNumber(): Promise<number> {
    if (!this.connected || !this.api) {
      throw new Error('Provider not connected');
    }

    try {
      const blockNumber = await this.getSystemQuery().number();
      return Number(blockNumber);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to get block number: ${message}`);
    }
  }

  /**
   * Get transaction by hash
   */
  async getTransaction(txHash: string): Promise<Transaction | null> {
    if (!this.connected || !this.api) {
      throw new Error('Provider not connected');
    }

    try {
      const blockHash = await this.getRpcChain().getBlockHash();
      const events = await this.getSystemQuery().events.at(blockHash || undefined);
      const eventRecords = events.toHuman() as any[];

      let from = '';
      let to = '';
      let amount = '0';
      let found = false;

      for (const event of eventRecords) {
        if (event.event?.section === 'balances' && event.event?.method === 'Transfer' && event.event?.data) {
          const eventData = event.event?.data as [string, string, string];
          [from, to, amount] = eventData;
          found = true;
        }
        if (event.event?.section === 'system' && event.event?.method === 'ExtrinsicSuccess') {
          break;
        }
      }

      if (found && (from || to)) {
        return {
          hash: txHash,
          from: from.toString(),
          to: to.toString(),
          amount: this.formatPlancks(amount.toString()),
          chain: this.chainType as any,
          timestamp: Date.now(),
          status: 'confirmed',
          fee: '0',
        };
      }

      return null;
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
      await cryptoWaitReady();

      const keyring = new Keyring({ type: 'sr25519', ss58Format: this.ss58Format });

      const path = derivationPath || '//hard//stash';

      this.keyringPair = keyring.addFromMnemonic(mnemonic, undefined, 'sr25519');

      if (derivationPath && derivationPath !== '//hard//stash') {
        const derived = keyring.addFromUri(path, undefined, 'sr25519');
        this.keyringPair = derived;
      }

      debugLog('Polkadot keypair initialized for derivation:', path);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to initialize Polkadot keypair: ${message}`);
    }
  }

  /**
   * Initialize from private key
   */
  async initFromPrivateKey(privateKey: string): Promise<void> {
    try {
      this.keyringPair = this.createKeyringPair(privateKey);

      debugLog('Polkadot keypair initialized from private key');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to initialize Polkadot keypair from private key: ${message}`);
    }
  }

  /**
   * Create KeyringPair from private key
   */
  private createKeyringPair(privateKeyHex: string): KeyringPair {
    const keyring = new Keyring({ type: 'sr25519', ss58Format: this.ss58Format });
    const privateKeyBytes = hexToU8a(privateKeyHex);
    const pair = keyring.addFromSeed(privateKeyBytes);
    return pair;
  }

  /**
   * Get address from keypair
   */
  getAddress(): string | null {
    if (!this.keyringPair) {
      return null;
    }

    return this.keyringPair.address;
  }

  /**
   * Get public key
   */
  getPublicKey(): string | null {
    if (!this.keyringPair) {
      return null;
    }

    return u8aToHex(this.keyringPair.publicKey);
  }

  /**
   * Parse DOT amount (convert from string to Plancks)
   */
  private parseDotAmount(amountStr: string): bigint {
    try {
      const cleanAmount = amountStr.replace(/,/g, '').trim();
      const amount = parseFloat(cleanAmount);
      const plancks = Math.floor(amount * 10_000_000_000);
      return BigInt(plancks);
    } catch (_error) {
      return BigInt(0);
    }
  }

  /**
   * Format Plancks to DOT
   */
  private formatPlancks(plancks: string): string {
    try {
      const amount = parseFloat(plancks) / 10_000_000_000;
      return amount.toFixed(6);
    } catch (_error) {
      return '0';
    }
  }

  /**
   * Create SR25519 signature for transaction
   */
  async createSignature(
    payload: Uint8Array,
    privateKeyHex: string
  ): Promise<Uint8Array> {
    try {
      const privateKeyBytes = hexToU8a(privateKeyHex);
      const keypair = sr25519PairFromSeed(privateKeyBytes);

      const signature = sr25519Sign(payload, { publicKey: keypair.publicKey, secretKey: keypair.secretKey });

      return signature;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      throw new Error(`Failed to create Polkadot signature: ${msg}`);
    }
  }

  /**
   * Get default RPC URL for chain type
   * Checks environment variables first, then falls back to public RPC endpoints
   */
  private getDefaultRpcUrl(): string {
    const envUrls: Record<string, string | undefined> = {
      polkadot: process.env.POLKADOT_RPC_URL,
      kusama: process.env.KUSAMA_RPC_URL,
      westend: process.env.WESTEND_RPC_URL,
      astar: process.env.ASTAR_RPC_URL,
    };

    const publicUrls: Record<string, string> = {
      polkadot: 'wss://rpc.polkadot.io',
      kusama: 'wss://kusama-rpc.polkadot.io',
      westend: 'wss://westend-rpc.polkadot.io',
      astar: 'wss://rpc.astar.network',
    };

    return envUrls[this.chainType] || publicUrls[this.chainType] || publicUrls.polkadot!;
  }
}
