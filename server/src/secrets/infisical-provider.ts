import type { DeploymentMode, SecretProviderConfigDiscoveryPreviewResult } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";
import {
  asOptionalNonEmptyString,
  assertAllowedProject,
  assertAllowedSiteUrl,
  assertEnvironmentSlug,
  deploymentSiteUrl,
  formatInfisicalExternalRef,
  InfisicalHttpGateway,
  infisicalSafeMessage,
  missingCredentialEnv,
  normalizeInfisicalError,
  normalizeInfisicalSecretPath,
  normalizeSiteUrl,
  parseInfisicalExternalRef,
  sha256Hex,
  type InfisicalConfig,
  type InfisicalGateway,
  type InfisicalRawSecret,
  type InfisicalSecretRef,
} from "./infisical-client.js";
import type {
  PreparedSecretVersion,
  RemoteSecretListResult,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretProviderValidationResult,
  SecretProviderVaultRuntimeConfig,
  StoredSecretVersionMaterial,
} from "./types.js";
import { SecretProviderClientError } from "./types.js";

export {
  InfisicalHttpGateway,
  formatInfisicalExternalRef,
  parseInfisicalExternalRef,
  resetInfisicalTokenCache,
} from "./infisical-client.js";

const INFISICAL_SCHEME = "infisical_v1";
const PROVIDER_CONFIG_DISCOVERY_SAMPLE_LIMIT = 3;
const PROVIDER_CONFIG_DISCOVERY_CANDIDATE_LIMIT = 6;
const INFISICAL_CREDENTIAL_WARNING =
  "Infisical machine identity credentials must be available to the Paperclip server runtime through PAPERCLIP_SECRETS_INFISICAL_CLIENT_ID and PAPERCLIP_SECRETS_INFISICAL_CLIENT_SECRET (Universal Auth).";
const INFISICAL_CREDENTIAL_CUSTODY_WARNING =
  "Do not store Infisical client secrets or access tokens in Paperclip company_secrets or provider vault config; the Infisical bootstrap identity belongs in deployment infrastructure or the process environment.";

interface InfisicalMaterial extends StoredSecretVersionMaterial {
  scheme: typeof INFISICAL_SCHEME;
  source: "external_reference";
  secretPath: string;
  secretKey: string;
  environment: string;
  version: string | null;
  lastWrittenVersion?: string | null;
}

function readProviderVaultConfig(input: SecretProviderVaultRuntimeConfig): InfisicalConfig {
  if (input.provider !== "infisical") {
    throw unprocessable("Infisical provider received a mismatched provider vault");
  }
  if (input.status === "disabled") {
    throw unprocessable("Infisical provider vault is disabled");
  }
  if (input.status === "coming_soon") {
    throw unprocessable("Infisical provider vault runtime is locked while coming soon");
  }
  const projectId = asOptionalNonEmptyString(input.config.projectId);
  const environment = asOptionalNonEmptyString(input.config.environment);
  const missing = [
    ...(projectId ? [] : ["projectId"]),
    ...(environment ? [] : ["environment"]),
  ];
  if (missing.length > 0 || !projectId || !environment) {
    throw unprocessable(`Infisical provider vault requires non-secret config: ${missing.join(", ")}`);
  }
  const configuredSiteUrl = asOptionalNonEmptyString(input.config.siteUrl);
  const siteUrl = configuredSiteUrl ? normalizeSiteUrl(configuredSiteUrl) : deploymentSiteUrl();
  assertAllowedSiteUrl(siteUrl);
  assertAllowedProject(projectId);
  return {
    siteUrl,
    projectId,
    environment: assertEnvironmentSlug(environment),
    secretPath: normalizeInfisicalSecretPath(asOptionalNonEmptyString(input.config.secretPath)),
  };
}

function getDeploymentConfigReadiness() {
  const projectId = process.env.PAPERCLIP_SECRETS_INFISICAL_PROJECT_ID?.trim();
  const environment = process.env.PAPERCLIP_SECRETS_INFISICAL_ENVIRONMENT?.trim();
  const missingConfig: string[] = [];
  if (!projectId) missingConfig.push("PAPERCLIP_SECRETS_INFISICAL_PROJECT_ID");
  if (!environment) missingConfig.push("PAPERCLIP_SECRETS_INFISICAL_ENVIRONMENT");
  return { projectId: projectId || null, environment: environment || null, missingConfig };
}

