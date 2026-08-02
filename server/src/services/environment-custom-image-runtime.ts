import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { environmentCustomImageTemplates } from "@paperclipai/db";
import {
  ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_KINDS,
  type EnvironmentCustomImageTemplate,
  type EnvironmentCustomImageTemplateKind,
  type SandboxEnvironmentConfig,
} from "@paperclipai/shared";
import { readConfigValueAtPath, writeConfigValueAtPath } from "./json-schema-secret-refs.js";

type TemplateRow = typeof environmentCustomImageTemplates.$inferSelect;

export const ENVIRONMENT_CUSTOM_IMAGE_RUNTIME_CONFIG_BINDING_METADATA_KEY = "runtimeConfigBinding";
export const ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS = [
  "timeoutMs",
  "reuseLease",
  "streamRunLogs",
  "archiveOnRelease",
  "cpu",
  "memory",
  "disk",
  "gpu",
  "autoStopInterval",
  "autoArchiveInterval",
  "autoDeleteInterval",
];

export interface EnvironmentCustomImageRuntimeConfigBinding {
  field: string;
  unsetFields: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function readEnvironmentCustomImageTemplateKind(
  value: string | null,
): EnvironmentCustomImageTemplateKind {
  return (ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_KINDS as readonly string[]).includes(value ?? "")
    ? value as EnvironmentCustomImageTemplateKind
    : "unknown";
}

export function defaultEnvironmentCustomImageRuntimeConfigBinding(
  templateKind: string | null | undefined,
): EnvironmentCustomImageRuntimeConfigBinding {
  const kind = readEnvironmentCustomImageTemplateKind(templateKind ?? null);
  if (kind === "snapshot") return { field: "snapshot", unsetFields: ["image"] };
  if (kind === "image") return { field: "image", unsetFields: ["snapshot"] };
  if (kind === "provider_template") return { field: "template", unsetFields: [] };
  return { field: "templateRef", unsetFields: [] };
}

function isValidRuntimeConfigBindingField(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value)
    && value !== "provider";
}

export function normalizeEnvironmentCustomImageRuntimeConfigBinding(
  value: unknown,
): EnvironmentCustomImageRuntimeConfigBinding | null {
  if (!isRecord(value) || !isValidRuntimeConfigBindingField(value.field)) return null;
  const unsetFields = Array.isArray(value.unsetFields)
    ? value.unsetFields.filter((field): field is string =>
        isValidRuntimeConfigBindingField(field) && field !== value.field,
      )
    : [];
  return {
    field: value.field,
    unsetFields: Array.from(new Set(unsetFields)),
  };
}

export function resolveEnvironmentCustomImageRuntimeConfigBinding(input: {
  templateKind: string | null | undefined;
  metadata?: Record<string, unknown> | null;
}): EnvironmentCustomImageRuntimeConfigBinding {
  return normalizeEnvironmentCustomImageRuntimeConfigBinding(
    input.metadata?.[ENVIRONMENT_CUSTOM_IMAGE_RUNTIME_CONFIG_BINDING_METADATA_KEY],
  ) ?? defaultEnvironmentCustomImageRuntimeConfigBinding(input.templateKind);
}

export function fingerprintEnvironmentSandboxProviderConfig(
  config: SandboxEnvironmentConfig,
  options?: { excludePaths?: Iterable<string> },
): string {
  let normalized = config as Record<string, unknown>;
  for (const path of options?.excludePaths ?? []) {
    normalized = writeConfigValueAtPath(normalized, path, undefined);
  }
  return createHash("sha256")
    .update(stableStringify(normalized))
    .digest("hex");
}

export function applyCustomImageTemplateToSandboxConfig(
  config: SandboxEnvironmentConfig,
  template: Pick<EnvironmentCustomImageTemplate, "templateKind" | "templateRef" | "metadata">,
): SandboxEnvironmentConfig {
  if (!template.templateRef) return config;
  const next = { ...(config as Record<string, unknown>) };
  const binding = resolveEnvironmentCustomImageRuntimeConfigBinding({
    templateKind: template.templateKind,
    metadata: template.metadata,
  });
  for (const field of binding.unsetFields) {
    delete next[field];
  }
  next[binding.field] = template.templateRef;
  return next as SandboxEnvironmentConfig;
}

export function environmentCustomImageTemplateMatchesBaseConfig(input: {
  template: EnvironmentCustomImageTemplate;
  baseConfig: SandboxEnvironmentConfig;
  secretRefExcludePaths?: Iterable<string>;
}): boolean {
  const expectedFingerprint = input.template.sourceEnvironmentConfigFingerprint;
  if (!expectedFingerprint) return true;
  // Capture-time fingerprints exclude both runtime-only fields and the
  // provider's secret-ref paths (see finishSetupSession); the runtime match
  // must exclude the same set or configs that carry a secret ref can never
  // match and the active template gets silently dropped.
  const secretRefExcludePaths = [...(input.secretRefExcludePaths ?? [])];
  const normalizedFingerprint = fingerprintEnvironmentSandboxProviderConfig(input.baseConfig, {
    excludePaths: [
      ...ENVIRONMENT_CUSTOM_IMAGE_CONFIG_FINGERPRINT_EXCLUDED_PATHS,
      ...secretRefExcludePaths,
    ],
  });
  if (normalizedFingerprint === expectedFingerprint) return true;
  // Backward compatibility for templates captured before runtime-only fields
  // were excluded from the source fingerprint (secret-ref paths have always
  // been excluded at capture time).
  return fingerprintEnvironmentSandboxProviderConfig(input.baseConfig, {
    excludePaths: secretRefExcludePaths,
  }) === expectedFingerprint;
}

