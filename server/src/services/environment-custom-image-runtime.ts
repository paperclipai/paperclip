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

// --- Operator relink action (server-owned boot-source classification) --------
//
// A saved config change moves the fingerprint and detaches an otherwise-valid
// template. The relink action re-stamps the fingerprint, but only after the
// server decides the boot source did not change. To decide that without the
// capture-time config, the capture persists a small, server-owned snapshot of
// the boot-relevant fields. The relink then compares that snapshot to the
// current config. The comparison runs on the server; the client never
// classifies.

export const ENVIRONMENT_CUSTOM_IMAGE_BOOT_RELEVANT_CONFIG_METADATA_KEY = "bootRelevantConfig";
export const ENVIRONMENT_CUSTOM_IMAGE_BOOT_RELEVANT_CONFIG_VERSION = 1;
// A driver-declared identity path that fails canonicalization is never trusted
// and never persisted verbatim. It records this fixed marker instead, which
// forces the fail-closed `unclassified` result at relink time.
export const ENVIRONMENT_CUSTOM_IMAGE_BOOT_RELEVANT_UNRESOLVED_PATH = "[unresolved-identity-path]";

const BOOT_RELEVANT_CONFIG_MAX_PATH_DEPTH = 8;
const BOOT_RELEVANT_CONFIG_PATH_SEGMENT_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/;

export type EnvironmentCustomImageRelinkClassification =
  | "knob_only"
  | "boot_source_drift"
  | "unclassified";

/**
 * Server-owned snapshot of the boot-relevant config fields at capture time. It
 * carries the field values that decide the boot source, with every secret-ref
 * path and every unresolvable driver path excluded (path name only, no value).
 */
export interface EnvironmentCustomImageBootRelevantConfig {
  version: typeof ENVIRONMENT_CUSTOM_IMAGE_BOOT_RELEVANT_CONFIG_VERSION;
  provider: string;
  bindingField: string;
  values: Record<string, unknown>;
  excludedPaths: string[];
}

export interface EnvironmentCustomImageDriftedPath {
  path: string;
  from?: unknown;
  to?: unknown;
}

/**
 * Canonicalizes a config path as a bounded dot-path. Each segment must be a
 * plain identifier and the depth is bounded. An invalid, ambiguous, or
 * unresolvable path returns `null`; the caller must never persist the raw
 * driver-supplied string.
 */
export function canonicalizeEnvironmentCustomImageConfigPath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const segments = trimmed.split(".");
  if (segments.length === 0 || segments.length > BOOT_RELEVANT_CONFIG_MAX_PATH_DEPTH) return null;
  for (const segment of segments) {
    if (!BOOT_RELEVANT_CONFIG_PATH_SEGMENT_RE.test(segment)) return null;
  }
  return segments.join(".");
}

/**
 * Reports whether a candidate path overlaps any secret-ref path by exact,
 * ancestor, or descendant containment.
 */
function environmentCustomImageConfigPathOverlapsSecret(
  candidate: string,
  secretPaths: Iterable<string>,
): boolean {
  for (const raw of secretPaths) {
    const secret = canonicalizeEnvironmentCustomImageConfigPath(raw);
    if (!secret) continue;
    if (candidate === secret) return true;
    if (candidate.startsWith(`${secret}.`)) return true;
    if (secret.startsWith(`${candidate}.`)) return true;
  }
  return false;
}

/**
 * Builds the capture-time boot-relevant snapshot from the parsed config only.
 * Candidate paths are the runtime binding field, the binding unset fields, the
 * standard boot-source fields, and every driver identity path. A secret-ref
 * overlap or an unresolvable path is recorded in `excludedPaths` with no value.
 */