function loadDeploymentConfig(): InfisicalConfig {
  const readiness = getDeploymentConfigReadiness();
  if (readiness.missingConfig.length > 0 || !readiness.projectId || !readiness.environment) {
    throw unprocessable(
      `Infisical provider requires a provider vault or non-secret config: ${readiness.missingConfig.join(", ")}`,
    );
  }
  assertAllowedProject(readiness.projectId);
  return {
    siteUrl: deploymentSiteUrl(),
    projectId: readiness.projectId,
    environment: assertEnvironmentSlug(readiness.environment),
    secretPath: normalizeInfisicalSecretPath(process.env.PAPERCLIP_SECRETS_INFISICAL_SECRET_PATH),
  };
}

function createExternalReferenceMaterial(
  ref: InfisicalSecretRef,
  providerVersionRef: string | null,
): PreparedSecretVersion {
  const externalRef = formatInfisicalExternalRef(ref);
  const version = providerVersionRef?.trim() || null;
  if (version !== null && !/^[1-9]\d*$/.test(version)) {
    throw unprocessable("Infisical provider version must be a positive integer secret version");
  }
  const fingerprint = sha256Hex(`${INFISICAL_SCHEME}:${externalRef}:${version ?? ""}`);
  const material: InfisicalMaterial = {
    scheme: INFISICAL_SCHEME,
    source: "external_reference",
    secretPath: ref.secretPath,
    secretKey: ref.secretKey,
    environment: ref.environment,
    version,
  };
  return {
    material,
    valueSha256: fingerprint,
    fingerprintSha256: fingerprint,
    externalRef,
    providerVersionRef: version,
  };
}

function asInfisicalMaterial(value: StoredSecretVersionMaterial): InfisicalMaterial {
  if (
    value &&
    typeof value === "object" &&
    value.scheme === INFISICAL_SCHEME &&
    value.source === "external_reference" &&
    typeof value.secretPath === "string" &&
    typeof value.secretKey === "string" &&
    typeof value.environment === "string" &&
    (typeof value.version === "string" || value.version === null)
  ) {
    return value as InfisicalMaterial;
  }
  throw unprocessable("Invalid Infisical secret material");
}
function folderOf(entry: InfisicalRawSecret, fallback: string): string {
  try {
    return normalizeInfisicalSecretPath(entry.secretPath ?? fallback);
  } catch {
    return fallback;
  }
}

function tagSlugs(entry: InfisicalRawSecret): string[] {
  return (entry.tags ?? [])
    .map((tag) => tag.slug?.trim() || tag.name?.trim() || "")
    .filter(Boolean)
    .sort();
}

function remoteSecretMetadata(entry: InfisicalRawSecret, config: InfisicalConfig): Record<string, unknown> {
  return {
    secretPath: folderOf(entry, config.secretPath),
    environment: entry.environment ?? config.environment,
    version: typeof entry.version === "number" ? entry.version : null,
    hasComment: Boolean(entry.secretComment),
    tagCount: Array.isArray(entry.tags) ? entry.tags.length : 0,
  };
}

function matchesQuery(entry: InfisicalRawSecret, folder: string, query: string | null) {
  if (!query) return true;
  const needle = query.toLowerCase();
  return (entry.secretKey ?? "").toLowerCase().includes(needle) || folder.toLowerCase().includes(needle);
}

function parseOffsetToken(nextToken: string | null | undefined): number {
  const raw = nextToken?.trim();
  if (!raw) return 0;
  if (!/^\d+$/.test(raw)) throw unprocessable("Invalid Infisical list page token");
  return Number(raw);
}

function clampPageSize(pageSize: number | undefined, fallback: number) {
  return pageSize && Number.isFinite(pageSize)
    ? Math.min(Math.max(Math.trunc(pageSize), 1), 100)
    : fallback;
}

