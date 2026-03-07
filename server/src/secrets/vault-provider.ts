/**
 * HashiCorp Vault secret provider — powered by AgentVault
 *
 * Bridges AgentVault's VaultClient to Paperclip's SecretProviderModule interface.
 * Secrets are stored in Vault under company-scoped paths:
 *   companies/<companyId>/secrets/<secretName>
 *
 * Configuration via environment variables:
 *   VAULT_ADDR   — Vault server address (e.g. http://127.0.0.1:8200)
 *   VAULT_TOKEN  — Vault authentication token
 *
 * When VAULT_ADDR is not set, the provider is inactive and operations throw.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  VaultClient,
  loadVaultConfig,
  validateVaultConfig,
  type VaultConfig,
  type AgentVaultPolicy,
} from "agentvault/vault";
import type { SecretProviderModule, StoredSecretVersionMaterial } from "./types.js";
import { unprocessable } from "../errors.js";

interface VaultSecretMaterial extends StoredSecretVersionMaterial {
  scheme: "vault_v1";
  /** Vault KV path where the secret is stored */
  vaultPath: string;
  /** Key within the KV data map */
  vaultKey: string;
  /** Vault secret version at write time */
  vaultVersion: number;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isVaultMaterial(m: StoredSecretVersionMaterial): m is VaultSecretMaterial {
  return (
    m != null &&
    typeof m === "object" &&
    (m as VaultSecretMaterial).scheme === "vault_v1" &&
    typeof (m as VaultSecretMaterial).vaultPath === "string" &&
    typeof (m as VaultSecretMaterial).vaultKey === "string"
  );
}

/** Resolve a Vault path from the externalRef or generate a default */
function resolveVaultPath(externalRef: string | null): { path: string; key: string } {
  if (externalRef && externalRef.trim().length > 0) {
    // If the ref contains a "/" treat last segment as the key
    const trimmed = externalRef.trim();
    const lastSlash = trimmed.lastIndexOf("/");
    if (lastSlash > 0) {
      return {
        path: trimmed.substring(0, lastSlash),
        key: trimmed.substring(lastSlash + 1),
      };
    }
    return { path: trimmed, key: "value" };
  }
  // Auto-generate a unique path
  return { path: `paperclip/${randomUUID()}`, key: "value" };
}

/** Lazily cached Vault config — loaded once per process */
let cachedConfig: VaultConfig | null | undefined;

function getVaultConfig(): VaultConfig {
  if (cachedConfig === undefined) {
    cachedConfig = loadVaultConfig();
  }
  if (!cachedConfig) {
    throw unprocessable("HashiCorp Vault is not configured. Set VAULT_ADDR and VAULT_TOKEN.");
  }
  const errors = validateVaultConfig(cachedConfig);
  if (errors.length > 0) {
    throw unprocessable(`Invalid Vault configuration: ${errors.join(", ")}`);
  }
  return cachedConfig;
}

function createClient(vaultPath: string): VaultClient {
  const config = getVaultConfig();
  // Build a Paperclip-specific policy — full read/write, path-scoped
  const policy: AgentVaultPolicy = {
    agentId: "paperclip-server",
    secretPath: vaultPath,
    engine: "kv-v2",
    allowCreate: true,
    allowUpdate: true,
    allowDelete: true,
    allowList: true,
  };
  return VaultClient.createWithConfig(config, policy);
}

/** Check whether Vault is configured (non-throwing) */
export function isVaultConfigured(): boolean {
  try {
    getVaultConfig();
    return true;
  } catch {
    return false;
  }
}

export const vaultProvider: SecretProviderModule = {
  id: "vault",
  descriptor: {
    id: "vault",
    label: "HashiCorp Vault (AgentVault)",
    requiresExternalRef: false,
  },

  async createVersion(input) {
    const { path: vaultPath, key: vaultKey } = resolveVaultPath(input.externalRef);
    const client = createClient(vaultPath);

    const result = await client.putSecret(vaultKey, input.value);
    if (!result.success) {
      throw unprocessable(`Vault write failed: ${result.error ?? "unknown error"}`);
    }

    const material: VaultSecretMaterial = {
      scheme: "vault_v1",
      vaultPath,
      vaultKey,
      vaultVersion: result.data?.version ?? 1,
    };

    return {
      material,
      valueSha256: sha256Hex(input.value),
      externalRef: `${vaultPath}/${vaultKey}`,
    };
  },

  async resolveVersion(input) {
    if (!isVaultMaterial(input.material)) {
      throw unprocessable("Invalid Vault secret material — expected vault_v1 scheme");
    }

    const { vaultPath, vaultKey } = input.material;
    const client = createClient(vaultPath);

    const result = await client.getSecret(vaultKey);
    if (!result.success || !result.data) {
      throw unprocessable(
        `Vault read failed for ${vaultPath}/${vaultKey}: ${result.error ?? "secret not found"}`,
      );
    }

    const { value } = result.data;
    if (typeof value === "string") return value;
    if (typeof value === "object" && "value" in value) {
      return (value as Record<string, string>).value ?? "";
    }
    return JSON.stringify(value);
  },
};
