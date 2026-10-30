import {
  authConfigSchema,
  databaseBackupConfigSchema,
  llmConfigSchema,
  loggingConfigSchema,
  paperclipConfigSchema,
  secretsConfigSchema,
  secretsLocalEncryptedConfigSchema,
  serverConfigSchema,
  storageConfigSchema,
  storageLocalDiskConfigSchema,
  storageS3ConfigSchema,
  type PaperclipConfig,
} from "@paperclipai/shared";
import { z } from "zod";

const publicUrl = z.string().url().refine((value) => {
  const url = new URL(value);
  return !url.username && !url.password && !url.search && !url.hash;
});

export const cloudRuntimeConfigSchema = z.object({
  server: serverConfigSchema.strict(),
  auth: authConfigSchema.extend({ publicBaseUrl: publicUrl.optional() }).strict(),
  backup: databaseBackupConfigSchema.strict(),
  storage: storageConfigSchema.extend({
    localDisk: storageLocalDiskConfigSchema.strict(),
    s3: storageS3ConfigSchema.extend({ endpoint: publicUrl.optional() }).strict(),
  }).strict(),
  secrets: secretsConfigSchema.extend({
    localEncrypted: secretsLocalEncryptedConfigSchema.strict(),
  }).strict(),
  telemetry: z.object({ enabled: z.boolean() }).strict(),
  logging: loggingConfigSchema.strict(),
  updates: z.object({ checkEnabled: z.boolean() }).strict().optional(),
  llm: llmConfigSchema.omit({ apiKey: true }).strict().optional(),
}).strict();

export type CloudRuntimeConfig = z.infer<typeof cloudRuntimeConfigSchema>;
export type StoredCloudRuntimeConfig = { version: 1; revision: number; config: CloudRuntimeConfig | null };

const storedSchema = z.object({
  version: z.literal(1),
  revision: z.number().int().nonnegative(),
  config: cloudRuntimeConfigSchema.nullable(),
}).strict();

export function parseStoredCloudRuntimeConfig(value: unknown): StoredCloudRuntimeConfig {
  const parsed = storedSchema.safeParse(value);
  if (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data), "utf8") > 65_536) {
    throw new Error("Persisted Cloud runtime configuration is invalid");
  }
  const full = parsed.data.config === null ? { success: true } : paperclipConfigSchema.safeParse(toPaperclipConfig(parsed.data.config));
  if (!full.success) throw new Error("Persisted Cloud runtime configuration is invalid");
  return parsed.data;
}

export function toPaperclipConfig(config: CloudRuntimeConfig | null): PaperclipConfig | null {
  if (config === null) return null;
  const { backup, ...settings } = structuredClone(config);
  return {
    $meta: { version: 1, updatedAt: "1970-01-01T00:00:00.000Z", source: "configure" },
    database: {
      mode: "postgres",
      embeddedPostgresDataDir: "",
      embeddedPostgresPort: 54329,
      backup,
    },
    ...settings,
  };
}

export function projectCloudRuntimeConfig(source: PaperclipConfig): CloudRuntimeConfig {
  const raw = {
    server: {
      deploymentMode: source.server.deploymentMode,
      exposure: source.server.exposure,
      bind: source.server.bind,
      customBindHost: source.server.customBindHost,
      host: source.server.host,
      port: source.server.port,
      allowedHostnames: source.server.allowedHostnames,
      serveUi: source.server.serveUi,
    },
    auth: {
      baseUrlMode: source.auth.baseUrlMode,
      publicBaseUrl: source.auth.publicBaseUrl,
      disableSignUp: source.auth.disableSignUp,
    },
    backup: {
      enabled: source.database.backup.enabled,
      intervalMinutes: source.database.backup.intervalMinutes,
      retentionDays: source.database.backup.retentionDays,
      dir: source.database.backup.dir,
    },
    storage: {
      provider: source.storage.provider,
      localDisk: { baseDir: source.storage.localDisk.baseDir },
      s3: {
        bucket: source.storage.s3.bucket,
        region: source.storage.s3.region,
        endpoint: source.storage.s3.endpoint,
        prefix: source.storage.s3.prefix,
        forcePathStyle: source.storage.s3.forcePathStyle,
      },
    },
    secrets: {
      provider: source.secrets.provider,
      strictMode: source.secrets.strictMode,
      localEncrypted: { keyFilePath: source.secrets.localEncrypted.keyFilePath },
    },
    telemetry: { enabled: source.telemetry.enabled },
    logging: { mode: source.logging.mode, logDir: source.logging.logDir },
    updates: source.updates ? { checkEnabled: source.updates.checkEnabled } : undefined,
    llm: source.llm ? { provider: source.llm.provider } : undefined,
  };
  return parseStoredCloudRuntimeConfig({ version: 1, revision: 0, config: raw }).config!;
}

let snapshot: StoredCloudRuntimeConfig | null = null;

export function setCloudRuntimeConfigSnapshot(value: StoredCloudRuntimeConfig | null): void {
  snapshot = value ? parseStoredCloudRuntimeConfig(value) : null;
}

export function getCloudRuntimeConfigSnapshot(): StoredCloudRuntimeConfig {
  if (!snapshot) throw new Error("Cloud runtime configuration has not been initialized");
  return structuredClone(snapshot);
}
