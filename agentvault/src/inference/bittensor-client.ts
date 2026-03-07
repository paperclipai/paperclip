/**
 * Bittensor Client
 *
 * Handles interaction with Bittensor network for AI inference queries.
 * Supports subnet discovery, module queries, neuron queries, and response handling.
 * Supports wallet hotkey authentication for authenticated inference requests.
 */

import crypto from 'node:crypto';

export interface WalletConfig {
  /** ss58-encoded hotkey address (public key) */
  hotkey: string;
  /** ss58-encoded coldkey address (public key, optional) */
  coldkey?: string;
  /** Hotkey private key hex for signing requests (32 bytes hex) */
  hotkeySecret?: string;
}

export interface BittensorConfig {
  apiEndpoint?: string;
  timeout?: number;
  apiKey?: string;
  /** Wallet for authenticated requests */
  wallet?: WalletConfig;
}

export interface NeuronInfo {
  uid: number;
  hotkey: string;
  coldkey: string;
  stake: number;
  trust: number;
  consensus: number;
  incentive: number;
  dividends: number;
  emission: number;
  rank: number;
  validator_permit: boolean;
  active: boolean;
  axon_info?: {
    ip: string;
    port: number;
    version: number;
    protocol: number;
  };
}

export interface SubnetInfo {
  netuid: number;
  name: string;
  founder: string;
  tempo: number;
  modality: string;
  registered: number;
  last_emit_block: number;
}

export interface ModuleInfo {
  uid: number;
  name: string;
  address: string;
  stake: number;
  dividend: number;
  emission: number;
  incentive: number;
  consensus: number;
  trust: number;
  rank: number;
  validator_permit: boolean;
}

export interface InferenceRequest {
  netuid: number;
  uid?: number;
  inputs: Record<string, any>;
  timeout?: number;
}

export interface InferenceResponse {
  success: boolean;
  data?: Record<string, any>;
  metadata?: {
    uid: number;
    name: string;
    netuid: number;
    responseTime: number;
  };
  error?: string;
}

export class BittensorClient {
  private config: Required<Omit<BittensorConfig, 'wallet'>> & { wallet?: WalletConfig };
  private axiosInstance: any = null;

  constructor(config: BittensorConfig = {}) {
    this.config = {
      apiEndpoint: config.apiEndpoint || 'https://api.bittensor.com',
      timeout: config.timeout || 30000,
      apiKey: config.apiKey || '',
      wallet: config.wallet,
    };
  }

  /**
   * Initialize HTTP client (lazy loading)
   */
  private async getClient(): Promise<any> {
    if (!this.axiosInstance) {
      const axios = await this.importAxios();
      this.axiosInstance = axios.create({
        baseURL: this.config.apiEndpoint,
        timeout: this.config.timeout,
        headers: {
          'Content-Type': 'application/json',
          ...(this.config.apiKey && { 'X-API-Key': this.config.apiKey }),
          ...(this.config.wallet?.hotkey && { 'X-Hotkey': this.config.wallet.hotkey }),
        },
      });
    }
    return this.axiosInstance;
  }

  /**
   * Sign a request payload with the wallet hotkey secret (HMAC-SHA256).
   * In production this would use sr25519 or ed25519 signing.
   */
  private signPayload(payload: string): string | undefined {
    const secret = this.config.wallet?.hotkeySecret;
    if (!secret) return undefined;
    return crypto.createHmac('sha256', secret).update(payload).digest('hex');
  }

  /**
   * Build authentication headers for a request
   */
  private buildAuthHeaders(payload?: string): Record<string, string> {
    const headers: Record<string, string> = {};
    if (!this.config.wallet?.hotkey) return headers;
    headers['X-Hotkey'] = this.config.wallet.hotkey;
    if (payload) {
      const sig = this.signPayload(payload);
      if (sig) headers['X-Signature'] = sig;
    }
    return headers;
  }

  /**
   * Dynamically import axios (optional dependency)
   * Uses standard ESM dynamic import instead of new Function() for security
   */
  private async importAxios(): Promise<any> {
    try {
      // SECURITY: Use standard ESM dynamic import instead of new Function()
      // This avoids code execution patterns that can bypass CSP (SEC-4)
      // @ts-expect-error - axios is an optional dependency, may not be installed
      const axiosModule = await import('axios');
      return axiosModule.default;
    } catch (_error) {
      throw new Error(
        'axios is required for BittensorClient. Install with: npm install axios',
      );
    }
  }

  /**
   * Get all subnets
   */
  async getSubnets(): Promise<SubnetInfo[]> {
    try {
      const client = await this.getClient();
      const response = await client.get('/subnets');

      return response.data.subnets || [];
    } catch (error) {
      console.error('Failed to fetch subnets:', error);
      return [];
    }
  }

  /**
   * Get subnet by ID
   */
  async getSubnet(netuid: number): Promise<SubnetInfo | null> {
    try {
      const subnets = await this.getSubnets();
      return subnets.find((s) => s.netuid === netuid) || null;
    } catch (error) {
      console.error(`Failed to fetch subnet ${netuid}:`, error);
      return null;
    }
  }

