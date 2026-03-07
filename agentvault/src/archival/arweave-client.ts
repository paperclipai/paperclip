/**
 * Arweave Client
 *
 * Handles interaction with Arweave network for permanent data archival.
 * Supports uploading data, retrieving transactions, and checking status.
 */

export interface ArweaveConfig {
  host?: string;
  port?: number;
  protocol?: 'http' | 'https';
  timeout?: number;
  logging?: boolean;
}

export interface UploadOptions {
  tags?: Record<string, string>;
  fee?: number;
}

export interface ArchiveTransaction {
  id: string;
  owner: string;
  tags: Record<string, string>;
  size: number;
  timestamp: Date;
  block?: {
    height: number;
    indep_hash: string;
  };
}

export interface UploadResult {
  success: boolean;
  transactionId?: string;
  error?: string;
}

export type JWKInterface = Record<string, any>;

export class ArweaveClient {
  private config: Required<ArweaveConfig>;
  private client: any = null;

  constructor(config: ArweaveConfig = {}) {
    this.config = {
      host: config.host || 'arweave.net',
      port: config.port || 443,
      protocol: config.protocol || 'https',
      timeout: config.timeout || 20000,
      logging: config.logging || false,
    };
  }

  /**
   * Initialize Arweave client (lazy loading)
   */
  private async getClient(): Promise<any> {
    if (!this.client) {
      try {
        const Arweave = await this.importArweave();
        this.client = new Arweave({
          host: this.config.host,
          port: this.config.port,
          protocol: this.config.protocol,
          timeout: this.config.timeout,
          logging: this.config.logging,
        });
      } catch (_error) {
        throw new Error(
          'arweave is required for ArweaveClient. Install with: npm install arweave',
        );
      }
    }
    return this.client;
  }

  /**
   * Dynamically import arweave (optional dependency)
   * Uses standard ESM dynamic import instead of new Function() for security
   */
  private async importArweave(): Promise<any> {
    try {
      // SECURITY: Use standard ESM dynamic import instead of new Function()
      // This avoids code execution patterns that can bypass CSP (SEC-4)
      // @ts-expect-error - arweave is an optional dependency, may not be installed
      const arweaveModule = await import('arweave');
      return arweaveModule.default;
    } catch (_error) {
      throw new Error(
        'arweave is required for ArweaveClient. Install with: npm install arweave',
      );
    }
  }

  /**
   * Upload data to Arweave
   */
  async uploadData(
    data: string | Buffer,
    jwk: JWKInterface,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    try {
      const client = await this.getClient();
      const transaction = await client.createTransaction(
        {
          data: typeof data === 'string' ? data : data.toString('base64'),
        },
        jwk,
      );

      if (options.tags) {
        for (const [key, value] of Object.entries(options.tags)) {
          transaction.addTag(key, value);
        }
      }

      await client.transactions.sign(transaction, jwk);

      const response = await client.transactions.post(transaction);

      if (response.status === 200 || response.status === 202) {
        return {
          success: true,
          transactionId: transaction.id,
        };
      } else {
        return {
          success: false,
          error: `Upload failed with status ${response.status}`,
        };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Upload JSON data to Arweave
   */
  async uploadJSON<T>(
    jsonData: T,
    jwk: JWKInterface,
    options: UploadOptions = {},
  ): Promise<UploadResult> {
    return this.uploadData(JSON.stringify(jsonData), jwk, {
      ...options,
      tags: {
        'Content-Type': 'application/json',
        ...(options.tags || {}),
      },
    });
  }

  /**
   * Get transaction data by ID
   */
  async getTransactionData(transactionId: string): Promise<string | null> {
    try {
      const client = await this.getClient();
      const data = await client.transactions.getData(transactionId, {
        decode: true,
      });
      return data.toString();
    } catch (error) {
      console.error(`Failed to fetch transaction ${transactionId}:`, error);
      return null;
    }
  }

  /**
   * Get transaction status
   */
  async getTransactionStatus(
    transactionId: string,
  ): Promise<'pending' | 'confirmed' | 'not_found' | 'error'> {
    try {
      const client = await this.getClient();
      const status = await client.transactions.getStatus(transactionId);

      if (!status) {
        return 'not_found';
      }

      if (status.confirmed && status.confirmed.number_of_confirmations > 0) {
        return 'confirmed';
      }

      return 'pending';
    } catch (error) {
      console.error(`Failed to check status for ${transactionId}:`, error);
      return 'error';
    }
  }

  /**
   * Get transaction info
   */
  async getTransaction(transactionId: string): Promise<ArchiveTransaction | null> {
    try {
      const client = await this.getClient();
      const transaction = await client.transactions.get(transactionId);

      const tags: Record<string, string> = {};
      transaction.get('tags').forEach((tag: any) => {
        const name = tag.get('name', { decode: true, string: true });
        const value = tag.get('value', { decode: true, string: true });
        if (name && value) {
          tags[name] = value;
        }
      });

      const block = transaction.get('block');
      let blockInfo;
      if (block) {
        blockInfo = {
          height: block.get('height'),
          indep_hash: block.get('indep_hash'),
        };
      }

      return {
        id: transaction.id,
        owner: transaction.owner,
        tags,
        size: parseInt(transaction.data_size, 10),
        timestamp: new Date(parseInt(transaction.last_tx, 10) * 1000),
        block: blockInfo,
      };
    } catch (error) {
      console.error(`Failed to fetch transaction ${transactionId}:`, error);
      return null;
    }
  }

  /**
   * Get wallet balance in AR
   */
  async getWalletBalance(address: string): Promise<string> {
    try {
      const client = await this.getClient();
      const balance = await client.wallets.getBalance(address);
      return client.ar.winstonToAr(balance);
    } catch (error) {
      console.error(`Failed to fetch balance for ${address}:`, error);
      return '0';
    }
  }

  /**
   * Estimate upload cost in AR
   */
  async estimateUploadCost(dataSizeBytes: number): Promise<string> {
    try {
      const client = await this.getClient();
      const price = await client.transactions.getPrice(dataSizeBytes);
      return client.ar.winstonToAr(price);
    } catch (error) {
      console.error('Failed to estimate cost:', error);
      return '0';
    }
  }

  /**
   * Generate a new Arweave wallet
   */
  async generateWallet(): Promise<JWKInterface> {
    const client = await this.getClient();
    return client.wallets.generate();
  }

  /**
   * Get wallet address from JWK
   */
  async getAddressFromJWK(jwk: JWKInterface): Promise<string> {
    const client = await this.getClient();
    return client.wallets.jwkToAddress(jwk);
  }

  /**
   * Create Arweave instance
   */
  async getClientInstance(): Promise<any> {
    return this.getClient();
  }
}
