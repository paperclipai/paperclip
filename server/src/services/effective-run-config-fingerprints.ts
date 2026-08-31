import { createHash } from "node:crypto";
import type { RuntimeSecretManifestEntry } from "./secrets.js";

export const EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION = 1;
export const EFFECTIVE_RUN_CONFIG_FINGERPRINT_ALGORITHM = "sha256";
export const EFFECTIVE_RUN_CONFIG_FINGERPRINT_CATEGORIES = ["session", "workspace", "lease"] as const;

export type EffectiveRunConfigFingerprintCategory =
  (typeof EFFECTIVE_RUN_CONFIG_FINGERPRINT_CATEGORIES)[number];

export type EffectiveRunConfigChangedCategory = EffectiveRunConfigFingerprintCategory;

export type EffectiveRunConfigCanonicalValue =
  | null
  | boolean
  | number
  | string
  | EffectiveRunConfigCanonicalValue[]
  | { [key: string]: EffectiveRunConfigCanonicalValue };

export interface EffectiveRunConfigSecretVersionMetadata {
  configPath: string;
  envKey: string | null;
  secretId: string;
  bindingId?: string | null;
  version: number | string;
  provider?: string | null;
  providerVersionRef?: string | null;
  outcome?: "success" | "failure" | null;
}

export type EffectiveRunConfigSecretManifestEntry =
  | RuntimeSecretManifestEntry
  | EffectiveRunConfigSecretVersionMetadata;

export interface EffectiveRunConfigFingerprintInput {
  session?: unknown;
  workspace?: unknown;
  lease?: unknown;
  secretManifest?: readonly EffectiveRunConfigSecretManifestEntry[];
}

export interface EffectiveRunConfigFingerprint {
  version: typeof EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION;
  category: EffectiveRunConfigFingerprintCategory;
  algorithm: typeof EFFECTIVE_RUN_CONFIG_FINGERPRINT_ALGORITHM;
  fingerprint: string;
  canonicalJson: string;
}

export interface EffectiveRunConfigFingerprints {
  version: typeof EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION;
  categories: readonly EffectiveRunConfigFingerprintCategory[];
  sessionFingerprint: EffectiveRunConfigFingerprint;
  workspaceFingerprint: EffectiveRunConfigFingerprint;
  leaseFingerprint: EffectiveRunConfigFingerprint;
}

export interface EffectiveRunConfigFingerprintDiff {
  version: typeof EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION;
  hasChanges: boolean;
  changedCategories: EffectiveRunConfigChangedCategory[];
  changed: Record<EffectiveRunConfigChangedCategory, boolean>;
}

const OMIT = Symbol("omit-from-effective-run-config-fingerprint");
const REDACTED_VALUE: EffectiveRunConfigCanonicalValue = { type: "redacted", present: true };

const GENERATED_RUNTIME_ENV_KEY_RE = /^PAPERCLIP_/;
const SENSITIVE_CONFIG_KEY_RE =
  /(?:api[_-]?key|access[_-]?token|auth(?:orization)?|bearer|cookie|credential|jwt|password|passwd|private[_-]?key|secret|token)$/i;
const VOLATILE_CONFIG_KEYS = new Set([
  "checkoutRunId",
  "executionRunId",
  "externalRunId",
  "heartbeatRunId",
  "invocationId",
  "leaseId",
  "providerLeaseId",
  "requestId",
  "runId",
  "sessionDisplayId",
  "sessionId",
  "spanId",
  "traceId",
]);
const HOST_NOISE_KEYS = new Set([
  "agentHome",
  "homeDir",
  "hostCwd",
  "localHome",
  "tempDir",
  "tmpDir",
  "userHome",
]);
const SESSION_HOST_PATH_KEYS = new Set([
  "cwd",
  "localPath",
  "remoteCwd",
  "workspaceCwd",
  "workspacePath",
  "workspaceRemoteDir",
  "worktreePath",
]);

