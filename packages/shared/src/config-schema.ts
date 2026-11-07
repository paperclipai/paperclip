import { z } from "zod";
import {
  AUTH_BASE_URL_MODES,
  BIND_MODES,
  DEPLOYMENT_EXPOSURES,
  DEPLOYMENT_MODES,
  SECRET_PROVIDERS,
  STORAGE_PROVIDERS,
} from "./constants.js";
import { validateConfiguredBindMode } from "./network-bind.js";

export const configMetaSchema = z.object({
  version: z.literal(1),
  updatedAt: z.string(),
  source: z.enum(["onboard", "configure", "doctor"]),
}).passthrough();

export const llmConfigSchema = z.object({
  provider: z.enum(["claude", "openai"]),
  apiKey: z.string().optional(),
}).passthrough();

export const databaseBackupConfigSchema = z.object({
  enabled: z.boolean().default(true),
  intervalMinutes: z.number().int().min(1).max(7 * 24 * 60).default(60),
  retentionDays: z.number().int().min(1).max(3650).default(7),
  dir: z.string().default("~/.paperclip/instances/default/data/backups"),
}).passthrough();

export const databaseConfigSchema = z.object({
  mode: z.enum(["embedded-postgres", "postgres"]).default("embedded-postgres"),
  connectionString: z.string().optional(),
  embeddedPostgresDataDir: z.string().default("~/.paperclip/instances/default/db"),
  embeddedPostgresPort: z.number().int().min(1).max(65535).default(54329),
  backup: databaseBackupConfigSchema.default({
    enabled: true,
    intervalMinutes: 60,
    retentionDays: 7,
    dir: "~/.paperclip/instances/default/data/backups",
  }),
}).passthrough();

export const loggingConfigSchema = z.object({
  mode: z.enum(["file", "cloud"]),
  logDir: z.string().default("~/.paperclip/instances/default/logs"),
}).passthrough();

export const serverConfigSchema = z.object({
  deploymentMode: z.enum(DEPLOYMENT_MODES).default("local_trusted"),
  exposure: z.enum(DEPLOYMENT_EXPOSURES).default("private"),
  bind: z.enum(BIND_MODES).optional(),
  customBindHost: z.string().optional(),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(3100),
  allowedHostnames: z.array(z.string().min(1)).default([]),
  serveUi: z.boolean().default(true),
}).passthrough();

export const authConfigSchema = z.object({
  baseUrlMode: z.enum(AUTH_BASE_URL_MODES).default("auto"),
  publicBaseUrl: z.string().url().optional(),
  disableSignUp: z.boolean().default(false),
}).passthrough();

export const storageLocalDiskConfigSchema = z.object({
  baseDir: z.string().default("~/.paperclip/instances/default/data/storage"),
}).passthrough();

export const storageS3ConfigSchema = z.object({
  bucket: z.string().min(1).default("paperclip"),
  region: z.string().min(1).default("us-east-1"),
  endpoint: z.string().optional(),
  prefix: z.string().default(""),
  forcePathStyle: z.boolean().default(false),
}).passthrough();

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
}).passthrough();

export const secretsLocalEncryptedConfigSchema = z.object({
  keyFilePath: z.string().default("~/.paperclip/instances/default/secrets/master.key"),
}).passthrough();

export const secretsConfigSchema = z.object({
  provider: z.enum(SECRET_PROVIDERS).default("local_encrypted"),
  strictMode: z.boolean().default(false),
  localEncrypted: secretsLocalEncryptedConfigSchema.default({
    keyFilePath: "~/.paperclip/instances/default/secrets/master.key",
  }),
}).passthrough();

export const telemetryConfigSchema = z.object({
  enabled: z.boolean().default(true),
}).passthrough().prefault({});

export const updatesConfigSchema = z.object({
  checkEnabled: z.boolean().default(true),
}).passthrough().prefault({});

