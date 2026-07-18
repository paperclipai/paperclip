import { createHash } from "node:crypto";
import type { DeploymentMode } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import type {
  PreparedSecretVersion,
  SecretProviderClientErrorCode,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretProviderValidationResult,
  SecretProviderVaultRuntimeConfig,
  StoredSecretVersionMaterial,
} from "./types.js";
import { SecretProviderClientError } from "./types.js";

// Data-plane read + external-reference provider for Oracle Cloud Infrastructure (OCI) Vault.
//
// Scope: resolve secret values that were provisioned in an OCI Vault out-of-band (Terraform,
// the OCI console/CLI, or another pipeline). Paperclip stores only an opaque external reference
// (the OCI secret name or OCID) plus a fingerprint; the plaintext value is fetched at dispatch
// time via the OCI Secret Retrieval API and never persisted by Paperclip.
//
// Credentials follow the OCI credential model, never Paperclip company_secrets. The default is
// instance principals (the runtime's compute instance is a member of a dynamic group granted
// `read secret-family`); a config-file profile is supported for local development only.
const OCI_VAULT_SCHEME = "oci_vault_v1";
const DEFAULT_AUTH_MODE = "instance_principal";
const OCI_STAGE_VALUES = new Set(["CURRENT", "PENDING", "LATEST", "PREVIOUS", "DEPRECATED"]);
const OCI_RUNTIME_CREDENTIAL_WARNING =
  "OCI credentials must be available to the Paperclip server runtime through the OCI credential model: instance principals (recommended), resource principals, or a local ~/.oci/config profile for development. This provider never reads OCI credentials from Paperclip company_secrets.";
const OCI_CREDENTIAL_CUSTODY_WARNING =
  "Do not store OCI private keys, API signing keys, or auth tokens in Paperclip company_secrets; the OCI provider bootstrap belongs in deployment infrastructure (instance/resource principals) or a local OCI config profile.";

type OciAuthMode = "instance_principal" | "config_file";

interface OciVaultConfig {
  region: string;
  vaultId: string;
  compartmentId: string | null;
  secretNamePrefix: string;
  authMode: OciAuthMode;
  configFilePath: string | null;
  configProfile: string | null;
}

interface OciVaultMaterial extends StoredSecretVersionMaterial {
  scheme: typeof OCI_VAULT_SCHEME;
  secretRef: string;
  versionRef: string | null;
  source: "external_reference";
}

interface OciVaultBundle {
  secretId: string | null;
  versionNumber: number | null;
  versionName: string | null;
  content: string | null;
  contentType: string | null;
}

interface OciSecretVersionSelector {
  versionNumber?: number;
  secretVersionName?: string;
  stage?: string;
}

