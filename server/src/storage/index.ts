import { loadConfig, type Config } from "../config.js";
import { createStorageProviderFromConfig } from "./provider-registry.js";
import { createStorageService } from "./service.js";
import type { StorageService } from "./types.js";

let cachedStorageService: StorageService | null = null;
let cachedSignature: string | null = null;

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

/** Creates a StorageService from a Config object, selecting the appropriate provider. */
export function createStorageServiceFromConfig(config: Config): StorageService {
  return createStorageService(createStorageProviderFromConfig(config));
}

/** Returns the cached singleton StorageService, recreating it if the config has changed. */
export function getStorageService(): StorageService {
  const config = loadConfig();
  const signature = signatureForConfig(config);
  if (!cachedStorageService || cachedSignature !== signature) {
    cachedStorageService = createStorageServiceFromConfig(config);
    cachedSignature = signature;
  }
  return cachedStorageService;
}

export type { StorageService, PutFileResult } from "./types.js";
