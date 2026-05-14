// Helpers for normalizing the k8s environment driver form into the nested
// `config` shape that the server's k8sEnvironmentConfigSchema expects.
// The schema is `.strict()` and rejects empty strings, so blanks MUST be
// omitted (not sent as `""`).
import {
  tolerationsArraySchema,
  type K8sEnvironmentConfig,
  type ProviderPool,
  type Toleration,
} from "@paperclipai/shared";

/** Provider keys that have first-class textareas in the form. Anything else
 *  is preserved through the round-trip in `k8sProviderExtras` so we don't
 *  silently drop unknown providers (e.g. a forward-compat key). */
export const KNOWN_PROVIDER_KEYS = ["anthropic", "openai"] as const;
export type KnownProviderKey = typeof KNOWN_PROVIDER_KEYS[number];

export type K8sFormFields = {
  k8sKubeconfigSecretRef: string;
  k8sUseInClusterAuth: boolean;
  k8sNamespace: string;
  k8sServiceAccountName: string;
  k8sNodeSelector: string;
  k8sTolerations: string;
  k8sLabels: string;
  k8sImagePullPolicy: string;
  k8sResourcesRequestsCpu: string;
  k8sResourcesRequestsMemory: string;
  k8sResourcesLimitsCpu: string;
  k8sResourcesLimitsMemory: string;
  k8sWorkspaceVolumeClaim: string;
  k8sWorkspaceMountPath: string;
  k8sSecretsNamespace: string;
  k8sProviderAnthropicKind: "ccrotate";
  k8sProviderAnthropicAccounts: string;
  k8sProviderOpenaiKind: "ccrotate";
  k8sProviderOpenaiAccounts: string;
  /** Provider-pool entries with keys outside KNOWN_PROVIDER_KEYS. Preserved
   *  verbatim through edit/save so the UI doesn't silently drop them. */
  k8sProviderExtras: Record<string, ProviderPool>;
};

/**
 * Single source of truth — what the server's k8sEnvironmentConfigSchema
 * accepts. Re-exported so call sites can import one type instead of
 * juggling a duplicate.
 */
export type K8sEnvironmentConfigPayload = K8sEnvironmentConfig;

/**
 * Parse `key=value` (or `key: value`) entries separated by newlines into a
 * record. Blank lines and `#` comment lines are ignored. Returns null when any
 * non-blank line is malformed (no separator, or empty key).
 */
export function parseKeyValueLines(input: string): Record<string, string> | null {
  const out: Record<string, string> = {};
  for (const rawLine of input.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    let key: string;
    let value: string;
    const eqIdx = line.indexOf("=");
    const colonIdx = line.indexOf(":");
    let sepIdx: number;
    if (eqIdx === -1 && colonIdx === -1) {
      return null;
    }
    if (eqIdx === -1) {
      sepIdx = colonIdx;
    } else if (colonIdx === -1) {
      sepIdx = eqIdx;
    } else {
      sepIdx = Math.min(eqIdx, colonIdx);
    }
    key = line.slice(0, sepIdx).trim();
    value = line.slice(sepIdx + 1).trim();
    if (key.length === 0) {
      return null;
    }
    out[key] = value;
  }
  return out;
}

/**
 * Parse a free-form accounts list (newline- or comma-separated emails) into
 * a deduplicated string array. Comparison is case-insensitive (emails are
 * case-insensitive per RFC 5321) but the first-seen casing is preserved in
 * output. Whitespace tokens are dropped.
 */
