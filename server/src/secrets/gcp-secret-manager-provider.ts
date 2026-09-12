import { createHash } from "node:crypto";
import { GoogleAuth } from "google-auth-library";
import { gcpSecretManagerProviderConfigSchema } from "@paperclipai/shared";
import type {
  SecretProviderClientErrorCode,
  SecretProviderModule,
  SecretProviderVaultRuntimeConfig,
} from "./types.js";
import { SecretProviderClientError } from "./types.js";

const PROVIDER = "gcp_secret_manager";
const SCHEME = "gcp_secret_manager_v1";
const REQUEST_TIMEOUT_MS = 30_000;
const PROJECT = "(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[1-9][0-9]{0,19})";
const SECRET_RESOURCE = new RegExp(`^projects/(${PROJECT})/secrets/([A-Za-z0-9_-]{1,255})(?:/versions/([1-9][0-9]*|latest))?$`);

function providerError(operation: string, code: SecretProviderClientErrorCode, message?: string) {
  const messages: Record<SecretProviderClientErrorCode, string> = {
    access_denied: "Google Secret Manager access was denied. Check the server's Application Default Credentials and secretmanager.versions.access permission.",
    throttled: "Google Secret Manager rate limit reached. Try again later.",
    not_found: "The Google Secret Manager secret or version was not found.",
    conflict: "The Google Secret Manager version is unavailable in its current state.",
    invalid_request: "Invalid Google Secret Manager configuration or secret reference.",
    provider_unavailable: "Google Secret Manager or the server's Application Default Credentials are unavailable.",
    provider_error: "Google Secret Manager returned an invalid response.",
  };
  return new SecretProviderClientError({ provider: PROVIDER, operation, code, message: message ?? messages[code] });
}

function normalizeError(operation: string, error: unknown): never {
  if (error instanceof SecretProviderClientError) throw error;
  const response = (error as { response?: { status?: number; data?: { error?: unknown } } } | null)?.response;
  const status = response?.status;
  const authRejected = typeof response?.data?.error === "string" &&
    ["invalid_grant", "invalid_client", "unauthorized_client", "invalid_scope"].includes(response.data.error);
  const code: SecretProviderClientErrorCode =
    authRejected || status === 401 || status === 403 ? "access_denied"
      : status === 404 ? "not_found"
        : status === 429 ? "throttled"
          : status === 400 ? "invalid_request"
            : status === 409 ? "conflict"
              : "provider_unavailable";
  // Auth and HTTP errors can retain tokens, response payloads and request config.
  // Do not attach their message, rawMessage or cause to the public error.
  throw providerError(operation, code);
}

function resolveConfig(providerConfig?: SecretProviderVaultRuntimeConfig | null) {
  if (providerConfig && (providerConfig.provider !== PROVIDER || !["ready", "warning"].includes(providerConfig.status))) {
    throw providerError("validateConfig", "invalid_request");
  }
  const parsed = gcpSecretManagerProviderConfigSchema.safeParse(providerConfig?.config ?? {
    projectId: process.env.PAPERCLIP_SECRETS_GCP_PROJECT_ID,
  });
  if (!parsed.success || !parsed.data.projectId) {
    throw providerError("validateConfig", "invalid_request", "Set a Google Cloud project ID or number in the provider vault, or PAPERCLIP_SECRETS_GCP_PROJECT_ID for the deployment default. Only global Secret Manager resources are supported.");
  }
  return { ...parsed.data, projectId: parsed.data.projectId };
}

function parseReference(externalRef: string, providerVersionRef?: string | null) {
  const match = SECRET_RESOURCE.exec(externalRef.trim());
  const version = providerVersionRef?.trim() || match?.[3] || "latest";
  if (!match || !/^(?:[1-9][0-9]*|latest)$/.test(version) || (match[3] && providerVersionRef && match[3] !== version)) {
    throw providerError("validateReference", "invalid_request");
  }
  return {
    projectId: match[1]!,
    secretId: match[2]!,
    externalRef: `projects/${match[1]}/secrets/${match[2]}`,
    version,
  };
}

// Castagnoli CRC32C, as returned by Secret Manager for its decoded payload bytes.
function crc32c(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0x82f63b78 : 0);
  }
  return String((crc ^ 0xffffffff) >>> 0);
}

