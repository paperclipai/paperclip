/**
 * Vault backbone service — health and configuration status.
 *
 * Provides a unified view of the AgentVault backbone health
 * including HashiCorp Vault connectivity.
 */

import {
  VaultClient,
  loadVaultConfig,
  validateVaultConfig,
  type AgentVaultPolicy,
} from "agentvault/vault";
import { isVaultConfigured } from "../secrets/vault-provider.js";

export interface VaultBackboneStatus {
  configured: boolean;
  healthy: boolean;
  vaultAddress: string | null;
  vaultVersion: string | null;
  message: string;
}

export function vaultService() {
  return {
    /** Get the overall backbone health status */
    health: async (): Promise<VaultBackboneStatus> => {
      if (!isVaultConfigured()) {
        return {
          configured: false,
          healthy: false,
          vaultAddress: null,
          vaultVersion: null,
          message: "Vault is not configured. Set VAULT_ADDR and VAULT_TOKEN.",
        };
      }

      const config = loadVaultConfig();
      if (!config) {
        return {
          configured: false,
          healthy: false,
          vaultAddress: null,
          vaultVersion: null,
          message: "Vault configuration could not be loaded.",
        };
      }

      const errors = validateVaultConfig(config);
      if (errors.length > 0) {
        return {
          configured: true,
          healthy: false,
          vaultAddress: config.address,
          vaultVersion: null,
          message: `Invalid configuration: ${errors.join(", ")}`,
        };
      }

      // Create a minimal client to check health
      const policy: AgentVaultPolicy = {
        agentId: "paperclip-health-check",
        secretPath: "paperclip/health",
        engine: "kv-v2",
        allowCreate: false,
        allowUpdate: false,
        allowDelete: false,
        allowList: false,
      };

      const client = VaultClient.createWithConfig(config, policy);
      const result = await client.health();

      if (!result.success || !result.data) {
        return {
          configured: true,
          healthy: false,
          vaultAddress: config.address,
          vaultVersion: null,
          message: result.error ?? "Vault health check failed",
        };
      }

      const { initialized, sealed, version } = result.data;
      if (!initialized) {
        return {
          configured: true,
          healthy: false,
          vaultAddress: config.address,
          vaultVersion: version,
          message: "Vault is not initialized",
        };
      }
      if (sealed) {
        return {
          configured: true,
          healthy: false,
          vaultAddress: config.address,
          vaultVersion: version,
          message: "Vault is sealed",
        };
      }

      return {
        configured: true,
        healthy: true,
        vaultAddress: config.address,
        vaultVersion: version,
        message: "Vault backbone is healthy",
      };
    },
  };
}
