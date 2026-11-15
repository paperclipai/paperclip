import { createHash } from "node:crypto";
import type { SecretProviderConfigDiscoveryPreviewResult, SecretProviderDescriptor } from "@paperclipai/shared";
import type {
  PreparedSecretVersion,
  RemoteSecretListEntry,
  RemoteSecretListResult,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretProviderValidationResult,
  SecretProviderVaultRuntimeConfig,
  SecretProviderWriteContext,
  StoredSecretVersionMaterial,
} from "./types.js";
import { SecretProviderClientError } from "./types.js";

const NENV_SCHEME = "nenv_reference_v1";

// ─── types ──────────────────────────────────────────────────────────────────

interface NenvSecretMaterial extends StoredSecretVersionMaterial {
  scheme: typeof NENV_SCHEME;
  source: "managed" | "external_reference";
  namespace: string;
  key: string;
  nenvVersion: number | null;
}

interface NenvSecretResponse {
  id: string;
  key: string;
  value?: string;
  description: string;
  tags: string[];
  version: number;
  created_at: string;
  updated_at: string;
}

interface NenvListResponse {
  secrets: NenvSecretResponse[];
}

interface NenvProviderRuntimeConfig {
  baseUrl: string;
  namespace: string;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function externalFingerprint(namespace: string, key: string, nenvVersion: number | null): string {
  return createHash("sha256").update(`nenv:${namespace}:${key}:${nenvVersion ?? "latest"}`).digest("hex");
}

function getNenvToken(): string {
  const token = process.env.NENV_TOKEN || process.env.PAPERCLIP_NENV_TOKEN;
  if (!token || !token.trim()) {
    throw new SecretProviderClientError({
      code: "access_denied",
      provider: "nenv",
      operation: "getNenvToken",
      message: "NENV_TOKEN environment variable is not set; the nenv provider requires a bearer token to authenticate with the nenv API",
    });
  }
  return token.trim();
}

function resolveNenvConfig(providerConfig?: SecretProviderVaultRuntimeConfig | null): NenvProviderRuntimeConfig | null {
  if (!providerConfig?.config) return null;
  const cfg = providerConfig.config;
  const baseUrl = typeof cfg.baseUrl === "string" ? cfg.baseUrl.trim() : null;
  const namespace = typeof cfg.namespace === "string" ? cfg.namespace.trim() : null;
  if (!baseUrl || !namespace) return null;
  return { baseUrl, namespace };
}

function asNenvMaterial(material: StoredSecretVersionMaterial): NenvSecretMaterial {
  if (
    material &&
    typeof material === "object" &&
    material.scheme === NENV_SCHEME &&
    typeof material.namespace === "string" &&
    typeof material.key === "string"
  ) {
    return material as NenvSecretMaterial;
  }
  throw new SecretProviderClientError({
    code: "invalid_request",
    provider: "nenv",
    operation: "asNenvMaterial",
    message: `Invalid nenv secret material (expected scheme ${NENV_SCHEME})`,
  });
}

// ─── nenv API client ────────────────────────────────────────────────────────

async function nenvRequest(
  baseUrl: string,
  token: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${baseUrl}${path}`;
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init?.headers ?? {}),
      },
    });
    return response;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/ECONN|ENOTFOUND|ETIMEDOUT|network|timeout|fetch failed/i.test(message)) {
      throw new SecretProviderClientError({
        code: "provider_unavailable",
        provider: "nenv",
        operation: "nenvRequest",
        message: `nenv API unreachable at ${baseUrl}: ${message}`,
      });
    }
    throw new SecretProviderClientError({
      code: "provider_error",
      provider: "nenv",
      operation: "nenvRequest",
      message: `nenv API request failed: ${message}`,
    });
  }
}

async function nenvGetSecret(
  baseUrl: string,
  token: string,
  namespace: string,
  key: string,
): Promise<NenvSecretResponse> {
  const path = `/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(key)}`;
  const response = await nenvRequest(baseUrl, token, path);
  if (!response.ok) {
    if (response.status === 404) {
      throw new SecretProviderClientError({
        code: "not_found",
        provider: "nenv",
        operation: "getSecret",
        message: `Secret "${key}" not found in nenv namespace "${namespace}"`,
        status: 404,
      });
    }
    if (response.status === 401 || response.status === 403) {
      throw new SecretProviderClientError({
        code: "access_denied",
        provider: "nenv",
        operation: "getSecret",
        message: `nenv API access denied for namespace "${namespace}"`,
        status: response.status,
      });
    }
    throw new SecretProviderClientError({
      code: "provider_error",
      provider: "nenv",
      operation: "getSecret",
      message: `nenv API error: ${response.status} ${response.statusText}`,
      status: response.status,
    });
  }
  return response.json() as Promise<NenvSecretResponse>;
}

async function nenvSetSecret(
  baseUrl: string,
  token: string,
  namespace: string,
  key: string,
  value: string,
): Promise<NenvSecretResponse> {
  const path = `/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(key)}`;
  const response = await nenvRequest(baseUrl, token, path, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ value }),
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new SecretProviderClientError({
        code: "access_denied",
        provider: "nenv",
        operation: "setSecret",
        message: `nenv API access denied for namespace "${namespace}"`,
        status: response.status,
      });
    }
    throw new SecretProviderClientError({
      code: "provider_error",
      provider: "nenv",
      operation: "setSecret",
      message: `nenv API error: ${response.status} ${response.statusText}`,
      status: response.status,
    });
  }
  return response.json() as Promise<NenvSecretResponse>;
}

async function nenvDeleteSecret(
  baseUrl: string,
  token: string,
  namespace: string,
  key: string,
): Promise<void> {
  const path = `/v1/namespaces/${encodeURIComponent(namespace)}/secrets/${encodeURIComponent(key)}`;
  try {
    const response = await nenvRequest(baseUrl, token, path, { method: "DELETE" });
    if (!response.ok && response.status !== 404) {
      // Best-effort cleanup — log but don't throw
    }
  } catch {
    // Best-effort — deletion failure shouldn't block archive/delete in Paperclip
  }
}

async function nenvListSecrets(
  baseUrl: string,
  token: string,
  namespace: string,
): Promise<NenvSecretResponse[]> {
  const path = `/v1/namespaces/${encodeURIComponent(namespace)}/secrets`;
  const response = await nenvRequest(baseUrl, token, path);
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new SecretProviderClientError({
        code: "access_denied",
        provider: "nenv",
        operation: "listSecrets",
        message: `nenv API access denied for namespace "${namespace}"`,
        status: response.status,
      });
    }
    throw new SecretProviderClientError({
      code: "provider_error",
      provider: "nenv",
      operation: "listSecrets",
      message: `nenv API error: ${response.status} ${response.statusText}`,
      status: response.status,
    });
  }
  const data = (await response.json()) as NenvListResponse;
  return data.secrets ?? [];
}

async function nenvCheckHealth(
  baseUrl: string,
  token: string,
): Promise<{ ok: boolean; message: string }> {
  try {
    const response = await nenvRequest(baseUrl, token, "/v1/namespaces");
    if (response.ok) return { ok: true, message: "nenv API is reachable" };
    return { ok: false, message: `nenv API health check failed: ${response.status} ${response.statusText}` };
  } catch (err) {
    if (err instanceof SecretProviderClientError) return { ok: false, message: err.message };
    return { ok: false, message: `nenv API unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ─── material builders ──────────────────────────────────────────────────────