export function createGcpSecretManagerProvider(options?: {
  accessVersion?: (name: string) => Promise<unknown>;
}): SecretProviderModule {
  // ADC belongs to the server deployment, never company-controlled vault JSON.
  const auth = new GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    clientOptions: { transporterOptions: { timeout: REQUEST_TIMEOUT_MS, retry: false } },
  });
  const accessVersion = options?.accessVersion ?? (async (name: string) => {
    const response = await auth.request({
      url: `https://secretmanager.googleapis.com/v1/${name}:access`,
      method: "GET",
      timeout: REQUEST_TIMEOUT_MS,
      retry: false,
      maxRedirects: 0,
      responseType: "json",
    });
    return response.data;
  });

  async function access(input: {
    externalRef: string;
    providerVersionRef?: string | null;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }, operation: string) {
    const config = resolveConfig(input.providerConfig);
    const reference = parseReference(input.externalRef, input.providerVersionRef);
    if (reference.projectId !== config.projectId || (config.secretNamePrefix && !reference.secretId.startsWith(config.secretNamePrefix))) {
      throw providerError(operation, "invalid_request", "The secret reference must match the provider vault's project and secret name prefix.");
    }
    try {
      const response = await accessVersion(`${reference.externalRef}/versions/${reference.version}`) as {
        name?: unknown;
        payload?: { data?: unknown; dataCrc32c?: unknown };
      } | null;
      if (typeof response?.name !== "string" || typeof response.payload?.data !== "string") {
        throw providerError(operation, "provider_error");
      }
      const resolved = parseReference(response.name);
      // Google can canonicalise a project ID to its numeric project number.
      const sameProject = resolved.projectId === reference.projectId ||
        (!/^\d+$/.test(reference.projectId) && /^\d+$/.test(resolved.projectId));
      if (!sameProject || resolved.secretId !== reference.secretId || resolved.version === "latest" ||
        (reference.version !== "latest" && resolved.version !== reference.version)) {
        throw providerError(operation, "provider_error");
      }
      const data = response.payload.data;
      if (data.length > 87_384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) {
        throw providerError(operation, "provider_error");
      }
      const bytes = Buffer.from(data, "base64");
      if (bytes.length > 65_536 || String(response.payload.dataCrc32c) !== crc32c(bytes)) {
        throw providerError(operation, "provider_error", "Google Secret Manager payload integrity verification failed.");
      }
      let value: string;
      try {
        value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        throw providerError(operation, "provider_error", "Google Secret Manager payload must contain UTF-8 text.");
      }
      return { value, externalRef: reference.externalRef, version: resolved.version };
    } catch (error) {
      normalizeError(operation, error);
    }
  }

  const refuseWrite = async () => {
    throw providerError("write", "invalid_request", "Google Secret Manager supports linking existing secrets only. Manage secret values and versions in Google Cloud.");
  };

  return {
    id: PROVIDER,
    descriptor() {
      let configured = false;
      try { resolveConfig(); configured = true; } catch { /* No deployment default configured. */ }
      return {
        id: PROVIDER,
        label: "Google Secret Manager",
        requiresExternalRef: true,
        supportsManagedValues: false,
        supportsExternalReferences: true,
        supportsExternalValueWrites: false,
        configured,
      };
    },
    async validateConfig(input) {
      resolveConfig(input?.providerConfig);
      return {
        ok: true,
        warnings: input?.deploymentMode === "authenticated" && input.strictMode !== true
          ? ["Strict secret mode should be enabled for authenticated deployments"] : [],
      };
    },
    createSecret: refuseWrite,
    createVersion: refuseWrite,
    async linkExternalSecret(input) {
      const resolved = await access(input, "linkExternalSecret");
      const fingerprint = createHash("sha256").update(resolved.value).digest("hex");
      return {
        material: { scheme: SCHEME, externalRef: resolved.externalRef, providerVersionRef: resolved.version },
        externalRef: resolved.externalRef,
        providerVersionRef: resolved.version,
        valueSha256: fingerprint,
        fingerprintSha256: fingerprint,
      };
    },
    async resolveVersion(input) {
      const material = input.material;
      const legacy = material.scheme === "external_reference_v1" && material.provider === PROVIDER;
      if ((material.scheme !== SCHEME && !legacy) || typeof material.externalRef !== "string" ||
        (material.providerVersionRef != null && typeof material.providerVersionRef !== "string") ||
        (input.externalRef != null && input.externalRef !== material.externalRef) ||
        (input.providerVersionRef != null && material.providerVersionRef != null && input.providerVersionRef !== material.providerVersionRef)) {
        throw providerError("resolveVersion", "invalid_request");
      }
      const resolved = await access({
        externalRef: material.externalRef,
        providerVersionRef: input.providerVersionRef ?? material.providerVersionRef as string | null,
        providerConfig: input.providerConfig,
      }, "resolveVersion");
      return resolved.value;
    },
    async deleteOrArchive() {
      // Removing a Paperclip reference must never delete or disable the remote secret.
    },
    async healthCheck(input) {
      try {
        const config = resolveConfig(input?.providerConfig);
        return {
          provider: PROVIDER,
          status: "warn",
          message: "Google Secret Manager routing is configured. Credentials and secret access have not been verified.",
          warnings: ["The server uses Application Default Credentials, which are separate from gcloud CLI sign-in. Linking a secret verifies access to that version."],
          details: { projectId: config.projectId, location: "global", credentialSource: "Application Default Credentials", accessVerified: false },
        };
      } catch {
        return {
          provider: PROVIDER,
          status: "warn",
          message: "Google Secret Manager requires a project ID or number and global location. Configure a provider vault or PAPERCLIP_SECRETS_GCP_PROJECT_ID.",
        };
      }
    },
  };
}

export const gcpSecretManagerProvider = createGcpSecretManagerProvider();
