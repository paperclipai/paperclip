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
import { writeConfigValueAtPath } from "./json-schema-secret-refs.js";

type TemplateRow = typeof environmentCustomImageTemplates.$inferSelect;

export const ENVIRONMENT_CUSTOM_IMAGE_RUNTIME_CONFIG_BINDING_METADATA_KEY = "runtimeConfigBinding";

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

  // An active template is an explicit, environment+provider-scoped artifact: the
  // captured snapshot/image fully replaces the base image at create time, so it is
  // applied whenever present. We deliberately do not gate on a base-config
  // fingerprint — the config dialog re-saves the environment right after capture,
  // and ordinary resource/lifecycle tweaks (cpu/memory/lease knobs that don't
  // affect image identity and are dropped for snapshot creation) would otherwise
  // silently discard the captured setup state and provider metadata. Re-running
  // setup supersedes the template when the user wants a fresh capture.
  const now = input.now ?? new Date();
  await db
    .update(environmentCustomImageTemplates)
    .set({ lastUsedAt: now, updatedAt: now })
    .where(eq(environmentCustomImageTemplates.id, active.id));
  return applyCustomImageTemplateToSandboxConfig(input.runtimeConfig, active);
}
