import { loadStorageConfig, type StorageConfig } from "../storage/config.js";
import { createStorageProviderFromConfig } from "../storage/provider-registry.js";

export function resolveRunEvidenceStorage(config: StorageConfig = loadStorageConfig()) {
  if (config.storageProvider !== "s3") return undefined;
  return {
    provider: createStorageProviderFromConfig(config),
    keyPrefix: "run-logs",
    tracePrefix: "provider-traces",
  };
}
