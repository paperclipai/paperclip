/**
 * HashiCorp Vault client for agent secret management
 *
 * Provides a per-agent interface to HashiCorp Vault for reading, writing,
 * listing, and deleting secrets. Each agent gets an isolated secret path
 * enforced by policy.
 */

import type {
  VaultConfig,
  AgentVaultPolicy,
  VaultSecret,
  VaultSecretMetadata,
  VaultOperationResult,
  VaultHealthStatus,
  VaultSecretListEntry,
  AgentVaultInitOptions,
} from './types.js';
import {
  loadVaultConfig,
  getOrCreateAgentPolicy,
  validateVaultConfig,
} from './config.js';

/**
 * HTTP response from Vault API
 */
interface VaultAPIResponse {
  data?: {
    data?: Record<string, string>;
    metadata?: {
      version: number;
      created_time: string;
      custom_metadata?: Record<string, string> | null;
      destroyed: boolean;
    };
    keys?: string[];
  };
  auth?: {
    client_token: string;
    lease_duration: number;
    renewable: boolean;
  };
  errors?: string[];
}

/**
 * HashiCorp Vault client for agent secret management
 *
 * Each agent gets its own private namespace under `agents/<agentId>/secrets`
 * in the configured KV secrets engine.
 */
export class VaultClient {
  private config: VaultConfig;
  private policy: AgentVaultPolicy;
  private clientToken: string | null = null;

  constructor(config: VaultConfig, policy: AgentVaultPolicy) {
    this.config = config;
    this.policy = policy;
  }

  /**
   * Create a VaultClient for a specific agent
   *
   * Loads Vault configuration from disk/environment and creates or loads
   * the agent's policy.
   *
   * @param agentId - Agent identifier
   * @param options - Optional initialization options
   * @returns Configured VaultClient
   * @throws Error if Vault is not configured
   */
  static create(agentId: string, options?: AgentVaultInitOptions): VaultClient {
    const config = loadVaultConfig();
    if (!config) {
      throw new Error(
        'Vault is not configured. Set VAULT_ADDR and VAULT_TOKEN environment variables, ' +
        'or run `agentvault vault init` to configure.'
      );
    }

    const errors = validateVaultConfig(config);
    if (errors.length > 0) {
      throw new Error(`Invalid Vault configuration: ${errors.join(', ')}`);
    }

    const policy = getOrCreateAgentPolicy(
      agentId,
      options?.engine ?? 'kv-v2',
    );

    if (options?.maxSecrets) {
      policy.maxSecrets = options.maxSecrets;
    }
    if (options?.allowedKeyPatterns) {
      policy.allowedKeyPatterns = options.allowedKeyPatterns;
    }

    return new VaultClient(config, policy);
  }

  /**
   * Create a VaultClient with explicit config (useful for testing)
   */
  static createWithConfig(config: VaultConfig, policy: AgentVaultPolicy): VaultClient {
    return new VaultClient(config, policy);
  }

  /**
   * Get the effective authentication token
   */
  private async getToken(): Promise<string> {
    if (this.clientToken) {
      return this.clientToken;
    }

    switch (this.config.authMethod) {
      case 'token':
        if (!this.config.token) {
          throw new Error('Vault token not configured');
        }
        this.clientToken = this.config.token;
        return this.clientToken;

      case 'approle':
        return this.authenticateAppRole();

      case 'userpass':
        return this.authenticateUserPass();

      case 'kubernetes':
        return this.authenticateKubernetes();

      default:
        throw new Error(`Unsupported auth method: ${this.config.authMethod}`);
    }
  }

  /**
   * Authenticate using AppRole credentials
   */
  private async authenticateAppRole(): Promise<string> {
    const response = await this.rawRequest('POST', '/v1/auth/approle/login', {
      role_id: this.config.roleId,
      secret_id: this.config.secretId,
    });

    if (!response.auth?.client_token) {
      throw new Error('AppRole authentication failed: no token returned');
    }

    this.clientToken = response.auth.client_token;
    return this.clientToken;
  }

  /**
   * Authenticate using username/password
   */
  private async authenticateUserPass(): Promise<string> {
    const response = await this.rawRequest(
      'POST',
      `/v1/auth/userpass/login/${this.config.username}`,
      { password: this.config.password },
    );

    if (!response.auth?.client_token) {
      throw new Error('Userpass authentication failed: no token returned');
    }

    this.clientToken = response.auth.client_token;
    return this.clientToken;
  }