export const paperclipConfigSchema = z
  .object({
    $meta: configMetaSchema,
    llm: llmConfigSchema.optional(),
    database: databaseConfigSchema,
    logging: loggingConfigSchema,
    server: serverConfigSchema,
    telemetry: telemetryConfigSchema,
    updates: updatesConfigSchema.optional(),
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
  .passthrough()
  .superRefine((value, ctx) => {
    if (value.server.deploymentMode === "local_trusted" && value.server.exposure !== "private") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "server.exposure must be private when deploymentMode is local_trusted",
        path: ["server", "exposure"],
      });
    }

    for (const message of validateConfiguredBindMode({
      deploymentMode: value.server.deploymentMode,
      deploymentExposure: value.server.exposure,
      bind: value.server.bind,
      host: value.server.host,
      customBindHost: value.server.customBindHost,
    })) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message,
        path: message.includes("customBindHost") ? ["server", "customBindHost"] : ["server", "bind"],
      });
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
export type UpdatesConfig = z.infer<typeof updatesConfigSchema>;
export type ConfigMeta = z.infer<typeof configMetaSchema>;
export type DatabaseBackupConfig = z.infer<typeof databaseBackupConfigSchema>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapConfigSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  let current: z.ZodTypeAny = schema;
  while (true) {
    if (current instanceof z.ZodOptional) {
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    if (current instanceof z.ZodDefault) {
      current = current.unwrap() as z.ZodTypeAny;
      continue;
    }
    return current;
  }
}

function mergeUnknownConfigKeys(
  source: Record<string, unknown>,
  update: Record<string, unknown>,
  schema: z.ZodTypeAny,
): Record<string, unknown> {
  const objectSchema = unwrapConfigSchema(schema);
  if (!(objectSchema instanceof z.ZodObject)) return { ...update };

  const shape = objectSchema.shape as Record<string, z.ZodTypeAny>;
  const merged = { ...update };

  for (const [key, sourceValue] of Object.entries(source)) {
    const childSchema = shape[key];
    if (childSchema === undefined) {
      merged[key] = sourceValue;
      continue;
    }

    const updateValue = update[key];
    if (isRecord(sourceValue) && isRecord(updateValue)) {
      merged[key] = mergeUnknownConfigKeys(sourceValue, updateValue, childSchema);
    }
  }

  return merged;
}

/**
 * Applies a config update while retaining extension keys from the parsed source.
 * Known optional keys that are absent from the update stay absent, so callers can
 * intentionally clear values such as llm.apiKey or auth.publicBaseUrl.
 */
export function mergePaperclipConfig(
  source: PaperclipConfig,
  update: PaperclipConfig,
): PaperclipConfig {
  return mergeUnknownConfigKeys(
    source as Record<string, unknown>,
    update as Record<string, unknown>,
    paperclipConfigSchema,
  ) as PaperclipConfig;
}

export type ConfigKeyWarning = {
  path: string;
  suggestion: string;
};

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const substitutionCost = left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1;
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + substitutionCost,
      );
    }
    previous.splice(0, previous.length, ...current);
  }

  return previous[right.length];
}

function nearMatch(key: string, candidates: string[]): string | null {
  const normalizedKey = key.toLowerCase();
  let best: { candidate: string; distance: number } | null = null;

  for (const candidate of candidates) {
    const normalizedCandidate = candidate.toLowerCase();
    if (normalizedKey === normalizedCandidate && key !== candidate) return candidate;

    const distance = editDistance(normalizedKey, normalizedCandidate);
    const threshold = Math.max(normalizedKey.length, normalizedCandidate.length) >= 8 ? 2 : 1;
    if (distance > threshold || (best && distance >= best.distance)) continue;
    best = { candidate, distance };
  }

  return best?.candidate ?? null;
}

function collectConfigKeyWarnings(
  value: Record<string, unknown>,
  schema: z.ZodTypeAny,
  prefix: string,
  warnings: ConfigKeyWarning[],
): void {
  const objectSchema = unwrapConfigSchema(schema);
  if (!(objectSchema instanceof z.ZodObject)) return;

  const shape = objectSchema.shape as Record<string, z.ZodTypeAny>;
  const knownKeys = Object.keys(shape);

  for (const [key, childValue] of Object.entries(value)) {
    const childSchema = shape[key];
    const childPath = prefix ? `${prefix}.${key}` : key;
    if (childSchema === undefined) {
      const suggestion = nearMatch(key, knownKeys);
      if (suggestion) {
        warnings.push({
          path: childPath,
          suggestion: prefix ? `${prefix}.${suggestion}` : suggestion,
        });
      }
      continue;
    }

    if (isRecord(childValue)) {
      collectConfigKeyWarnings(childValue, childSchema, childPath, warnings);
    }
  }
}

/** Returns likely misspellings among retained extension keys without modifying them. */
export function findPaperclipConfigKeyWarnings(config: unknown): ConfigKeyWarning[] {
  if (!isRecord(config)) return [];
  const warnings: ConfigKeyWarning[] = [];
  collectConfigKeyWarnings(config, paperclipConfigSchema, "", warnings);
  return warnings;
}
