import { loadConfig, type Config } from "../config.js";
import { createStorageProviderFromConfig } from "./provider-registry.js";
import { createStorageService } from "./service.js";
import type { StorageProvider, StorageService } from "./types.js";

let cachedStorageService: StorageService | null = null;
let cachedSignature: string | null = null;
let cachedStorageProvider: StorageProvider | null = null;
let cachedProviderSignature: string | null = null;

function signatureForConfig(config: Config): string {
  return JSON.stringify({
    provider: config.storageProvider,
    localDisk: config.storageLocalDiskBaseDir,
    s3Bucket: config.storageS3Bucket,
    s3Region: config.storageS3Region,
    s3Endpoint: config.storageS3Endpoint,
    s3Prefix: config.storageS3Prefix,
    s3ForcePathStyle: config.storageS3ForcePathStyle,
  });
}

export function createStorageServiceFromConfig(config: Config): StorageService {
  return createStorageService(createStorageProviderFromConfig(config));
}

export function getStorageService(): StorageService {
  const config = loadConfig();
  const signature = signatureForConfig(config);
  if (!cachedStorageService || cachedSignature !== signature) {
    cachedStorageService = createStorageServiceFromConfig(config);
    cachedSignature = signature;
  }
  return cachedStorageService;
}

/**
 * The raw, non-company-scoped {@link StorageProvider} behind the facade. The
 * company-scoped {@link StorageService} enforces a `<companyId>/` object-key
 * prefix, which is the right guard for tenant-facing artifact requests but not
 * for system-level keys like the run-log archive
 * (`run-logs/<companyId>/<agentId>/<runId>.ndjson.gz`). System sweepers/readers
 * use this provider directly; it stays provider-swappable (local_disk ↔ s3) and
 * never leaks the underlying SDK.
 */
export function getStorageProvider(): StorageProvider {
  const config = loadConfig();
  const signature = signatureForConfig(config);
  if (!cachedStorageProvider || cachedProviderSignature !== signature) {
    cachedStorageProvider = createStorageProviderFromConfig(config);
    cachedProviderSignature = signature;
  }
  return cachedStorageProvider;
}

export type { StorageProvider, StorageService, PutFileResult } from "./types.js";