// The gateway isolates every OCI SDK call behind a small, hand-written surface so tests inject a
// fake and never touch the network or the real SDK. The production gateway lazily imports the SDK.
export interface OciVaultGateway {
  getSecretBundleByName(
    input: { secretName: string; vaultId: string } & OciSecretVersionSelector,
  ): Promise<OciVaultBundle>;
  getSecretBundleById?(
    input: { secretId: string } & OciSecretVersionSelector,
  ): Promise<OciVaultBundle>;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function asOptionalNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function isOcid(ref: string): boolean {
  return /^ocid1\.[a-z0-9]+\./i.test(ref.trim());
}

function normalizeAuthMode(raw: string | null | undefined): OciAuthMode {
  const value = raw?.trim().toLowerCase();
  return value === "config_file" ? "config_file" : DEFAULT_AUTH_MODE;
}

function readAuthEnv(): Pick<OciVaultConfig, "authMode" | "configFilePath" | "configProfile"> {
  return {
    authMode: normalizeAuthMode(process.env.PAPERCLIP_SECRETS_OCI_AUTH),
    configFilePath: asOptionalNonEmptyString(process.env.PAPERCLIP_SECRETS_OCI_CONFIG_FILE),
    configProfile: asOptionalNonEmptyString(process.env.PAPERCLIP_SECRETS_OCI_CONFIG_PROFILE),
  };
}

function getOciConfigReadiness() {
  const region = asOptionalNonEmptyString(process.env.PAPERCLIP_SECRETS_OCI_REGION);
  const vaultId =
    asOptionalNonEmptyString(process.env.PAPERCLIP_SECRETS_OCI_VAULT_ID) ??
    asOptionalNonEmptyString(process.env.PAPERCLIP_SECRETS_OCI_VAULT_OCID);
  const missingConfig: string[] = [];
  if (!region) missingConfig.push("PAPERCLIP_SECRETS_OCI_REGION");
  if (!vaultId) missingConfig.push("PAPERCLIP_SECRETS_OCI_VAULT_ID");
  return {
    missingConfig,
    region,
    vaultId,
    credentialSources: describeDetectedOciCredentialSources(),
  };
}

function describeDetectedOciCredentialSources(): string[] {
  const sources: string[] = [];
  const authMode = normalizeAuthMode(process.env.PAPERCLIP_SECRETS_OCI_AUTH);
  if (authMode === "config_file") {
    const path = asOptionalNonEmptyString(process.env.PAPERCLIP_SECRETS_OCI_CONFIG_FILE);
    sources.push(path ? `OCI config file (${path})` : "OCI config file (~/.oci/config)");
  } else {
    sources.push("OCI instance principals");
  }
  return sources;
}

function loadOciVaultConfig(): OciVaultConfig {
  const readiness = getOciConfigReadiness();
  if (readiness.missingConfig.length > 0) {
    throw unprocessable(
      `OCI Vault provider requires non-secret config: ${readiness.missingConfig.join(", ")}`,
    );
  }
  return {
    region: readiness.region as string,
    vaultId: readiness.vaultId as string,
    compartmentId: asOptionalNonEmptyString(process.env.PAPERCLIP_SECRETS_OCI_COMPARTMENT_ID),
    secretNamePrefix:
      asOptionalNonEmptyString(process.env.PAPERCLIP_SECRETS_OCI_SECRET_NAME_PREFIX) ?? "",
    ...readAuthEnv(),
  };
}

function readProviderVaultConfig(input: SecretProviderVaultRuntimeConfig): OciVaultConfig {
  if (input.provider !== "oci_vault") {
    throw unprocessable("OCI Vault provider received a mismatched provider vault");
  }
  if (input.status === "disabled") {
    throw unprocessable("OCI Vault provider vault is disabled");
  }
  if (input.status === "coming_soon") {
    throw unprocessable("OCI Vault provider vault runtime is locked while coming soon");
  }
  const region = asOptionalNonEmptyString(input.config.region);
  if (!region) {
    throw unprocessable("OCI Vault provider vault requires non-secret config: region");
  }
  const vaultId = asOptionalNonEmptyString(input.config.vaultId);
  if (!vaultId) {
    throw unprocessable("OCI Vault provider vault requires non-secret config: vaultId");
  }
  return {
    region,
    vaultId,
    compartmentId: asOptionalNonEmptyString(input.config.compartmentId),
    secretNamePrefix: asOptionalNonEmptyString(input.config.secretNamePrefix) ?? "",
    ...readAuthEnv(),
  };
}

function assertAllowedSecretName(config: OciVaultConfig, ref: string): void {
  if (!config.secretNamePrefix) return;
  if (isOcid(ref)) return; // OCIDs are already vault-scoped; the name prefix guards name lookups.
  if (!ref.startsWith(config.secretNamePrefix)) {
    throw unprocessable(
      `OCI Vault secret name "${ref}" is outside the configured secretNamePrefix "${config.secretNamePrefix}"`,
    );
  }
}

function buildVersionSelector(versionRef: string | null | undefined): OciSecretVersionSelector {
  const value = versionRef?.trim();
  if (!value) return { stage: "CURRENT" };
  if (/^\d+$/.test(value)) return { versionNumber: Number(value) };
  const upper = value.toUpperCase();
  if (OCI_STAGE_VALUES.has(upper)) return { stage: upper };
  return { secretVersionName: value };
}

function decodeSecretBundleContent(bundle: OciVaultBundle, operation: string): string {
  if (typeof bundle.content !== "string" || bundle.content.length === 0) {
    throw new SecretProviderClientError({
      code: "not_found",
      provider: "oci_vault",
      operation,
      message: ociProviderSafeMessage("not_found"),
      rawMessage: "OCI secret bundle contained no content",
    });
  }
  // OCI Vault secret bundle content is base64-encoded (contentType BASE64).
  if (!bundle.contentType || bundle.contentType.toUpperCase() === "BASE64") {
    return Buffer.from(bundle.content, "base64").toString("utf8");
  }
  return bundle.content;
}

function createExternalReferenceMaterial(
  externalRef: string,
  providerVersionRef: string | null,
): PreparedSecretVersion {
  const normalizedExternalRef = externalRef.trim();
  const normalizedProviderVersionRef = providerVersionRef?.trim() || null;
  const fingerprint = sha256Hex(
    `${OCI_VAULT_SCHEME}:${normalizedExternalRef}:${normalizedProviderVersionRef ?? ""}`,
  );
  const material: OciVaultMaterial = {
    scheme: OCI_VAULT_SCHEME,
    secretRef: normalizedExternalRef,
    versionRef: normalizedProviderVersionRef,
    source: "external_reference",
  };
  return {
    material,
    valueSha256: fingerprint,
    fingerprintSha256: fingerprint,
    externalRef: normalizedExternalRef,
    providerVersionRef: normalizedProviderVersionRef,
  };
}

function asOciVaultMaterial(value: StoredSecretVersionMaterial): OciVaultMaterial {
  if (
    value &&
    typeof value === "object" &&
    value.scheme === OCI_VAULT_SCHEME &&
    typeof value.secretRef === "string" &&
    (typeof value.versionRef === "string" || value.versionRef === null) &&
    value.source === "external_reference"
  ) {
    return value as OciVaultMaterial;
  }
  throw unprocessable("Invalid OCI Vault material");
}

function ociErrorStatusCode(error: unknown): number | null {
  if (error && typeof error === "object" && "statusCode" in error) {
    const status = (error as { statusCode?: unknown }).statusCode;
    if (typeof status === "number" && Number.isFinite(status)) return status;
  }
  return null;
}

export function classifyOciProviderError(
  message: string,
  statusCode?: number | null,
): SecretProviderClientErrorCode {
  if (statusCode != null) {
    if (statusCode === 401 || statusCode === 403) return "access_denied";
    if (statusCode === 404) return "not_found";
    if (statusCode === 409) return "conflict";
    if (statusCode === 429) return "throttled";
    if (statusCode === 400 || statusCode === 422) return "invalid_request";
    if (statusCode === 500 || statusCode === 502 || statusCode === 503 || statusCode === 504) {
      return "provider_unavailable";
    }
  }
  if (/NotAuthenticated|NotAuthorizedOrNotFound|NotAuthorized|Forbidden|not authorized/i.test(message)) {
    // NotAuthorizedOrNotFound is OCI's ambiguous 404-for-403; treat as access_denied so operators
    // check the dynamic-group policy first (a missing read grant is the common cause).
    return "access_denied";
  }
  if (/NotFound|SecretNotFound|does not exist/i.test(message)) return "not_found";
  if (/TooManyRequests|Throttl|Rate exceeded|429/i.test(message)) return "throttled";
  if (/Conflict|AlreadyExists|IncorrectState/i.test(message)) return "conflict";
  if (/InvalidParameter|ValidationError|InvalidRequest|400/i.test(message)) return "invalid_request";
  if (/ECONN|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|network|timeout|socket hang up/i.test(message)) {
    return "provider_unavailable";
  }
  return "provider_error";
}

export function ociProviderSafeMessage(code: SecretProviderClientErrorCode): string {
  switch (code) {
    case "access_denied":
      return "OCI Vault denied the request. Check the instance/resource principal's dynamic-group policy for read secret-family on this vault.";
    case "throttled":
      return "OCI Vault throttled the request. Wait and try again.";
    case "not_found":
      return "OCI Vault could not find the requested secret.";
    case "conflict":
      return "OCI Vault reported a conflicting secret state.";
    case "invalid_request":
      return "OCI Vault rejected the request.";
    case "provider_unavailable":
      return "OCI Vault is unavailable right now.";
    case "provider_error":
    default:
      return "OCI Vault request failed.";
  }
}

function normalizeOciError(operation: string, error: unknown): never {
  if (error instanceof SecretProviderClientError) throw error;
  const rawMessage = error instanceof Error ? error.message : String(error);
  const statusCode = ociErrorStatusCode(error);
  const code = classifyOciProviderError(rawMessage, statusCode);
  throw new SecretProviderClientError({
    code,
    provider: "oci_vault",
    operation,
    message: ociProviderSafeMessage(code),
    status: statusCode ?? undefined,
    rawMessage,
    cause: error,
  });
}

// --- Production gateway (lazy SDK import; never loaded by unit tests) --------------------------

interface CachedOciClient {
  regionId: string;
  authMode: OciAuthMode;
  configFilePath: string | null;
  configProfile: string | null;
  // Typed as unknown to avoid a hard dependency on the SDK's compiled types at module load.
  client: unknown;
  pending: Promise<unknown> | null;
}

const ociClientCache = new Map<string, CachedOciClient>();

function ociClientCacheKey(config: OciVaultConfig): string {
  return [config.authMode, config.region, config.configFilePath ?? "", config.configProfile ?? ""].join("\0");
}

async function buildOciAuthProvider(config: OciVaultConfig): Promise<unknown> {
  const common = await import("oci-common");
  if (config.authMode === "config_file") {
    return new common.ConfigFileAuthenticationDetailsProvider(
      config.configFilePath ?? undefined,
      config.configProfile ?? undefined,
    );
  }
  return new common.InstancePrincipalsAuthenticationDetailsProviderBuilder().build();
}

async function getOciSecretsClient(config: OciVaultConfig): Promise<{
  getSecretBundleByName(request: Record<string, unknown>): Promise<{ secretBundle?: unknown }>;
  getSecretBundle(request: Record<string, unknown>): Promise<{ secretBundle?: unknown }>;
}> {
  const key = ociClientCacheKey(config);
  let cached = ociClientCache.get(key);
  if (!cached) {
    cached = {
      regionId: config.region,
      authMode: config.authMode,
      configFilePath: config.configFilePath,
      configProfile: config.configProfile,
      client: null,
      pending: null,
    };
    ociClientCache.set(key, cached);
  }
  if (cached.client) return cached.client as never;
  if (cached.pending) return (await cached.pending) as never;

  cached.pending = (async () => {
    const { SecretsClient } = await import("oci-secrets");
    const authenticationDetailsProvider = await buildOciAuthProvider(config);
    // Construct with the SDK's default client configuration (timeouts + retry/backoff). Passing a
    // custom `httpOptions` object here breaks the SDK's response handling ("response.text is not a
    // function"); the OCI SDK manages its own HTTP client and sane defaults, so we don't override it.
    const client = new SecretsClient({
      authenticationDetailsProvider: authenticationDetailsProvider as never,
    });
    client.regionId = config.region;
    cached!.client = client;
    return client;
  })().finally(() => {
    if (cached) cached.pending = null;
  });

  return (await cached.pending) as never;
}

function mapSecretBundle(secretBundle: unknown): OciVaultBundle {
  const bundle = (secretBundle ?? {}) as Record<string, unknown>;
  const content = (bundle.secretBundleContent ?? {}) as Record<string, unknown>;
  return {
    secretId: asOptionalNonEmptyString(bundle.secretId),
    versionNumber: typeof bundle.versionNumber === "number" ? bundle.versionNumber : null,
    versionName: asOptionalNonEmptyString(bundle.versionName),
    content: typeof content.content === "string" ? content.content : null,
    contentType: asOptionalNonEmptyString(content.contentType),
  };
}

class OciVaultSdkGateway implements OciVaultGateway {
  constructor(private readonly config: OciVaultConfig) {}