function discoverInfisicalProviderConfigCandidates(input: {
  config: InfisicalConfig;
  draftConfig: Record<string, unknown>;
  entries: InfisicalRawSecret[];
  nextToken: string | null;
}): SecretProviderConfigDiscoveryPreviewResult {
  const groups = new Map<string, Array<{ key: string; tags: string[] }>>();
  for (const entry of input.entries) {
    const key = entry.secretKey?.trim();
    if (!key) continue;
    const folder = folderOf(entry, input.config.secretPath);
    groups.set(folder, [...(groups.get(folder) ?? []), { key, tags: tagSlugs(entry) }]);
  }
  const sampledSecretCount = [...groups.values()].reduce((total, group) => total + group.length, 0);
  const draftSiteUrl = asOptionalNonEmptyString(input.draftConfig.siteUrl);

  const candidates = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
    .slice(0, PROVIDER_CONFIG_DISCOVERY_CANDIDATE_LIMIT)
    .map(([folder, group]) => {
      const warnings: string[] = [];
      if (folder === "/") {
        warnings.push("Secrets live at the project root; consider a dedicated folder such as /paperclip for Paperclip-brokered credentials.");
      }
      return {
        provider: "infisical" as const,
        displayName: `Infisical ${input.config.environment} ${folder}`,
        config: {
          siteUrl: draftSiteUrl ? input.config.siteUrl : null,
          projectId: input.config.projectId,
          environment: input.config.environment,
          secretPath: folder,
        },
        sampleCount: group.length,
        samples: group.slice(0, PROVIDER_CONFIG_DISCOVERY_SAMPLE_LIMIT).map((sample) => ({
          name: sample.key,
          hasKmsKey: false,
          tagKeys: sample.tags,
        })),
        signals: {
          namespace: folder,
          secretNamePrefix: null,
          environmentTag: input.config.environment,
          ownerTag: null,
          kmsKeyId: null,
          hasKmsKey: false,
          sampleCount: group.length,
          paperclipManagedSampleCount: 0,
          skippedForeignPaperclipSampleCount: 0,
        },
        warnings,
      };
    });

  const warnings: string[] = [];
  if (sampledSecretCount === 0) {
    warnings.push("Infisical returned no secrets for this project, environment, and secret path.");
  }
  if (groups.size > PROVIDER_CONFIG_DISCOVERY_CANDIDATE_LIMIT) {
    warnings.push("Additional Infisical folders were omitted from this preview; narrow the secret path or query to inspect them.");
  }
  return {
    provider: "infisical",
    nextToken: input.nextToken,
    sampledSecretCount,
    skippedForeignPaperclipSampleCount: 0,
    candidates,
    warnings,
  };
}