// Standard boot-source fields shared across sandbox providers. A change to any
// of these means the user asked for a different base, so a captured template
// no longer reflects the saved config and cannot simply be re-linked.
export const ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_SOURCE_FIELDS = [
  "snapshot",
  "image",
  "template",
] as const;

export type EnvironmentCustomImageConfigChangeKind = "none" | "relinkable" | "breaking";

/**
 * Classifies a saved-config change relative to an active captured template.
 *
 * - `none`: the template either already matched the new config, or was already
 *   detached before this change; nothing to reconcile.
 * - `relinkable`: only fields that cannot affect the captured template's
 *   contents or reachability changed (for example a region hint), so the
 *   template's source fingerprint can be re-stamped to the new config.
 * - `breaking`: a boot-source field or a provider-declared template identity
 *   path changed; the captured template no longer corresponds to the config
 *   and a fresh capture is required.
 */
export function classifyEnvironmentCustomImageConfigChange(input: {
  template: EnvironmentCustomImageTemplate;
  previousConfig: SandboxEnvironmentConfig;
  nextConfig: SandboxEnvironmentConfig;
  secretRefExcludePaths?: Iterable<string>;
  templateIdentityPaths?: Iterable<string>;
}): EnvironmentCustomImageConfigChangeKind {
  const secretRefExcludePaths = [...(input.secretRefExcludePaths ?? [])];
  if (!environmentCustomImageTemplateMatchesBaseConfig({
    template: input.template,
    baseConfig: input.previousConfig,
    secretRefExcludePaths,
  })) {
    return "none";
  }
  if (environmentCustomImageTemplateMatchesBaseConfig({
    template: input.template,
    baseConfig: input.nextConfig,
    secretRefExcludePaths,
  })) {
    return "none";
  }
  const binding = resolveEnvironmentCustomImageRuntimeConfigBinding({
    templateKind: input.template.templateKind,
    metadata: input.template.metadata,
  });
  const breakingPaths = new Set<string>([
    "provider",
    binding.field,
    ...binding.unsetFields,
    ...ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_SOURCE_FIELDS,
    ...(input.templateIdentityPaths ?? []),
  ]);
  const previous = input.previousConfig as Record<string, unknown>;
  const next = input.nextConfig as Record<string, unknown>;
  for (const path of breakingPaths) {
    const before = readConfigValueAtPath(previous, path);
    const after = readConfigValueAtPath(next, path);
    if (stableStringify(before ?? null) !== stableStringify(after ?? null)) {
      return "breaking";
    }
  }
  return "relinkable";
}

export function environmentCustomImageTemplateFromRow(row: TemplateRow): EnvironmentCustomImageTemplate {
  return {
    id: row.id,
    environmentId: row.environmentId,
    provider: row.provider,
    templateKind: readEnvironmentCustomImageTemplateKind(row.templateKind),
    templateRef: row.templateRef,
    sourceTemplateRef: row.sourceTemplateRef ?? null,
    sourceEnvironmentConfigFingerprint: row.sourceEnvironmentConfigFingerprint ?? null,
    status: row.status,
    createdByUserId: row.createdByUserId ?? null,
    createdByAgentId: row.createdByAgentId ?? null,
    capturedAt: row.capturedAt ?? null,
    lastUsedAt: row.lastUsedAt ?? null,
    supersededByTemplateId: row.supersededByTemplateId ?? null,
    metadata: row.metadata ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function resolveActiveEnvironmentCustomImageTemplateForRuntime(
  db: Db,
  input: {
    environmentId: string;
    baseConfig: SandboxEnvironmentConfig;
    runtimeConfig: SandboxEnvironmentConfig;
    secretRefExcludePaths?: Iterable<string>;
    now?: Date;
  },
): Promise<SandboxEnvironmentConfig> {
  const row = await db
    .select()
    .from(environmentCustomImageTemplates)
    .where(and(
      eq(environmentCustomImageTemplates.environmentId, input.environmentId),
      eq(environmentCustomImageTemplates.provider, input.baseConfig.provider),
      eq(environmentCustomImageTemplates.status, "active"),
    ))
    .orderBy(desc(environmentCustomImageTemplates.capturedAt), desc(environmentCustomImageTemplates.createdAt))
    .then((rows) => rows[0] ?? null);
  if (!row) return input.runtimeConfig;

  const active = environmentCustomImageTemplateFromRow(row);
  if (!active.templateRef) return input.runtimeConfig;
  if (!environmentCustomImageTemplateMatchesBaseConfig({
    template: active,
    baseConfig: input.baseConfig,
    secretRefExcludePaths: input.secretRefExcludePaths,
  })) {
    return input.runtimeConfig;
  }

  // An active template is an explicit, environment+provider-scoped artifact: the
  // captured snapshot/image fully replaces the base image at create time, so it is
  // applied whenever the image/template-defining parts of the base config still
  // match. Runtime-only knobs such as lease reuse, timeouts, and resource hints
  // are excluded from the fingerprint so those edits do not discard the capture.
  const now = input.now ?? new Date();
  await db
    .update(environmentCustomImageTemplates)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(environmentCustomImageTemplates.id, active.id));
  return applyCustomImageTemplateToSandboxConfig(input.runtimeConfig, active);
}