  async getSecretBundleByName(
    input: { secretName: string; vaultId: string } & OciSecretVersionSelector,
  ): Promise<OciVaultBundle> {
    const client = await getOciSecretsClient(this.config);
    const response = await client.getSecretBundleByName({
      secretName: input.secretName,
      vaultId: input.vaultId,
      versionNumber: input.versionNumber,
      secretVersionName: input.secretVersionName,
      stage: input.stage,
    });
    return mapSecretBundle(response.secretBundle);
  }

  async getSecretBundleById(
    input: { secretId: string } & OciSecretVersionSelector,
  ): Promise<OciVaultBundle> {
    const client = await getOciSecretsClient(this.config);
    const response = await client.getSecretBundle({
      secretId: input.secretId,
      versionNumber: input.versionNumber,
      secretVersionName: input.secretVersionName,
      stage: input.stage,
    });
    return mapSecretBundle(response.secretBundle);
  }
}

// --- Provider module --------------------------------------------------------------------------

function configuredOciVaultDescriptor() {
  return {
    id: "oci_vault" as const,
    label: "OCI Vault",
    requiresExternalRef: true,
    supportsManagedValues: false,
    supportsExternalReferences: true,
    configured: getOciConfigReadiness().missingConfig.length === 0,
  };
}

export function createOciVaultProvider(options?: {
  config?: OciVaultConfig;
  gateway?: OciVaultGateway;
}): SecretProviderModule {
  function resolveConfig(providerConfig?: SecretProviderVaultRuntimeConfig | null): OciVaultConfig {
    if (providerConfig) return readProviderVaultConfig(providerConfig);
    return options?.config ?? loadOciVaultConfig();
  }

  function resolveGateway(config: OciVaultConfig): OciVaultGateway {
    return options?.gateway ?? new OciVaultSdkGateway(config);
  }

  async function validateConfig(input?: {
    deploymentMode?: DeploymentMode;
    strictMode?: boolean;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<SecretProviderValidationResult> {
    const warnings: string[] = [];
    if (input?.deploymentMode === "authenticated" && input.strictMode !== true) {
      warnings.push("Strict secret mode should be enabled for authenticated deployments");
    }
    const config = resolveConfig(input?.providerConfig);
    if (!config.secretNamePrefix) {
      warnings.push(
        "PAPERCLIP_SECRETS_OCI_SECRET_NAME_PREFIX (or provider vault secretNamePrefix) should be set to scope resolvable secret names",
      );
    }
    return { ok: true, warnings };
  }

  async function healthCheck(input?: {
    deploymentMode?: DeploymentMode;
    strictMode?: boolean;
    providerConfig?: SecretProviderVaultRuntimeConfig | null;
  }): Promise<SecretProviderHealthCheck> {
    try {
      const validation = await validateConfig(input);
      const config = resolveConfig(input?.providerConfig);
      const readiness = getOciConfigReadiness();
      return {
        provider: "oci_vault",
        status: validation.warnings.length > 0 ? "warn" : "ok",
        message:
          "OCI Vault provider config is present; OCI credentials are resolved by the server runtime through the OCI credential model (instance principals by default).",
        warnings: validation.warnings,
        details: {
          region: config.region,
          vaultId: config.vaultId,
          compartmentId: config.compartmentId,
          secretNamePrefix: config.secretNamePrefix || null,
          authMode: config.authMode,
          credentialSource:
            config.authMode === "config_file" ? "OCI config file" : "OCI instance principals",
          detectedCredentialSources: readiness.credentialSources,
        },
        backupGuidance: [
          "Back up Paperclip metadata separately from OCI Vault secrets.",
          "Restoring access requires the Paperclip database plus read access to the same OCI Vault and secret names.",
        ],
      };
    } catch (error) {
      const readiness = getOciConfigReadiness();
      const providerConfigMissing: string[] = [];
      if (input?.providerConfig) {
        if (!asOptionalNonEmptyString(input.providerConfig.config.region)) {
          providerConfigMissing.push("region");
        }
        if (!asOptionalNonEmptyString(input.providerConfig.config.vaultId)) {
          providerConfigMissing.push("vaultId");
        }
      }
      const missingConfig = input?.providerConfig ? providerConfigMissing : readiness.missingConfig;
      return {
        provider: "oci_vault",
        status: "warn",
        message:
          missingConfig.length > 0
            ? `OCI Vault provider is not ready: missing ${missingConfig.join(", ")}.`
            : error instanceof Error
              ? error.message
              : String(error),
        warnings: [
          ...(missingConfig.length > 0
            ? [`Missing required non-secret OCI provider config: ${missingConfig.join(", ")}.`]
            : []),
          OCI_RUNTIME_CREDENTIAL_WARNING,
          OCI_CREDENTIAL_CUSTODY_WARNING,
          "External-reference resolution will fail until OCI provider configuration is complete.",
        ],
        details: {
          missingConfig,
          requiredProviderConfig: input?.providerConfig
            ? ["region", "vaultId"]
            : ["PAPERCLIP_SECRETS_OCI_REGION", "PAPERCLIP_SECRETS_OCI_VAULT_ID"],
          optionalProviderConfig: [
            "PAPERCLIP_SECRETS_OCI_COMPARTMENT_ID",
            "PAPERCLIP_SECRETS_OCI_SECRET_NAME_PREFIX",
            "PAPERCLIP_SECRETS_OCI_AUTH",
            "PAPERCLIP_SECRETS_OCI_CONFIG_FILE",
            "PAPERCLIP_SECRETS_OCI_CONFIG_PROFILE",
          ],
          credentialSource: "OCI credential model (instance principals by default)",
          detectedCredentialSources: readiness.credentialSources,
        },
      };
    }
  }

  return {
    id: "oci_vault",
    descriptor() {
      return configuredOciVaultDescriptor();
    },
    validateConfig,
    async createSecret() {
      throw unprocessable(
        "OCI Vault provider stores external references to pre-provisioned secrets; managed values are not supported. Link an existing OCI Vault secret as an external reference instead.",
      );
    },
    async createVersion() {
      throw unprocessable(
        "OCI Vault provider does not create managed secret versions. Rotate the secret in OCI Vault and re-link the external reference.",
      );
    },
    async linkExternalSecret(input) {
      const config = resolveConfig(input.providerConfig);
      const externalRef = input.externalRef.trim();
      if (!externalRef) {
        throw unprocessable("OCI Vault external reference requires a secret name or OCID");
      }
      assertAllowedSecretName(config, externalRef);
      return createExternalReferenceMaterial(externalRef, input.providerVersionRef ?? null);
    },
    async resolveVersion(input) {
      const config = resolveConfig(input.providerConfig);
      const gateway = resolveGateway(config);
      const material = asOciVaultMaterial(input.material);
      const ref = (input.externalRef ?? material.secretRef).trim();
      if (!ref) {
        throw unprocessable("OCI Vault external reference is missing a secret name or OCID");
      }
      assertAllowedSecretName(config, ref);
      const selector = buildVersionSelector(input.providerVersionRef ?? material.versionRef);

      try {
        let bundle: OciVaultBundle;
        if (isOcid(ref)) {
          if (!gateway.getSecretBundleById) {
            throw new Error("OCI Vault gateway cannot resolve secrets by OCID");
          }
          bundle = await gateway.getSecretBundleById({ secretId: ref, ...selector });
        } else {
          bundle = await gateway.getSecretBundleByName({
            secretName: ref,
            vaultId: config.vaultId,
            ...selector,
          });
        }
        return decodeSecretBundleContent(bundle, "resolveVersion");
      } catch (error) {
        normalizeOciError("resolveVersion", error);
      }
    },
    async deleteOrArchive() {
      // OCI Vault external references are metadata-only in Paperclip; the underlying secret's
      // lifecycle is owned by OCI Vault (Terraform/console/CLI), so there is nothing to delete here.
    },
    healthCheck,
  };
}

export const ociVaultProvider = createOciVaultProvider();
