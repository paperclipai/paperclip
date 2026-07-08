import { loadConfig, type Config } from "../config.js";
import { createS3StorageProviderFromConfig, createStorageProviderFromConfig } from "./provider-registry.js";
import { createStorageService } from "./service.js";
import type { StorageProvider, StorageService } from "./types.js";

let cachedStorageService: StorageService | null = null;
let cachedSignature: string | null = null;
let cachedStorageProvider: StorageProvider | null = null;
let cachedProviderSignature: string | null = null;
let cachedArchiveProvider: StorageProvider | null = null;
let cachedArchiveSignature: string | null = null;

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

/**
 * Storage provider for the run-log cold-archive leg (archive writes + `s3`-tier
 * reads). When `PAPERCLIP_RUN_LOG_ARCHIVE=s3` (forced mode) this returns an S3
 * provider built straight from the `storageS3*` config, so a deployment can keep
 * its primary storage on local_disk while still archiving/retrieving run logs
 * from object storage. Any other mode delegates to the app-wide
 * {@link getStorageProvider}, so archive and retrieval always share one provider.
 */
export function getRunLogArchiveStorageProvider(): StorageProvider {
  const config = loadConfig();
  if (config.runLogArchiveMode !== "s3") return getStorageProvider();
  const signature = signatureForConfig(config);
  if (!cachedArchiveProvider || cachedArchiveSignature !== signature) {
    cachedArchiveProvider = createS3StorageProviderFromConfig(config);
    cachedArchiveSignature = signature;
  }
  return cachedArchiveProvider;
}

export type { StorageProvider, StorageService, PutFileResult } from "./types.js";