export function parseAccountsList(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[\s,]+/)) {
    const s = raw.trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

/**
 * Parse a tolerations JSON textarea against the shared `tolerationSchema`.
 * Returns:
 *   - undefined for empty/whitespace input (don't include in payload)
 *   - null for invalid JSON, non-array, or any toleration that doesn't match
 *     the schema (UI should surface error)
 *   - the validated typed array otherwise
 */
export function parseTolerationsJson(
  input: string,
): Toleration[] | null | undefined {
  const trimmed = input.trim();
  if (trimmed.length === 0) return undefined;
  try {
    const parsed = JSON.parse(trimmed);
    const result = tolerationsArraySchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function trimToOptional(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Build the nested `config` object the server expects for a k8s environment.
 *
 * Important rules (mirroring `k8sEnvironmentConfigSchema`):
 * - When `k8sUseInClusterAuth === true`, `kubeconfigSecretRef` is OMITTED
 *   entirely (not sent as `""`, which the schema rejects).
 * - Empty strings are omitted from every optional field.
 * - `nodeSelector` / `labels` are omitted when their parsed record is empty.
 * - `tolerations` is omitted when blank; if invalid the caller should reject
 *   submit before getting here (see `parseTolerationsJson`).
 * - `resources` is omitted unless at least one cpu/memory cell is set.
 */
export function buildK8sEnvironmentConfig(
  form: K8sFormFields,
): K8sEnvironmentConfigPayload {
  const config: K8sEnvironmentConfigPayload = {};

  if (!form.k8sUseInClusterAuth) {
    const ref = trimToOptional(form.k8sKubeconfigSecretRef);
    if (ref !== undefined) config.kubeconfigSecretRef = ref;
  }

  const namespace = trimToOptional(form.k8sNamespace);
  if (namespace !== undefined) config.namespace = namespace;

  const serviceAccountName = trimToOptional(form.k8sServiceAccountName);
  if (serviceAccountName !== undefined) config.serviceAccountName = serviceAccountName;

  const workspaceVolumeClaim = trimToOptional(form.k8sWorkspaceVolumeClaim);
  if (workspaceVolumeClaim !== undefined) config.workspaceVolumeClaim = workspaceVolumeClaim;

  const workspaceMountPath = trimToOptional(form.k8sWorkspaceMountPath);
  if (workspaceMountPath !== undefined) config.workspaceMountPath = workspaceMountPath;

  const secretsNamespace = trimToOptional(form.k8sSecretsNamespace);
  if (secretsNamespace !== undefined) config.secretsNamespace = secretsNamespace;

  if (form.k8sImagePullPolicy === "Always" || form.k8sImagePullPolicy === "IfNotPresent" || form.k8sImagePullPolicy === "Never") {
    config.imagePullPolicy = form.k8sImagePullPolicy;
  }

  const nodeSelector = parseKeyValueLines(form.k8sNodeSelector);
  if (nodeSelector && Object.keys(nodeSelector).length > 0) {
    config.nodeSelector = nodeSelector;
  }

  const labels = parseKeyValueLines(form.k8sLabels);
  if (labels && Object.keys(labels).length > 0) {
    config.labels = labels;
  }

  const tolerations = parseTolerationsJson(form.k8sTolerations);
  if (Array.isArray(tolerations) && tolerations.length > 0) {
    config.tolerations = tolerations;
  }

  const reqCpu = trimToOptional(form.k8sResourcesRequestsCpu);
  const reqMem = trimToOptional(form.k8sResourcesRequestsMemory);
  const limCpu = trimToOptional(form.k8sResourcesLimitsCpu);
  const limMem = trimToOptional(form.k8sResourcesLimitsMemory);
  if (reqCpu !== undefined || reqMem !== undefined || limCpu !== undefined || limMem !== undefined) {
    const resources: NonNullable<K8sEnvironmentConfigPayload["resources"]> = {};
    if (reqCpu !== undefined || reqMem !== undefined) {
      resources.requests = {};
      if (reqCpu !== undefined) resources.requests.cpu = reqCpu;
      if (reqMem !== undefined) resources.requests.memory = reqMem;
    }
    if (limCpu !== undefined || limMem !== undefined) {
      resources.limits = {};
      if (limCpu !== undefined) resources.limits.cpu = limCpu;
      if (limMem !== undefined) resources.limits.memory = limMem;
    }
    config.resources = resources;
  }

  const providers: NonNullable<K8sEnvironmentConfigPayload["providers"]> = {
    ...form.k8sProviderExtras,
  };
  const anthropicAccounts = parseAccountsList(form.k8sProviderAnthropicAccounts);
  if (anthropicAccounts.length > 0) {
    providers.anthropic = { kind: form.k8sProviderAnthropicKind, accounts: anthropicAccounts };
  }
  const openaiAccounts = parseAccountsList(form.k8sProviderOpenaiAccounts);
  if (openaiAccounts.length > 0) {
    providers.openai = { kind: form.k8sProviderOpenaiKind, accounts: openaiAccounts };
  }
  if (Object.keys(providers).length > 0) {
    config.providers = providers;
  }

  return config;
}

/** Pull provider entries with keys outside `KNOWN_PROVIDER_KEYS` for
 *  preservation through the form round-trip. Validates each entry against
 *  the same shape ProviderPool requires; entries that don't match are
 *  dropped (the schema would reject them on save anyway). */
export function readProviderExtras(providers: unknown): Record<string, ProviderPool> {
  if (!providers || typeof providers !== "object" || Array.isArray(providers)) return {};
  const out: Record<string, ProviderPool> = {};
  const known = new Set<string>(KNOWN_PROVIDER_KEYS);
  for (const [key, entry] of Object.entries(providers as Record<string, unknown>)) {
    if (known.has(key)) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    if (e.kind !== "ccrotate") continue;
    if (!Array.isArray(e.accounts)) continue;
    const accounts = e.accounts.filter((a) => typeof a === "string");
    if (accounts.length === 0) continue;
    out[key] = { kind: "ccrotate", accounts };
  }
  return out;
}