export function createInfisicalProvider(
  options?: {
    config?: InfisicalConfig;
    gateway?: InfisicalGateway;
  },
): SecretProviderModule {
  function resolveConfig(providerConfig?: SecretProviderVaultRuntimeConfig | null) {
    if (providerConfig) return readProviderVaultConfig(providerConfig);
    return options?.config ?? loadDeploymentConfig();
  }

  function resolveGateway(config: InfisicalConfig) {
    return options?.gateway ?? new InfisicalHttpGateway(config.siteUrl);
  }

  function resolveRef(config: InfisicalConfig, externalRef: string) {
    return parseInfisicalExternalRef(externalRef, {
      secretPath: config.secretPath,
      environment: config.environment,
    });
  }

  async function listEntries(config: InfisicalConfig, operation: string) {
    try {
      return await resolveGateway(config).listSecrets({
        projectId: config.projectId,
        environment: config.environment,
        secretPath: config.secretPath,
        recursive: true,
      });
    } catch (error) {
      normalizeInfisicalError(operation, error);
    }
  }

  async function validateConfig(
    input?: {
      deploymentMode?: DeploymentMode;
      strictMode?: boolean;
      providerConfig?: SecretProviderVaultRuntimeConfig | null;
    },
  ): Promise<SecretProviderValidationResult> {
    const warnings: string[] = [];
    if (input?.deploymentMode === "authenticated" && input.strictMode !== true) {
      warnings.push("Strict secret mode should be enabled for authenticated deployments");
    }
    resolveConfig(input?.providerConfig);
    const missing = missingCredentialEnv();
    if (missing.length > 0 && !options?.gateway) {
      warnings.push(`Missing Infisical machine identity environment: ${missing.join(", ")}`);
    }
    return { ok: true, warnings };
  }

  async function healthCheck(
    input?: {
      deploymentMode?: DeploymentMode;
      strictMode?: boolean;
      providerConfig?: SecretProviderVaultRuntimeConfig | null;
    },
  ): Promise<SecretProviderHealthCheck> {
    const missingCredentials = options?.gateway ? [] : missingCredentialEnv();
    let config: InfisicalConfig;
    try {
      config = resolveConfig(input?.providerConfig);
    } catch (error) {
      const readiness = getDeploymentConfigReadiness();
      const missingConfig = input?.providerConfig
        ? ["projectId", "environment"].filter((key) => !asOptionalNonEmptyString(input.providerConfig?.config[key]))
        : readiness.missingConfig;
      return {
        provider: "infisical",
        status: "warn",
        message:
          missingConfig.length > 0
            ? `Infisical provider is not ready: missing ${missingConfig.join(", ")}.`
            : error instanceof Error
              ? error.message
              : String(error),
        warnings: [
          ...(missingCredentials.length > 0
            ? [`Missing Infisical machine identity environment: ${missingCredentials.join(", ")}.`]
            : []),
          INFISICAL_CREDENTIAL_WARNING,
          INFISICAL_CREDENTIAL_CUSTODY_WARNING,
          "Linked Infisical references cannot be resolved until provider configuration is complete.",
        ],
        details: {
          missingConfig,
          missingCredentials,
          requiredProviderConfig: input?.providerConfig
            ? ["projectId", "environment"]
            : ["PAPERCLIP_SECRETS_INFISICAL_PROJECT_ID", "PAPERCLIP_SECRETS_INFISICAL_ENVIRONMENT"],
          optionalProviderConfig: [
            "PAPERCLIP_SECRETS_INFISICAL_SITE_URL",
            "PAPERCLIP_SECRETS_INFISICAL_SECRET_PATH",
            "PAPERCLIP_SECRETS_INFISICAL_ALLOWED_PROJECT_IDS",
          ],
          credentialSource: "Infisical Universal Auth machine identity",
        },
      };
    }

    const details = {
      siteUrl: config.siteUrl,
      projectId: config.projectId,
      environment: config.environment,
      secretPath: config.secretPath,
      credentialSource: "Infisical Universal Auth machine identity",
    };

    if (missingCredentials.length > 0) {
      return {
        provider: "infisical",
        status: "warn",
        message: `Infisical provider is not ready: missing ${missingCredentials.join(", ")}.`,
        warnings: [INFISICAL_CREDENTIAL_WARNING, INFISICAL_CREDENTIAL_CUSTODY_WARNING],
        details: { ...details, missingCredentials },
      };
    }

    if (!input?.providerConfig) {
      return {
        provider: "infisical",
        status: "ok",
        message: "Infisical provider config and machine identity credentials are present.",
        warnings: [],
        details,
      };
    }

    try {
      await resolveGateway(config).listSecrets({
        projectId: config.projectId,
        environment: config.environment,
        secretPath: config.secretPath,
        recursive: false,
      });
      return {
        provider: "infisical",
        status: "ok",
        message: `Infisical machine identity can read ${config.environment}:${config.secretPath} in project ${config.projectId}.`,
        warnings: [],
        details,
        backupGuidance: [
          "Back up Paperclip metadata separately from Infisical; Infisical remains the source of truth for linked values.",
        ],
      };
    } catch (error) {
      const code = error instanceof SecretProviderClientError ? error.code : "provider_error";
      const message = error instanceof SecretProviderClientError
        ? error.message
        : infisicalSafeMessage("provider_error");
      return {
        provider: "infisical",
        status: "error",
        message,
        warnings: code === "access_denied"
          ? [
              "Verify the machine identity client ID/secret and that the identity is a member of this project with read access to the environment and secret path.",
            ]
          : [],
        details: { ...details, code },
      };
    }
  }

  return {
    id: "infisical",
    descriptor() {
      return {
        id: "infisical" as const,
        label: "Infisical",
        requiresExternalRef: true,
        supportsManagedValues: false,
        supportsExternalReferences: true,
        supportsExternalValueWrites: true,
        configured: missingCredentialEnv().length === 0,
      };
    },
    validateConfig,
    async createSecret() {
      throw unprocessable(
        "Infisical provider only links existing Infisical secrets; create the secret in Infisical and link it as an external reference",
      );
    },
    async createVersion() {
      throw unprocessable(
        "Infisical provider only links existing Infisical secrets; update the value in Infisical or via the linked secret",
      );
    },
    async linkExternalSecret(input) {
      const config = resolveConfig(input.providerConfig);
      return createExternalReferenceMaterial(
        resolveRef(config, input.externalRef),
        input.providerVersionRef ?? null,
      );
    },
    async updateExternalSecretValue(input) {
      const config = resolveConfig(input.providerConfig);
      const ref = resolveRef(config, input.externalRef);
      try {
        const updated = await resolveGateway(config).updateSecret({
          projectId: config.projectId,
          environment: ref.environment,
          secretPath: ref.secretPath,
          secretKey: ref.secretKey,
          secretValue: input.value,
        });
        const prepared = createExternalReferenceMaterial(ref, null);
        const valueSha256 = sha256Hex(input.value);
        return {
          ...prepared,
          material: {
            ...prepared.material,
            lastWrittenVersion: typeof updated.version === "number" ? String(updated.version) : null,
          },
          valueSha256,
          fingerprintSha256: valueSha256,
        };
      } catch (error) {
        normalizeInfisicalError("updateExternalSecretValue", error);
      }
    },
    async listRemoteSecrets(input): Promise<RemoteSecretListResult> {
      const config = resolveConfig(input.providerConfig);
      const query = input.query?.trim() || null;
      const pageSize = clampPageSize(input.pageSize, 50);
      const offset = parseOffsetToken(input.nextToken);
      const entries = await listEntries(config, "listSecrets");
      const matches = entries
        .filter((entry) => Boolean(entry.secretKey?.trim()))
        .map((entry) => ({ entry, folder: folderOf(entry, config.secretPath) }))
        .filter(({ entry, folder }) => matchesQuery(entry, folder, query))
        .sort((a, b) =>
          a.folder.localeCompare(b.folder) || (a.entry.secretKey ?? "").localeCompare(b.entry.secretKey ?? ""));
      const page = matches.slice(offset, offset + pageSize);
      return {
        nextToken: offset + pageSize < matches.length ? String(offset + pageSize) : null,
        secrets: page.map(({ entry, folder }) => {
          const ref = {
            secretPath: folder,
            secretKey: (entry.secretKey ?? "").trim(),
            environment: entry.environment?.trim() || config.environment,
          };
          return {
            externalRef: formatInfisicalExternalRef(ref),
            name: folder === "/" ? ref.secretKey : `${folder}/${ref.secretKey}`,
            providerVersionRef: null,
            metadata: remoteSecretMetadata(entry, config),
          };
        }),
      };
    },
    async discoverProviderConfigs(input): Promise<SecretProviderConfigDiscoveryPreviewResult> {
      const config = resolveConfig(input.providerConfig);
      const query = input.query?.trim() || null;
      const pageSize = clampPageSize(input.pageSize, 100);
      const offset = parseOffsetToken(input.nextToken);
      const entries = (await listEntries(config, "discoverProviderConfigs"))
        .filter((entry) => matchesQuery(entry, folderOf(entry, config.secretPath), query));
      return discoverInfisicalProviderConfigCandidates({
        config,
        draftConfig: input.providerConfig.config,
        entries: entries.slice(offset, offset + pageSize),
        nextToken: offset + pageSize < entries.length ? String(offset + pageSize) : null,
      });
    },
    async resolveVersion(input) {
      const config = resolveConfig(input.providerConfig);
      const material = asInfisicalMaterial(input.material);
      const ref = input.externalRef
        ? resolveRef(config, input.externalRef)
        : { secretPath: material.secretPath, secretKey: material.secretKey, environment: material.environment };
      const version = input.providerVersionRef?.trim() || material.version || null;
      try {
        const secret = await resolveGateway(config).getSecret({
          projectId: config.projectId,
          environment: ref.environment,
          secretPath: ref.secretPath,
          secretKey: ref.secretKey,
          version,
        });
        if (typeof secret.secretValue !== "string") {
          throw new SecretProviderClientError({
            code: "provider_error",
            provider: "infisical",
            operation: "resolveVersion",
            message: infisicalSafeMessage("provider_error"),
            rawMessage: "Infisical secret response did not include secretValue",
          });
        }
        return secret.secretValue;
      } catch (error) {
        normalizeInfisicalError("resolveVersion", error);
      }
    },
    async deleteOrArchive() {
    },
    healthCheck,
  };
}

export const infisicalProvider = createInfisicalProvider();