  /**
   * Authenticate using Kubernetes service account
   */
  private async authenticateKubernetes(): Promise<string> {
    const fs = await import('node:fs');
    const jwtPath = '/var/run/secrets/kubernetes.io/serviceaccount/token';

    let jwt: string;
    try {
      jwt = fs.readFileSync(jwtPath, 'utf-8').trim();
    } catch {
      throw new Error(`Cannot read Kubernetes service account token from ${jwtPath}`);
    }

    const response = await this.rawRequest('POST', '/v1/auth/kubernetes/login', {
      role: this.config.k8sRole,
      jwt,
    });

    if (!response.auth?.client_token) {
      throw new Error('Kubernetes authentication failed: no token returned');
    }

    this.clientToken = response.auth.client_token;
    return this.clientToken;
  }

  /**
   * Make a raw HTTP request to the Vault API
   */
  private async rawRequest(
    method: string,
    apiPath: string,
    body?: Record<string, unknown>,
  ): Promise<VaultAPIResponse> {
    const url = `${this.config.address}${apiPath}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };

    if (this.clientToken || this.config.token) {
      headers['X-Vault-Token'] = this.clientToken || this.config.token!;
    }

    if (this.config.namespace) {
      headers['X-Vault-Namespace'] = this.config.namespace;
    }

    const controller = new AbortController();
    const timeout = this.config.timeoutMs ?? 30000;
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: controller.signal,
      };

      if (body && method !== 'GET') {
        fetchOptions.body = JSON.stringify(body);
      }

      const response = await fetch(url, fetchOptions);

      if (response.status === 204) {
        return {};
      }

      const data = await response.json() as VaultAPIResponse;

      if (!response.ok) {
        const errors = data.errors?.join(', ') ?? `HTTP ${response.status}`;
        throw new Error(`Vault API error: ${errors}`);
      }

      return data;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Make an authenticated request to the Vault API
   */
  private async request(
    method: string,
    apiPath: string,
    body?: Record<string, unknown>,
  ): Promise<VaultAPIResponse> {
    await this.getToken();
    return this.rawRequest(method, apiPath, body);
  }

  /**
   * Build the full Vault API path for a KV secret
   */
  private buildSecretPath(key: string, action: 'data' | 'metadata' = 'data'): string {
    const engine = this.policy.engine === 'kv-v1' ? '' : action;
    const basePath = this.policy.secretPath;

    if (this.policy.engine === 'kv-v1') {
      return `/v1/${basePath}/${key}`;
    }

    // KV v2: /v1/<mount>/data/<path>
    const parts = basePath.split('/');
    const mount = parts[0];
    const secretSubPath = parts.slice(1).join('/');

    return `/v1/${mount}/${engine}/${secretSubPath}/${key}`;
  }

  /**
   * Build the list path for secrets
   */
  private buildListPath(): string {
    const basePath = this.policy.secretPath;

    if (this.policy.engine === 'kv-v1') {
      return `/v1/${basePath}`;
    }

    const parts = basePath.split('/');
    const mount = parts[0];
    const secretSubPath = parts.slice(1).join('/');

    return `/v1/${mount}/metadata/${secretSubPath}`;
  }

  /**
   * Validate a secret key against the agent's policy
   */
  private validateKey(key: string): string | null {
    if (!key || key.trim().length === 0) {
      return 'Secret key cannot be empty';
    }

    if (key.includes('..') || key.startsWith('/')) {
      return 'Secret key cannot contain path traversal sequences';
    }

    if (this.policy.allowedKeyPatterns && this.policy.allowedKeyPatterns.length > 0) {
      const matches = this.policy.allowedKeyPatterns.some(pattern => {
        const regex = new RegExp(
          '^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$'
        );
        return regex.test(key);
      });

      if (!matches) {
        return `Secret key "${key}" does not match allowed patterns: ${this.policy.allowedKeyPatterns.join(', ')}`;
      }
    }

    return null;
  }

  /**
   * Get the agent ID this client is configured for
   */
  get agentId(): string {
    return this.policy.agentId;
  }

  /**
   * Get the secret path for this agent
   */
  get secretPath(): string {
    return this.policy.secretPath;
  }

  /**
   * Check Vault server health
   *
   * @returns Vault health status
   */
  async health(): Promise<VaultOperationResult<VaultHealthStatus>> {
    try {
      const response = await fetch(`${this.config.address}/v1/sys/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 5000),
      });

      const data = await response.json() as {
        initialized: boolean;
        sealed: boolean;
        version: string;
        cluster_name?: string;
      };

      return {
        success: true,
        data: {
          initialized: data.initialized,
          sealed: data.sealed,
          version: data.version,
          clusterName: data.cluster_name,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        error: `Failed to check Vault health: ${message}`,
      };
    }
  }

  /**
   * Get a secret by key
   *
   * @param key - Secret key
   * @returns The secret value and metadata
   */
  async getSecret(key: string): Promise<VaultOperationResult<VaultSecret>> {
    const keyError = this.validateKey(key);
    if (keyError) {
      return { success: false, error: keyError };
    }

    try {
      const apiPath = this.buildSecretPath(key);
      const response = await this.request('GET', apiPath);

      if (!response.data) {
        return { success: false, error: `Secret "${key}" not found` };
      }

      const secretData = response.data.data ?? {};
      const metadata = response.data.metadata;

      const secret: VaultSecret = {
        key,
        value: secretData,
        metadata: {
          version: metadata?.version ?? 1,
          createdAt: metadata?.created_time ?? new Date().toISOString(),
          updatedAt: metadata?.created_time ?? new Date().toISOString(),
          destroyed: metadata?.destroyed ?? false,
          customMetadata: metadata?.custom_metadata ?? undefined,
        },
      };

      return { success: true, data: secret };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Failed to get secret "${key}": ${message}` };
    }
  }

  /**
   * Store a secret
   *
   * @param key - Secret key
   * @param value - Secret value (string or key-value map)
   * @param metadata - Optional custom metadata
   * @returns Operation result
   */
  async putSecret(
    key: string,
    value: string | Record<string, string>,
    metadata?: Record<string, string>,
  ): Promise<VaultOperationResult<VaultSecretMetadata>> {
    const keyError = this.validateKey(key);
    if (keyError) {
      return { success: false, error: keyError };
    }

    if (!this.policy.allowCreate && !this.policy.allowUpdate) {
      return {
        success: false,
        error: `Agent "${this.policy.agentId}" is not allowed to write secrets`,
      };
    }

    try {
      // Convert string values to a data map
      const data = typeof value === 'string'
        ? { value }
        : value;

      const body: Record<string, unknown> = { data };

      if (metadata && this.policy.engine === 'kv-v2') {
        body.options = { cas: 0 };
      }

      const apiPath = this.buildSecretPath(key);
      const response = await this.request('POST', apiPath, body);

      const resultMetadata: VaultSecretMetadata = {
        version: response.data?.metadata?.version ?? 1,
        createdAt: response.data?.metadata?.created_time ?? new Date().toISOString(),
        updatedAt: response.data?.metadata?.created_time ?? new Date().toISOString(),
        destroyed: false,
        customMetadata: metadata,
      };

      // Store custom metadata separately if provided (KV v2 only)
      if (metadata && this.policy.engine === 'kv-v2') {
        try {
          const metadataPath = this.buildSecretPath(key, 'metadata');
          await this.request('POST', metadataPath, {
            custom_metadata: metadata,
          });
        } catch {
          // Non-fatal: metadata storage failure shouldn't fail the secret write
        }
      }

      return { success: true, data: resultMetadata };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Failed to put secret "${key}": ${message}` };
    }
  }

  /**
   * Delete a secret
   *
   * @param key - Secret key to delete
   * @returns Operation result
   */
  async deleteSecret(key: string): Promise<VaultOperationResult> {
    const keyError = this.validateKey(key);
    if (keyError) {
      return { success: false, error: keyError };
    }

    if (!this.policy.allowDelete) {
      return {
        success: false,
        error: `Agent "${this.policy.agentId}" is not allowed to delete secrets`,
      };
    }

    try {
      const apiPath = this.buildSecretPath(key);
      await this.request('DELETE', apiPath);

      return { success: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: `Failed to delete secret "${key}": ${message}` };
    }
  }

  /**
   * List all secret keys for this agent
   *
   * @returns List of secret entries
   */
  async listSecrets(): Promise<VaultOperationResult<VaultSecretListEntry[]>> {
    if (!this.policy.allowList) {
      return {
        success: false,
        error: `Agent "${this.policy.agentId}" is not allowed to list secrets`,
      };
    }

    try {
      const apiPath = this.buildListPath();
      const response = await this.request('LIST', apiPath);

      const keys = response.data?.keys ?? [];
      const entries: VaultSecretListEntry[] = keys.map(key => ({
        key,
        version: 0,
        createdAt: '',
        updatedAt: '',
      }));

      return { success: true, data: entries };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';

      // LIST returns 404 when there are no secrets
      if (message.includes('404') || message.includes('not found')) {
        return { success: true, data: [] };
      }

      return { success: false, error: `Failed to list secrets: ${message}` };
    }
  }

  /**
   * Check if a specific secret exists
   *
   * @param key - Secret key to check
   * @returns Whether the secret exists
   */
  async secretExists(key: string): Promise<boolean> {
    const result = await this.getSecret(key);
    return result.success && !!result.data;
  }

  /**
   * Get the agent's Vault policy
   */
  getPolicy(): AgentVaultPolicy {
    return { ...this.policy };
  }
}
