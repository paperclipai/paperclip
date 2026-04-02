import { z } from "zod";
import {
  AUTH_BASE_URL_MODES,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
} from "./constants.js";

export const configMetaSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  source: z.enum(["onboard", "configure", "doctor"]),
});

export const llmConfigSchema = z.object({
  provider: z.enum(["claude", "openai"]),
  apiKey: z.string().optional(),
});

export const databaseBackupConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().int().min(1).max(7 * 24 * 60).default(60),
  retentionDays: z.number().int().min(1).max(3650).default(30),
  dir: z.string().default("~/.paperclip/instances/default/data/backups"),
});

export const databaseConfigSchema = z.object({
  mode: z.enum(["embedded-postgres", "postgres"]).default("embedded-postgres"),
  connectionString: z.string().optional(),
  embeddedPostgresDataDir: z.string().default("~/.paperclip/instances/default/db"),
  embeddedPostgresPort: z.number().int().min(1).max(65535).default(54329),
  backup: databaseBackupConfigSchema.default({
    enabled: true,
    intervalMinutes: 60,
    retentionDays: 30,
    dir: "~/.paperclip/instances/default/data/backups",
  }),
});

export const loggingConfigSchema = z.object({
  mode: z.enum(["file", "cloud"]),
  logDir: z.string().default("~/.paperclip/instances/default/logs"),
});

export const serverConfigSchema = z.object({
  deploymentMode: z.enum(DEPLOYMENT_MODES).default("local_trusted"),
  exposure: z.enum(DEPLOYMENT_EXPOSURES).default("private"),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(3100),
  allowedHostnames: z.array(z.string().min(1)).default([]),
  serveUi: z.boolean().default(true),
});

export const authConfigSchema = z.object({
  baseUrlMode: z.enum(AUTH_BASE_URL_MODES).default("auto"),
  publicBaseUrl: z.string().url().optional(),
  disableSignUp: z.boolean().default(false),
});

export const storageLocalDiskConfigSchema = z.object({
  baseDir: z.string().default("~/.paperclip/instances/default/data/storage"),
});

export const storageS3ConfigSchema = z.object({
  bucket: z.string().min(1).default("paperclip"),
  region: z.string().min(1).default("us-east-1"),
  endpoint: z.string().optional(),
  prefix: z.string().default(""),
  forcePathStyle: z.boolean().default(false),
});

export const storageConfigSchema = z.object({
  provider: z.enum(STORAGE_PROVIDERS).default("local_disk"),
  localDisk: storageLocalDiskConfigSchema.default({
    baseDir: "~/.paperclip/instances/default/data/storage",
  }),
  s3: storageS3ConfigSchema.default({
    bucket: "paperclip",
    region: "us-east-1",
    prefix: "",
    forcePathStyle: false,
  }),
});

export const secretsLocalEncryptedConfigSchema = z.object({
  keyFilePath: z.string().default("~/.paperclip/instances/default/secrets/master.key"),
});

export const secretsConfigSchema = z.object({
  provider: z.enum(SECRET_PROVIDERS).default("local_encrypted"),
  strictMode: z.boolean().default(false),
  localEncrypted: secretsLocalEncryptedConfigSchema.default({
    keyFilePath: "~/.paperclip/instances/default/secrets/master.key",
  }),
});

export const telemetryConfigSchema = z.object({
  enabled: z.boolean().default(true),
}).default({});

export const paperclipConfigSchema = z
  .object({
    $meta: configMetaSchema,
    llm: llmConfigSchema.optional(),
    database: databaseConfigSchema,
    logging: loggingConfigSchema,
    server: serverConfigSchema,
    telemetry: telemetryConfigSchema,
    auth: authConfigSchema.default({
      baseUrlMode: "auto",
      disableSignUp: false,
    }),
    storage: storageConfigSchema.default({
      provider: "local_disk",
      localDisk: {
        baseDir: "~/.paperclip/instances/default/data/storage",
      },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    }),
    secrets: secretsConfigSchema.default({
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: {
        keyFilePath: "~/.paperclip/instances/default/secrets/master.key",
      },
    }),
  })
  .superRefine((value, ctx) => {
    if (value.server.deploymentMode === "local_trusted") {
      if (value.server.exposure !== "private") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "server.exposure must be private when deploymentMode is local_trusted",
          path: ["server", "exposure"],
        });
      }
      return;
    }

    if (value.auth.baseUrlMode === "explicit" && !value.auth.publicBaseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.publicBaseUrl is required when auth.baseUrlMode is explicit",
        path: ["auth", "publicBaseUrl"],
      });
    }

    if (value.server.exposure === "public" && value.auth.baseUrlMode !== "explicit") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.baseUrlMode must be explicit when deploymentMode=authenticated and exposure=public",
        path: ["auth", "baseUrlMode"],
      });
    }

    if (value.server.exposure === "public" && !value.auth.publicBaseUrl) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "auth.publicBaseUrl is required when deploymentMode=authenticated and exposure=public",
        path: ["auth", "publicBaseUrl"],
      });
    }
  });

export type PaperclipConfig = z.infer<typeof paperclipConfigSchema>;
export type LlmConfig = z.infer<typeof llmConfigSchema>;
export type DatabaseConfig = z.infer<typeof databaseConfigSchema>;
export type LoggingConfig = z.infer<typeof loggingConfigSchema>;
export type ServerConfig = z.infer<typeof serverConfigSchema>;
export type StorageConfig = z.infer<typeof storageConfigSchema>;
export type StorageLocalDiskConfig = z.infer<typeof storageLocalDiskConfigSchema>;
export type StorageS3Config = z.infer<typeof storageS3ConfigSchema>;
export type SecretsConfig = z.infer<typeof secretsConfigSchema>;
export type SecretsLocalEncryptedConfig = z.infer<typeof secretsLocalEncryptedConfigSchema>;
export type AuthConfig = z.infer<typeof authConfigSchema>;
export type TelemetryConfig = z.infer<typeof telemetryConfigSchema>;
export type ConfigMeta = z.infer<typeof configMetaSchema>;
export type DatabaseBackupConfig = z.infer<typeof databaseBackupConfigSchema>;