  /**
   * Get modules for a subnet
   */
  async getModules(netuid: number): Promise<ModuleInfo[]> {
    try {
      const client = await this.getClient();
      const response = await client.get(`/subnets/${netuid}/modules`);

      return response.data.modules || [];
    } catch (error) {
      console.error(`Failed to fetch modules for subnet ${netuid}:`, error);
      return [];
    }
  }

  /**
   * Get module by UID
   */
  async getModule(netuid: number, uid: number): Promise<ModuleInfo | null> {
    try {
      const modules = await this.getModules(netuid);
      return modules.find((m) => m.uid === uid) || null;
    } catch (error) {
      console.error(`Failed to fetch module ${netuid}/${uid}:`, error);
      return null;
    }
  }

  /**
   * Get all neurons for a subnet via the /neurons endpoint.
   * Requires a wallet hotkey for authenticated access.
   */
  async getNeurons(netuid: number): Promise<NeuronInfo[]> {
    try {
      const client = await this.getClient();
      const authHeaders = this.buildAuthHeaders(String(netuid));
      const response = await client.get(`/neurons/${netuid}`, {
        headers: authHeaders,
      });
      return response.data.neurons || response.data || [];
    } catch (error) {
      console.error(`Failed to fetch neurons for subnet ${netuid}:`, error);
      return [];
    }
  }

  /**
   * Perform an inference request authenticated with wallet hotkey.
   * Returns the result and whether the response time is under 1 second.
   */
  async inferWithWallet(request: InferenceRequest): Promise<InferenceResponse & { subSecond?: boolean }> {
    const startTime = Date.now();
    const body = JSON.stringify({
      uid: request.uid,
      inputs: request.inputs,
      timeout: request.timeout || this.config.timeout,
    });

    try {
      const client = await this.getClient();
      const authHeaders = this.buildAuthHeaders(body);
      const response = await client.post(
        `/neurons/${request.netuid}/infer`,
        JSON.parse(body),
        { headers: authHeaders },
      );

      const responseTime = Date.now() - startTime;

      if (response.data.success) {
        return {
          success: true,
          data: response.data.output,
          metadata: {
            uid: response.data.uid,
            name: response.data.name,
            netuid: request.netuid,
            responseTime,
          },
          subSecond: responseTime < 1000,
        };
      } else {
        return {
          success: false,
          error: response.data.error || 'Inference failed',
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
   * Send inference request
   */
  async infer(request: InferenceRequest): Promise<InferenceResponse> {
    const startTime = Date.now();

    try {
      const client = await this.getClient();
      const response = await client.post(`/subnets/${request.netuid}/infer`, {
        uid: request.uid,
        inputs: request.inputs,
        timeout: request.timeout || this.config.timeout,
      });

      const responseTime = Date.now() - startTime;

      if (response.data.success) {
        return {
          success: true,
          data: response.data.output,
          metadata: {
            uid: response.data.uid,
            name: response.data.name,
            netuid: request.netuid,
            responseTime,
          },
        };
      } else {
        return {
          success: false,
          error: response.data.error || 'Inference failed',
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
   * Find best module for a subnet
   */
  async findBestModule(
    netuid: number,
    criteria: 'stake' | 'trust' | 'rank' | 'consensus' = 'rank',
  ): Promise<ModuleInfo | null> {
    try {
      const modules = await this.getModules(netuid);
      if (modules.length === 0) {
        return null;
      }

      return modules
        .sort((a, b) => b[criteria] - a[criteria])
        .slice(0, 1)[0] || null;
    } catch (error) {
      console.error('Failed to find best module:', error);
      return null;
    }
  }

  /**
   * Batch inference to multiple modules
   */
  async batchInfer(
    request: InferenceRequest,
    limit: number = 5,
  ): Promise<InferenceResponse[]> {
    try {
      const modules = await this.getModules(request.netuid);
      const topModules = modules
        .sort((a, b) => b.rank - a.rank)
        .slice(0, limit);

      const promises = topModules.map((module) =>
        this.infer({ ...request, uid: module.uid }),
      );

      return Promise.all(promises);
    } catch (error) {
      console.error('Failed to batch infer:', error);
      return [];
    }
  }

  /**
   * Health check for subnet
   */
  async checkSubnetHealth(netuid: number): Promise<{
    healthy: boolean;
    moduleCount: number;
    avgResponseTime: number;
  }> {
    const startTime = Date.now();

    try {
      const modules = await this.getModules(netuid);
      if (modules.length === 0) {
        return {
          healthy: false,
          moduleCount: 0,
          avgResponseTime: 0,
        };
      }

      const responseTime = Date.now() - startTime;

      return {
        healthy: true,
        moduleCount: modules.length,
        avgResponseTime: responseTime,
      };
    } catch (_error) {
      return {
        healthy: false,
        moduleCount: 0,
        avgResponseTime: 0,
      };
    }
  }

  /**
   * Get API status
   */
  async getApiStatus(): Promise<{ online: boolean; version?: string; error?: string }> {
    try {
      const client = await this.getClient();
      const response = await client.get('/status');

      return {
        online: response.data.online || false,
        version: response.data.version,
      };
    } catch (error) {
      return {
        online: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}
