/**
 * Unified runtime-only secret provider for AgentVault
 *
 * Design principles:
 * - Secrets are fetched from the backend (HashiCorp Vault or Bitwarden) at
 *   agent execution time and held only in process memory for the duration of
 *   that call.
 * - Values are NEVER written to canister stable storage, disk files, or any
 *   other form of persistence.
 * - Each backend must implement the `SecretProvider` interface so CLI commands
 *   and agent runtime code can be backend-agnostic.
 */

/**
 * Common interface for every secret backend.
 */
export interface SecretProvider {
  /** Human-readable backend name shown in CLI output */
  readonly name: string;

  /**
   * Retrieve a single secret value by key.
   * Returns `null` when the key does not exist.
   */
  getSecret(key: string): Promise<string | null>;

  /**
   * Store or update a secret.
   * The value travels over the wire to the backend and is not retained locally.
   */
  storeSecret(key: string, value: string): Promise<void>;

  /** Return all known secret keys (values are NOT returned). */
  listSecrets(): Promise<string[]>;

  /** Permanently delete a secret key. */
  deleteSecret(key: string): Promise<void>;

  /**
   * Confirm the backend is reachable and operational.
   * Used by `agentvault vault health`.
   */
  healthCheck(): Promise<SecretProviderHealth>;
}

export interface SecretProviderHealth {
  healthy: boolean;
  message: string;
  version?: string;
}

/**
 * Fetch a named set of secrets and return them as an environment-variable map.
 *
 * The returned object is intended to be merged with the process environment
 * **only for the duration of a single agent execution call**.  Callers MUST
 * NOT persist this map to disk, canister state, or any log output.
 *
 * Key conversion: `api_binance` → `API_BINANCE`
 *
 * @example
 * ```ts
 * const provider = new HashiCorpVaultProvider(client, agentId);
 * const env = await fetchSecretsAsEnv(provider, ['api_binance', 'openai_key']);
 * // env === { API_BINANCE: '...', OPENAI_KEY: '...' }
 * await runAgent({ env: { ...process.env, ...env } });
 * // env is never stored after this point
 * ```
 */
export async function fetchSecretsAsEnv(
  provider: SecretProvider,
  keys: string[],
): Promise<Record<string, string>> {
  const env: Record<string, string> = {};

  await Promise.all(
    keys.map(async (key) => {
      const value = await provider.getSecret(key);
      if (value !== null) {
        const envKey = key.toUpperCase().replace(/[^A-Z0-9]/g, '_');
        env[envKey] = value;
      }
    }),
  );

  return env;
}

/**
 * Fetch ALL secrets for an agent and return them as an env-var map.
 * Same zero-persistence guarantee as `fetchSecretsAsEnv`.
 */
export async function fetchAllSecretsAsEnv(
  provider: SecretProvider,
): Promise<Record<string, string>> {
  const keys = await provider.listSecrets();
  return fetchSecretsAsEnv(provider, keys);
}
