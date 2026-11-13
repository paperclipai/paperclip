import { isCloudManagedInstance } from "./services/cloud-instance.js";
import { parseManagedConfigEnv, type ManagedConfigEnv } from "./services/managed-config.js";
import { isValidLocalEncryptedMasterKey } from "./secrets/local-encrypted-provider.js";
import type { StorageProvider } from "@paperclipai/shared";

interface ManagedCloudPrerequisites {
  storageProvider: StorageProvider;
  /** The canonical DB/config value or explicit env/file value, before defaults. */
  storageS3Bucket: string | undefined;
  storageS3Region: string;
  storageS3Endpoint: string | undefined;
  databaseUrl: string | undefined;
}

/** Pure startup policy for the existing managed-cloud profile. No I/O or probes. */
export function validateManagedCloudPrerequisites(
  config: ManagedCloudPrerequisites,
  env: ManagedConfigEnv,
): void {
  validateManagedCloudStoragePrerequisites(config, env);
  validateManagedCloudBootstrapPrerequisites(config, env);
}

/** Validate a resolved candidate before its first Cloud import or startup use. */
export function validateManagedCloudStoragePrerequisites(
  config: Pick<ManagedCloudPrerequisites, "storageProvider" | "storageS3Bucket" | "storageS3Region" | "storageS3Endpoint">,
  env: ManagedConfigEnv,
): void {
  if (!isCloudManagedInstance(env)) return;
  parseManagedConfigEnv(env);

  const refuse = (message: string): never => {
    throw new Error(`Managed cloud configuration: ${message}; refusing to start`);
  };
  // An invalid explicit env value must not fall through to a file/default value.
  if ((env.PAPERCLIP_STORAGE_PROVIDER !== undefined && env.PAPERCLIP_STORAGE_PROVIDER !== "s3")
    || config.storageProvider !== "s3") {
    refuse("set PAPERCLIP_STORAGE_PROVIDER=s3 or storage.provider=s3 in the config file");
  }
  if (!config.storageS3Bucket?.trim()) {
    refuse("set PAPERCLIP_STORAGE_S3_BUCKET or storage.s3.bucket explicitly");
  }
  if (!config.storageS3Region.trim()) {
    refuse("set a nonblank PAPERCLIP_STORAGE_S3_REGION or storage.s3.region");
  }
  if (config.storageS3Endpoint !== undefined) {
    let validEndpoint = false;
    try {
      const url = new URL(config.storageS3Endpoint);
      validEndpoint = (url.protocol === "https:" || url.protocol === "http:")
        && !!url.hostname && !url.username && !url.password;
    } catch { /* The diagnostic must not include a possibly secret URL. */ }
    if (!validEndpoint) refuse("PAPERCLIP_STORAGE_S3_ENDPOINT must be an HTTP(S) URL without credentials");
  }
}

/** Environment-owned prerequisites needed before opening the Cloud database. */
export function validateManagedCloudBootstrapPrerequisites(
  config: { databaseUrl: string | undefined }, env: ManagedConfigEnv,
): void {
  if (!isCloudManagedInstance(env)) return;
  parseManagedConfigEnv(env);
  const refuse = (message: string): never => {
    throw new Error(`Managed cloud configuration: ${message}; refusing to start`);
  };
  let validDatabase = false;
  try {
    const url = new URL(config.databaseUrl ?? "");
    validDatabase = (url.protocol === "postgres:" || url.protocol === "postgresql:") && !!url.hostname;
  } catch { /* The diagnostic must not include database credentials. */ }
  if (!validDatabase) {
    refuse("set DATABASE_URL to an external PostgreSQL URL");
  }
  if (!isValidLocalEncryptedMasterKey(env.PAPERCLIP_SECRETS_MASTER_KEY ?? "")) {
    refuse("set a stable PAPERCLIP_SECRETS_MASTER_KEY (32-byte base64, 64-char hex, or raw 32-char string); key files alone are not supported");
  }
}