function buildManagedMaterial(
  namespace: string,
  key: string,
  nenvVersion: number | null,
): NenvSecretMaterial {
  return {
    scheme: NENV_SCHEME,
    source: "managed",
    namespace,
    key,
    nenvVersion,
  };
}

function buildExternalReferenceMaterial(
  namespace: string,
  key: string,
  nenvVersion: number | null,
): NenvSecretMaterial {
  return {
    scheme: NENV_SCHEME,
    source: "external_reference",
    namespace,
    key,
    nenvVersion,
  };
}

function prepareManagedVersion(
  namespace: string,
  key: string,
  value: string,
  nenvVersion: number | null,
): PreparedSecretVersion {
  const valueSha256 = sha256Hex(value);
  return {
    material: buildManagedMaterial(namespace, key, nenvVersion),
    valueSha256,
    fingerprintSha256: valueSha256,
    externalRef: `${namespace}/${key}`,
    providerVersionRef: nenvVersion != null ? String(nenvVersion) : null,
  };
}

function prepareExternalReference(
  namespace: string,
  key: string,
  nenvVersion: number | null,
): PreparedSecretVersion {
  const fingerprint = externalFingerprint(namespace, key, nenvVersion);
  return {
    material: buildExternalReferenceMaterial(namespace, key, nenvVersion),
    valueSha256: fingerprint,
    fingerprintSha256: fingerprint,
    externalRef: `${namespace}/${key}`,
    providerVersionRef: nenvVersion != null ? String(nenvVersion) : null,
  };
}

