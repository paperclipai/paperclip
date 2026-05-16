import { z } from "zod";
import {
  SECRET_BINDING_TARGET_TYPES,
  SECRET_MANAGED_MODES,
  SECRET_PROVIDER_CONFIG_STATUSES,
  SECRET_PROVIDERS,
  SECRET_STATUSES,
} from "../constants.js";

export const envBindingPlainSchema = z.object({
  type: z.literal("plain"),
  value: z.string(),
});

export const envBindingSecretRefSchema = z.object({
  type: z.literal("secret_ref"),
  secretId: z.string().uuid(),
  version: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
});

// Backward-compatible union that accepts legacy inline values.
export const envBindingSchema = z.union([
  z.string(),
  envBindingPlainSchema,
  envBindingSecretRefSchema,
]);

export const envConfigSchema = z.record(envBindingSchema);

export const createSecretSchema = z.object({
  name: z.string().min(1),
  key: z.string().min(1).regex(/^[a-zA-Z0-9_.-]+$/).optional(),
  provider: z.enum(SECRET_PROVIDERS).optional(),
  providerConfigId: z.string().uuid().optional().nullable(),
  managedMode: z.enum(SECRET_MANAGED_MODES).optional(),
  value: z.string().min(1).optional().nullable(),
  description: z.string().optional().nullable(),
  externalRef: z.string().optional().nullable(),
  providerMetadata: z.record(z.unknown()).optional().nullable(),
  providerVersionRef: z.string().optional().nullable(),
}).superRefine((value, ctx) => {
  if ((value.managedMode ?? "paperclip_managed") === "external_reference") {
    if (!value.externalRef?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["externalRef"],
        message: "External reference secrets require externalRef",
      });
    }
    return;
  }
  if (value.externalRef?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["externalRef"],
      message: "Managed secrets cannot set externalRef",
    });
  }
  if (!value.value?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["value"],
      message: "Managed secrets require value",
    });
  }
});

export type CreateSecret = z.infer<typeof createSecretSchema>;

export const rotateSecretSchema = z.object({
  value: z.string().min(1).optional().nullable(),
  externalRef: z.string().optional().nullable(),
  providerVersionRef: z.string().optional().nullable(),
  providerConfigId: z.string().uuid().optional().nullable(),
});

export type RotateSecret = z.infer<typeof rotateSecretSchema>;

export const updateSecretSchema = z.object({
  name: z.string().min(1).optional(),
  key: z.string().min(1).regex(/^[a-zA-Z0-9_.-]+$/).optional(),
  status: z.enum(SECRET_STATUSES).optional(),
  providerConfigId: z.string().uuid().optional().nullable(),
  description: z.string().optional().nullable(),
  externalRef: z.string().optional().nullable(),
  providerMetadata: z.record(z.unknown()).optional().nullable(),
});

export type UpdateSecret = z.infer<typeof updateSecretSchema>;

export const secretBindingTargetSchema = z.object({
  targetType: z.enum(SECRET_BINDING_TARGET_TYPES),
  targetId: z.string().min(1),
  configPath: z.string().min(1),
});

export const createSecretBindingSchema = secretBindingTargetSchema.extend({
  secretId: z.string().uuid(),
  versionSelector: z.union([z.literal("latest"), z.number().int().positive()]).default("latest"),
  required: z.boolean().default(true),
  label: z.string().optional().nullable(),
});

export type CreateSecretBinding = z.infer<typeof createSecretBindingSchema>;

const safeShortText = z.string().trim().min(1).max(160);
const optionalSafeShortText = safeShortText.optional().nullable();

const deniedProviderConfigKeyPattern =
  /^(access[-_]?key([-_]?id)?|secret[-_]?access[-_]?key|secret[-_]?key|token|password|passwd|credential|credentials|private[-_]?key|pem|jwt|session[-_]?token|service[-_]?account([-_]?json)?|client[-_]?secret|secret[-_]?id|unseal[-_]?key|recovery[-_]?key|key[-_]?file([-_]?path)?|token[-_]?file([-_]?path)?)$/i;

function rejectSensitiveProviderConfigKeys(value: unknown, ctx: z.RefinementCtx) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!deniedProviderConfigKeyPattern.test(key)) continue;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["config", key],
      message: `Provider vault config cannot persist sensitive field: ${key}`,
    });
  }
}

export const localEncryptedProviderConfigSchema = z.object({
  backupReminderAcknowledged: z.boolean().optional(),
}).strict();

export const awsSecretsManagerProviderConfigSchema = z.object({
  region: z.string().trim().regex(/^[a-z]{2}(?:-gov)?-[a-z]+-\d+$/, "Invalid AWS region"),
  namespace: optionalSafeShortText,
  secretNamePrefix: optionalSafeShortText,
  kmsKeyId: z.string().trim().min(1).max(512).optional().nullable(),
  ownerTag: optionalSafeShortText,
  environmentTag: optionalSafeShortText,
}).strict();

