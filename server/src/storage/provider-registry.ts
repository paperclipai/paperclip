import type { Config } from "../config.js";
import type { StorageProvider as StorageProviderId } from "@paperclipai/shared";
import type { StorageProvider } from "./types.js";
import { createLocalDiskStorageProvider } from "./local-disk-provider.js";
import { createS3StorageProvider } from "./s3-provider.js";

export function createStorageProvidersFromConfig(config: Config): Record<StorageProviderId, StorageProvider> {
  return {
    local_disk: createLocalDiskStorageProvider(config.storageLocalDiskBaseDir),
    s3: createS3StorageProvider({
      bucket: config.storageS3Bucket,
      region: config.storageS3Region,
      endpoint: config.storageS3Endpoint,
      prefix: config.storageS3Prefix,
      forcePathStyle: config.storageS3ForcePathStyle,
    }),
  };
}

export function createStorageProviderFromConfig(config: Config): StorageProvider {
  return createStorageProvidersFromConfig(config)[config.storageProvider];
}