type SecretManifestIndex = {
  byConfigPath: Map<string, EffectiveRunConfigSecretVersionMetadata>;
  byEnvKey: Map<string, EffectiveRunConfigSecretVersionMetadata>;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === "object"
    && !Array.isArray(value)
    && !(value instanceof Date);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function readVersion(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  return readString(value);
}

function normalizeSecretManifestEntry(
  entry: EffectiveRunConfigSecretManifestEntry,
): EffectiveRunConfigSecretVersionMetadata | null {
  const record = entry as Record<string, unknown>;
  const secretId = readString(record.secretId);
  const version = readVersion(record.version);
  if (!secretId || version === null) return null;

  const normalized: EffectiveRunConfigSecretVersionMetadata = {
    configPath: readString(record.configPath) ?? "",
    envKey: readString(record.envKey),
    secretId,
    version,
  };
  const bindingId = readString(record.bindingId);
  const provider = readString(record.provider);
  const providerVersionRef = readString(record.providerVersionRef);
  const outcome = record.outcome === "success" || record.outcome === "failure"
    ? record.outcome
    : null;
  if (bindingId !== null) normalized.bindingId = bindingId;
  if (provider !== null) normalized.provider = provider;
  if (providerVersionRef !== null) normalized.providerVersionRef = providerVersionRef;
  if (outcome !== null) normalized.outcome = outcome;
  return normalized;
}

function buildSecretManifestIndex(
  manifest: readonly EffectiveRunConfigSecretManifestEntry[] | undefined,
): SecretManifestIndex {
  const byConfigPath = new Map<string, EffectiveRunConfigSecretVersionMetadata>();
  const byEnvKey = new Map<string, EffectiveRunConfigSecretVersionMetadata>();
  for (const entry of manifest ?? []) {
    const normalized = normalizeSecretManifestEntry(entry);
    if (!normalized) continue;
    if (normalized.configPath) byConfigPath.set(normalized.configPath, normalized);
    if (normalized.envKey) byEnvKey.set(normalized.envKey, normalized);
  }
  return { byConfigPath, byEnvKey };
}

function canonicalSecretMetadata(
  metadata: EffectiveRunConfigSecretVersionMetadata,
): EffectiveRunConfigCanonicalValue {
  return omitNullish({
    type: "secret_ref",
    configPath: metadata.configPath || undefined,
    envKey: metadata.envKey ?? undefined,
    secretId: metadata.secretId,
    bindingId: metadata.bindingId ?? undefined,
    version: metadata.version,
    provider: metadata.provider ?? undefined,
    providerVersionRef: metadata.providerVersionRef ?? undefined,
    outcome: metadata.outcome ?? undefined,
  });
}

function isSecretRefBinding(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value)
    && value.type === "secret_ref"
    && typeof value.secretId === "string"
    && value.secretId.trim().length > 0;
}

function canonicalSecretRefBinding(
  value: Record<string, unknown>,
  configPath: string,
): EffectiveRunConfigCanonicalValue {
  return omitNullish({
    type: "secret_ref",
    configPath,
    secretId: readString(value.secretId),
    versionSelector: readVersion(value.version) ?? "latest",
    unresolved: true,
  });
}

function omitNullish(record: Record<string, unknown>): EffectiveRunConfigCanonicalValue {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null),
  ) as EffectiveRunConfigCanonicalValue;
}

function isTimestampNoiseKey(key: string) {
  return /(created|updated|started|finished|completed|cancelled|resolved|used|heartbeat)At$/i.test(key)
    && !/(revision|version)/i.test(key);
}

function shouldOmitObjectKey(
  category: EffectiveRunConfigFingerprintCategory,
  key: string,
) {
  if (VOLATILE_CONFIG_KEYS.has(key)) return true;
  if (HOST_NOISE_KEYS.has(key)) return true;
  if (isTimestampNoiseKey(key)) return true;
  if (category === "session" && SESSION_HOST_PATH_KEYS.has(key)) return true;
  if (category === "lease" && (key === "remoteCwd" || key === "workspaceRemoteDir")) return true;
  return false;
}

function stableStringify(value: EffectiveRunConfigCanonicalValue): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, EffectiveRunConfigCanonicalValue>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key] ?? null)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function canonicalizePlainEnvValueForHash(value: unknown): EffectiveRunConfigCanonicalValue {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizePlainEnvValueForHash(entry));
  }
  if (isPlainObject(value)) {
    const out: Record<string, EffectiveRunConfigCanonicalValue> = {};
    for (const key of Object.keys(value).sort()) {
      const next = canonicalizePlainEnvValueForHash(value[key]);
      if (next !== null) out[key] = next;
    }
    return out;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  return String(value);
}

function hashPlainEnvValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const canonicalJson = stableStringify(canonicalizePlainEnvValueForHash(value));
  return `sha256:${createHash("sha256").update(canonicalJson).digest("hex")}`;
}

function canonicalizeEnvRecord(
  envValue: unknown,
  context: CanonicalizeContext,
): EffectiveRunConfigCanonicalValue | typeof OMIT {
  if (!isPlainObject(envValue)) return {};
  const canonicalEnv: Record<string, EffectiveRunConfigCanonicalValue> = {};
  for (const key of Object.keys(envValue).sort()) {
    if (GENERATED_RUNTIME_ENV_KEY_RE.test(key)) continue;
    const manifestEntry = context.secrets.byConfigPath.get(`env.${key}`) ?? context.secrets.byEnvKey.get(key);
    if (manifestEntry) {
      canonicalEnv[key] = canonicalSecretMetadata(manifestEntry);
      continue;
    }
    const rawBinding = envValue[key];
    if (isSecretRefBinding(rawBinding)) {
      canonicalEnv[key] = canonicalSecretRefBinding(rawBinding, `env.${key}`);
      continue;
    }
    canonicalEnv[key] = omitNullish({
      type: "plain_env",
      present: rawBinding !== undefined && rawBinding !== null,
      valueHash: hashPlainEnvValue(rawBinding),
    });
  }
  return Object.keys(canonicalEnv).length > 0 ? canonicalEnv : OMIT;
}

type CanonicalizeContext = {
  category: EffectiveRunConfigFingerprintCategory;
  path: string[];
  secrets: SecretManifestIndex;
};

function canonicalizeValue(
  value: unknown,
  context: CanonicalizeContext,
): EffectiveRunConfigCanonicalValue | typeof OMIT {
  if (value === undefined || value instanceof Date) return OMIT;
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((entry, index) => {
      const next = canonicalizeValue(entry, { ...context, path: [...context.path, String(index)] });
      return next === OMIT ? null : next;
    });
  }
  if (isSecretRefBinding(value)) {
    return canonicalSecretRefBinding(value, context.path.join("."));
  }
  if (isPlainObject(value)) {
    const canonicalObject: Record<string, EffectiveRunConfigCanonicalValue> = {};
    for (const key of Object.keys(value).sort()) {
      if (key === "env") {
        const env = canonicalizeEnvRecord(value[key], { ...context, path: [...context.path, key] });
        if (env !== OMIT) canonicalObject[key] = env;
        continue;
      }
      if (shouldOmitObjectKey(context.category, key)) continue;
      if (SENSITIVE_CONFIG_KEY_RE.test(key)) {
        canonicalObject[key] = REDACTED_VALUE;
        continue;
      }
      const next = canonicalizeValue(value[key], { ...context, path: [...context.path, key] });
      if (next !== OMIT) canonicalObject[key] = next;
    }
    return Object.keys(canonicalObject).length > 0 ? canonicalObject : {};
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (typeof value === "boolean" || typeof value === "string") {
    return value;
  }
  return null;
}

export function canonicalizeEffectiveRunConfigCategory(input: {
  category: EffectiveRunConfigFingerprintCategory;
  value: unknown;
  secretManifest?: readonly EffectiveRunConfigSecretManifestEntry[];
}): EffectiveRunConfigCanonicalValue {
  const canonical = canonicalizeValue(input.value ?? {}, {
    category: input.category,
    path: [],
    secrets: buildSecretManifestIndex(input.secretManifest),
  });
  return canonical === OMIT ? {} : canonical;
}

function createCategoryFingerprint(input: {
  category: EffectiveRunConfigFingerprintCategory;
  value: unknown;
  secretManifest?: readonly EffectiveRunConfigSecretManifestEntry[];
}): EffectiveRunConfigFingerprint {
  const canonicalValue = canonicalizeEffectiveRunConfigCategory(input);
  const canonicalJson = stableStringify({
    version: EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
    category: input.category,
    value: canonicalValue,
  });
  const digest = createHash("sha256").update(canonicalJson).digest("hex");
  return {
    version: EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
    category: input.category,
    algorithm: EFFECTIVE_RUN_CONFIG_FINGERPRINT_ALGORITHM,
    fingerprint: `v${EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION}:sha256:${digest}`,
    canonicalJson,
  };
}

