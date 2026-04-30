import type { StorageProvider as StorageProviderId } from "@paperclipai/shared";

export function normalizeStorageProviderOverride(
  provider: string | null | undefined,
): StorageProviderId | undefined {
  if (provider === "local_disk" || provider === "s3") {
    return provider;
  }
  return undefined;
}