export function buildEnvironmentCustomImageBootRelevantConfig(input: {
  config: SandboxEnvironmentConfig;
  binding: EnvironmentCustomImageRuntimeConfigBinding;
  templateIdentityPaths?: Iterable<string>;
  secretRefExcludePaths?: Iterable<string>;
}): EnvironmentCustomImageBootRelevantConfig {
  const config = input.config as Record<string, unknown>;
  const secretPaths = [...(input.secretRefExcludePaths ?? [])];
  const values: Record<string, unknown> = {};
  const excludedPaths = new Set<string>();
  const seen = new Set<string>();

  const rawCandidatePaths = [
    input.binding.field,
    ...input.binding.unsetFields,
    ...ENVIRONMENT_CUSTOM_IMAGE_TEMPLATE_SOURCE_FIELDS,
    ...(input.templateIdentityPaths ?? []),
  ];
  for (const rawPath of rawCandidatePaths) {
    const canonical = canonicalizeEnvironmentCustomImageConfigPath(rawPath);
    if (!canonical) {
      excludedPaths.add(ENVIRONMENT_CUSTOM_IMAGE_BOOT_RELEVANT_UNRESOLVED_PATH);
      continue;
    }
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    if (environmentCustomImageConfigPathOverlapsSecret(canonical, secretPaths)) {
      excludedPaths.add(canonical);
      continue;
    }
    const value = readConfigValueAtPath(config, canonical);
    // An absent field is stored as `null` so that "absent then, absent now"
    // compares equal at relink time.
    values[canonical] = value === undefined ? null : value;
  }
  return {
    version: ENVIRONMENT_CUSTOM_IMAGE_BOOT_RELEVANT_CONFIG_VERSION,
    provider: input.config.provider,
    bindingField: input.binding.field,
    values,
    excludedPaths: [...excludedPaths],
  };
}

/**
 * Reads and validates the persisted boot-relevant snapshot. Returns `null` for
 * a legacy template with no snapshot or for a malformed shape; both classify as
 * `unclassified` (fail closed).
 */
export function readEnvironmentCustomImageBootRelevantConfig(
  metadata: Record<string, unknown> | null | undefined,
): EnvironmentCustomImageBootRelevantConfig | null {
  const raw = metadata?.[ENVIRONMENT_CUSTOM_IMAGE_BOOT_RELEVANT_CONFIG_METADATA_KEY];
  if (!isRecord(raw)) return null;
  if (raw.version !== ENVIRONMENT_CUSTOM_IMAGE_BOOT_RELEVANT_CONFIG_VERSION) return null;
  if (typeof raw.provider !== "string" || typeof raw.bindingField !== "string") return null;
  if (!isRecord(raw.values)) return null;
  if (!Array.isArray(raw.excludedPaths)) return null;
  const excludedPaths = raw.excludedPaths.filter(
    (entry): entry is string => typeof entry === "string",
  );
  return {
    version: ENVIRONMENT_CUSTOM_IMAGE_BOOT_RELEVANT_CONFIG_VERSION,
    provider: raw.provider,
    bindingField: raw.bindingField,
    values: raw.values,
    excludedPaths,
  };
}

/**
 * Classifies the drift between the capture-time boot-relevant snapshot and the
 * current parsed config.
 *
 * - `knob_only`: the snapshot is present, no path was excluded, and every value
 *   still matches. The fingerprint can be re-stamped without confirmation.
 * - `boot_source_drift`: a value-bearing path differs. The operator must
 *   confirm before the re-stamp.
 * - `unclassified`: no snapshot, an excluded path, or a provider mismatch. The
 *   server cannot verify the boot source; the operator must confirm (fail
 *   closed).
 *
 * `driftedPaths` carries raw `from`/`to` values only for value-bearing paths
 * that passed containment at capture. Excluded paths carry the path name only.
 */
export function classifyEnvironmentCustomImageBootRelevantDrift(input: {
  bootRelevantConfig: EnvironmentCustomImageBootRelevantConfig | null;
  currentConfig: SandboxEnvironmentConfig;
}): {
  classification: EnvironmentCustomImageRelinkClassification;
  driftedPaths: EnvironmentCustomImageDriftedPath[];
} {
  const boot = input.bootRelevantConfig;
  if (!boot) return { classification: "unclassified", driftedPaths: [] };
  const current = input.currentConfig as Record<string, unknown>;

  const driftedPaths: EnvironmentCustomImageDriftedPath[] = [];
  let hasValueDrift = false;
  for (const [path, capturedValue] of Object.entries(boot.values)) {
    const currentValue = readConfigValueAtPath(current, path);
    if (stableStringify(capturedValue ?? null) !== stableStringify(currentValue ?? null)) {
      hasValueDrift = true;
      driftedPaths.push({ path, from: capturedValue ?? null, to: currentValue ?? null });
    }
  }
  for (const path of boot.excludedPaths) {
    driftedPaths.push({ path });
  }
  const providerMismatch = boot.provider !== input.currentConfig.provider;
  if (boot.excludedPaths.length > 0 || providerMismatch) {
    return { classification: "unclassified", driftedPaths };
  }
  if (hasValueDrift) {
    return { classification: "boot_source_drift", driftedPaths };
  }
  return { classification: "knob_only", driftedPaths: [] };
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