function createCategoryFingerprintFromCanonicalValue(input: {
  category: EffectiveRunConfigFingerprintCategory;
  value: EffectiveRunConfigCanonicalValue;
}): EffectiveRunConfigFingerprint {
  const canonicalJson = stableStringify({
    version: EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
    category: input.category,
    value: input.value,
  });
  const digest = createHash("sha256").update(canonicalJson).digest("hex");
  return {
    version: EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
    category: input.category,
    algorithm: EFFECTIVE_RUN_CONFIG_FINGERPRINT_ALGORITHM,
    fingerprint: `v${EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION}:sha256:${digest}`,
    canonicalJson,
  };
}

function canonicalRecord(value: EffectiveRunConfigCanonicalValue) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, EffectiveRunConfigCanonicalValue>
    : {};
}

export function createEffectiveRunConfigSubcategoryFingerprints<T extends string>(input: {
  category: EffectiveRunConfigFingerprintCategory;
  value: Record<T, unknown>;
  subcategories: readonly T[];
  secretManifest?: readonly EffectiveRunConfigSecretManifestEntry[];
}): Record<T, string> {
  const canonicalValue = canonicalizeEffectiveRunConfigCategory({
    category: input.category,
    value: input.value,
    secretManifest: input.secretManifest,
  });
  const record = canonicalRecord(canonicalValue);
  return Object.fromEntries(
    input.subcategories.map((subcategory) => {
      const value = Object.prototype.hasOwnProperty.call(record, subcategory)
        ? { [subcategory]: record[subcategory] ?? null }
        : {};
      return [
        subcategory,
        createCategoryFingerprintFromCanonicalValue({
          category: input.category,
          value,
        }).fingerprint,
      ];
    }),
  ) as Record<T, string>;
}

export function createEffectiveRunConfigFingerprints(
  input: EffectiveRunConfigFingerprintInput,
): EffectiveRunConfigFingerprints {
  return {
    version: EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
    categories: EFFECTIVE_RUN_CONFIG_FINGERPRINT_CATEGORIES,
    sessionFingerprint: createCategoryFingerprint({
      category: "session",
      value: input.session,
      secretManifest: input.secretManifest,
    }),
    workspaceFingerprint: createCategoryFingerprint({
      category: "workspace",
      value: input.workspace,
      secretManifest: input.secretManifest,
    }),
    leaseFingerprint: createCategoryFingerprint({
      category: "lease",
      value: input.lease,
      secretManifest: input.secretManifest,
    }),
  };
}

function fingerprintForCategory(
  fingerprints: EffectiveRunConfigFingerprints,
  category: EffectiveRunConfigFingerprintCategory,
) {
  switch (category) {
    case "session":
      return fingerprints.sessionFingerprint.fingerprint;
    case "workspace":
      return fingerprints.workspaceFingerprint.fingerprint;
    case "lease":
      return fingerprints.leaseFingerprint.fingerprint;
  }
}

export function diffEffectiveRunConfigFingerprints(
  previous: EffectiveRunConfigFingerprints,
  next: EffectiveRunConfigFingerprints,
): EffectiveRunConfigFingerprintDiff {
  const changed = Object.fromEntries(
    EFFECTIVE_RUN_CONFIG_FINGERPRINT_CATEGORIES.map((category) => [
      category,
      fingerprintForCategory(previous, category) !== fingerprintForCategory(next, category),
    ]),
  ) as Record<EffectiveRunConfigChangedCategory, boolean>;
  const changedCategories = EFFECTIVE_RUN_CONFIG_FINGERPRINT_CATEGORIES.filter((category) => changed[category]);
  return {
    version: EFFECTIVE_RUN_CONFIG_FINGERPRINT_VERSION,
    hasChanges: changedCategories.length > 0,
    changedCategories,
    changed,
  };
}