// ─── provider module ────────────────────────────────────────────────────────

export const nenvProvider: SecretProviderModule = {
  id: "nenv",
  descriptor(): SecretProviderDescriptor {
    const token = process.env.NENV_TOKEN || process.env.PAPERCLIP_NENV_TOKEN;
    return {
      id: "nenv",
      label: "NetEnv (nenv)",
      requiresExternalRef: false,
      supportsManagedValues: true,
      supportsExternalReferences: true,
      configured: Boolean(token?.trim()),
    };
  },

  async validateConfig(input): Promise<SecretProviderValidationResult> {
    const warnings: string[] = [];
    const token = process.env.NENV_TOKEN || process.env.PAPERCLIP_NENV_TOKEN;
    if (!token?.trim()) {
      warnings.push("NENV_TOKEN environment variable is not set; the nenv provider cannot resolve or store secrets without it");
    }
    const config = resolveNenvConfig(input?.providerConfig ?? null);
    if (!config) {
      warnings.push("nenv provider config is incomplete (baseUrl and namespace are required)");
      return { ok: false, warnings };
    }
    if (token?.trim()) {
      const health = await nenvCheckHealth(config.baseUrl, token.trim());
      if (!health.ok) warnings.push(health.message);
    }
    return { ok: warnings.length === 0, warnings };
  },

  async createSecret(input): Promise<PreparedSecretVersion> {
    const config = resolveNenvConfig(input.providerConfig ?? null);
    if (!config) {
      throw new SecretProviderClientError({
        code: "invalid_request",
        provider: "nenv",
        operation: "createSecret",
        message: "nenv provider config is incomplete (baseUrl and namespace are required)",
      });
    }
    const context = input.context;
    const key = context?.secretKey ?? `paperclip-${sha256Hex(input.value).slice(0, 24)}`;
    const token = getNenvToken();
    const result = await nenvSetSecret(config.baseUrl, token, config.namespace, key, input.value);
    return prepareManagedVersion(config.namespace, key, input.value, result.version);
  },

  async createVersion(input): Promise<PreparedSecretVersion> {
    const config = resolveNenvConfig(input.providerConfig ?? null);
    if (!config) {
      throw new SecretProviderClientError({
        code: "invalid_request",
        provider: "nenv",
        operation: "createVersion",
        message: "nenv provider config is incomplete (baseUrl and namespace are required)",
      });
    }
    const context = input.context;
    const key = context?.secretKey ?? input.externalRef?.split("/").pop() ?? "";
    if (!key) {
      throw new SecretProviderClientError({
        code: "invalid_request",
        provider: "nenv",
        operation: "createVersion",
        message: "Secret key is required to create a new version in nenv",
      });
    }
    const token = getNenvToken();
    const result = await nenvSetSecret(config.baseUrl, token, config.namespace, key, input.value);
    return prepareManagedVersion(config.namespace, key, input.value, result.version);
  },

  async linkExternalSecret(input): Promise<PreparedSecretVersion> {
    const externalRef = input.externalRef.trim();
    // externalRef format: "namespace/key" or just "key" (uses configured namespace)
    const slashIdx = externalRef.indexOf("/");
    let namespace: string;
    let key: string;
    if (slashIdx > 0) {
      namespace = externalRef.slice(0, slashIdx);
      key = externalRef.slice(slashIdx + 1);
    } else {
      const config = resolveNenvConfig(input.providerConfig ?? null);
      if (!config) {
        throw new SecretProviderClientError({
          code: "invalid_request",
          provider: "nenv",
          operation: "linkExternalSecret",
          message: "nenv provider config is incomplete — a configured namespace is required when externalRef does not include one",
        });
      }
      namespace = config.namespace;
      key = externalRef;
    }
    if (!namespace || !key) {
      throw new SecretProviderClientError({
        code: "invalid_request",
        provider: "nenv",
        operation: "linkExternalSecret",
        message: "Invalid external reference — expected 'namespace/key' or 'key'",
      });
    }
    const providerVersionRef = input.providerVersionRef?.trim() || null;
    const nenvVersion = providerVersionRef ? Number.parseInt(providerVersionRef, 10) : null;
    return prepareExternalReference(namespace, key, Number.isNaN(nenvVersion) ? null : nenvVersion);
  },

  async listRemoteSecrets(input): Promise<RemoteSecretListResult> {
    const config = resolveNenvConfig(input.providerConfig ?? null);
    if (!config) {
      throw new SecretProviderClientError({
        code: "invalid_request",
        provider: "nenv",
        operation: "listRemoteSecrets",
        message: "nenv provider config is incomplete (baseUrl and namespace are required)",
      });
    }
    const token = getNenvToken();
    const secrets = await nenvListSecrets(config.baseUrl, token, config.namespace);
    const query = input.query?.trim().toLowerCase();
    const filtered = query
      ? secrets.filter((s) => s.key.toLowerCase().includes(query))
      : secrets;
    const entries: RemoteSecretListEntry[] = filtered.map((s) => ({
      externalRef: `${config.namespace}/${s.key}`,
      name: s.key,
      providerVersionRef: String(s.version),
      metadata: {
        id: s.id,
        version: s.version,
        description: s.description || null,
        tags: s.tags ?? [],
      },
    }));
    return { secrets: entries, nextToken: null };
  },

  async resolveVersion(input): Promise<string> {
    const material = asNenvMaterial(input.material);
    const token = getNenvToken();
    const config = resolveNenvConfig(input.providerConfig ?? null);
    // Use the namespace from material, or fall back to the provider config
    const namespace = material.namespace || (config?.namespace ?? "");
    if (!namespace) {
      throw new SecretProviderClientError({
        code: "invalid_request",
        provider: "nenv",
        operation: "resolveVersion",
        message: "Cannot resolve nenv secret — no namespace in material or provider config",
      });
    }
    const baseUrl = config?.baseUrl ?? process.env.NENV_SERVER ?? "http://localhost:7200";
    const secret = await nenvGetSecret(baseUrl, token, namespace, material.key);
    if (typeof secret.value !== "string" || !secret.value) {
      throw new SecretProviderClientError({
        code: "not_found",
        provider: "nenv",
        operation: "resolveVersion",
        message: `nenv secret "${material.key}" in namespace "${namespace}" returned an empty value`,
        status: 404,
      });
    }
    return secret.value;
  },

  async deleteOrArchive(input): Promise<void> {
    const material =
      input.material && typeof input.material === "object"
        ? asNenvMaterial(input.material)
        : null;
    if (!material) return;
    if (material.source !== "managed") return;
    if (input.mode !== "delete") return;

    const config = resolveNenvConfig(input.providerConfig ?? null);
    if (!config) return;
    const token = getNenvToken();
    await nenvDeleteSecret(config.baseUrl, token, config.namespace, material.key);
  },

  async healthCheck(input?): Promise<SecretProviderHealthCheck> {
    const token = process.env.NENV_TOKEN || process.env.PAPERCLIP_NENV_TOKEN;
    if (!token?.trim()) {
      return {
        provider: "nenv",
        status: "warn",
        message: "NENV_TOKEN environment variable is not set",
        warnings: ["Set NENV_TOKEN to enable the nenv secret provider"],
      };
    }
    const config = resolveNenvConfig(input?.providerConfig ?? null);
    const baseUrl = config?.baseUrl ?? process.env.NENV_SERVER ?? "http://localhost:7200";
    const health = await nenvCheckHealth(baseUrl, token.trim());
    if (health.ok) {
      return {
        provider: "nenv",
        status: "ok",
        message: health.message,
        details: { baseUrl, namespace: config?.namespace ?? null },
      };
    }
    return {
      provider: "nenv",
      status: "error",
      message: health.message,
      details: { baseUrl },
    };
  },
};