export const gcpSecretManagerProviderConfigSchema = z.object({
  projectId: z.string().trim().min(1).max(128).regex(/^[a-z][a-z0-9-]{4,127}$/).optional().nullable(),
  location: optionalSafeShortText,
  namespace: optionalSafeShortText,
  secretNamePrefix: optionalSafeShortText,
}).strict();

const vaultAddressSchema = z.preprocess(
  (value) => typeof value === "string" ? value.trim() : value,
  z.string().url().superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return;
    }
    const hasPath = url.pathname !== "" && url.pathname !== "/";
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      hasPath
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Vault address must be an origin-only HTTP(S) URL without credentials, path, query, or fragment",
      });
    }
  }).transform((value) => new URL(value).origin),
);

function rejectUnsafeVaultAddress(value: unknown, ctx: z.RefinementCtx) {
  if (value === undefined || value === null) return;
  const parsed = vaultAddressSchema.safeParse(value);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    ctx.addIssue({
      ...issue,
      path: ["config", "address", ...issue.path],
    });
  }
}

export const vaultProviderConfigSchema = z.object({
  address: vaultAddressSchema.optional().nullable(),
  namespace: optionalSafeShortText,
  mountPath: optionalSafeShortText,
  secretPathPrefix: optionalSafeShortText,
}).strict();

export const secretProviderConfigPayloadSchema = z.discriminatedUnion("provider", [
  z.object({ provider: z.literal("local_encrypted"), config: localEncryptedProviderConfigSchema }),
  z.object({ provider: z.literal("aws_secrets_manager"), config: awsSecretsManagerProviderConfigSchema }),
  z.object({ provider: z.literal("gcp_secret_manager"), config: gcpSecretManagerProviderConfigSchema }),
  z.object({ provider: z.literal("vault"), config: vaultProviderConfigSchema }),
]);

export const createSecretProviderConfigSchema = z.object({
  provider: z.enum(SECRET_PROVIDERS),
  displayName: z.string().trim().min(1).max(120),
  status: z.enum(SECRET_PROVIDER_CONFIG_STATUSES).optional(),
  isDefault: z.boolean().optional(),
  config: z.record(z.unknown()).default({}),
}).superRefine((value, ctx) => {
  rejectSensitiveProviderConfigKeys(value.config, ctx);
  const parsed = secretProviderConfigPayloadSchema.safeParse({
    provider: value.provider,
    config: value.config,
  });
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        ...issue,
        path: issue.path[0] === "config" ? issue.path : ["config", ...issue.path],
      });
    }
  }
  const status = value.status ?? (["gcp_secret_manager", "vault"].includes(value.provider) ? "coming_soon" : "ready");
  if ((value.provider === "gcp_secret_manager" || value.provider === "vault") && status !== "coming_soon" && status !== "disabled") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["status"],
      message: `${value.provider} provider vaults are locked while coming soon`,
    });
  }
  if ((status === "coming_soon" || status === "disabled") && value.isDefault) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["isDefault"],
      message: "Only ready or warning provider vaults can be default",
    });
  }
});

export type CreateSecretProviderConfig = z.infer<typeof createSecretProviderConfigSchema>;

export const updateSecretProviderConfigSchema = z.object({
  displayName: z.string().trim().min(1).max(120).optional(),
  status: z.enum(SECRET_PROVIDER_CONFIG_STATUSES).optional(),
  isDefault: z.boolean().optional(),
  config: z.record(z.unknown()).optional(),
}).superRefine((value, ctx) => {
  if (value.config !== undefined) {
    rejectSensitiveProviderConfigKeys(value.config, ctx);
    rejectUnsafeVaultAddress(value.config.address, ctx);
  }
  if ((value.status === "coming_soon" || value.status === "disabled") && value.isDefault) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["isDefault"],
      message: "Only ready or warning provider vaults can be default",
    });
  }
});

export type UpdateSecretProviderConfig = z.infer<typeof updateSecretProviderConfigSchema>;

export const remoteSecretImportPreviewSchema = z.object({
  providerConfigId: z.string().uuid(),
  query: z.string().trim().max(200).optional().nullable(),
  nextToken: z.string().trim().min(1).max(4096).optional().nullable(),
  pageSize: z.number().int().min(1).max(100).optional(),
});

export type RemoteSecretImportPreview = z.infer<typeof remoteSecretImportPreviewSchema>;

export const remoteSecretImportSelectionSchema = z.object({
  externalRef: z.string().trim().min(1).max(2048),
  name: z.string().trim().min(1).max(160).optional().nullable(),
  key: z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_.-]+$/).optional().nullable(),
  description: z.string().trim().max(500).optional().nullable(),
  providerVersionRef: z.string().trim().min(1).max(512).optional().nullable(),
  providerMetadata: z.record(z.unknown()).optional().nullable(),
});

export const remoteSecretImportSchema = z.object({
  providerConfigId: z.string().uuid(),
  secrets: z.array(remoteSecretImportSelectionSchema).min(1).max(100),
});

export type RemoteSecretImportSelection = z.infer<typeof remoteSecretImportSelectionSchema>;
export type RemoteSecretImport = z.infer<typeof remoteSecretImportSchema>;
