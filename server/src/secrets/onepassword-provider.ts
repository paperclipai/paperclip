import { createHash } from "node:crypto";
import {
  AuthExpiredError,
  RateLimitExceededError,
  createClient,
  ItemCategory,
  ItemFieldType,
  type Item,
  type ItemCreateParams,
  type ItemField,
} from "@1password/sdk";
import { unprocessable } from "../errors.js";
import type {
  PreparedSecretVersion,
  RemoteSecretListResult,
  SecretProviderClientErrorCode,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretProviderValidationResult,
  SecretProviderVaultRuntimeConfig,
  SecretProviderWriteContext,
  StoredSecretVersionMaterial,
} from "./types.js";
import { SecretProviderClientError } from "./types.js";

const ONEPASSWORD_SCHEME = "onepassword_item_v1";
const DEFAULT_FIELD_ID = "paperclip_value";
const DEFAULT_FIELD_TITLE = "value";
const MANAGED_TAG = "paperclip-managed";
const COMPANY_TAG_PREFIX = "paperclip-company:";
const SECRET_KEY_TAG_PREFIX = "paperclip-secret:";
const INTEGRATION_NAME = "Paperclip";
const INTEGRATION_VERSION = "1.0.0";

interface OnePasswordConfig {
  vaultId: string;
  fieldId: string;
  itemTitlePrefix: string;
}

export interface OnePasswordItemsGateway {
  create(params: ItemCreateParams): Promise<Item>;
  get(vaultId: string, itemId: string): Promise<Item>;
  put(item: Item): Promise<Item>;
  delete(vaultId: string, itemId: string): Promise<void>;
  archive(vaultId: string, itemId: string): Promise<void>;
  list(vaultId: string): Promise<Array<{ id: string; title: string; category: string; tags: string[] }>>;
}

interface OnePasswordMaterial extends StoredSecretVersionMaterial {
  scheme: typeof ONEPASSWORD_SCHEME;
  vaultId: string;
  itemId: string;
  fieldId: string;
  source: "managed" | "external_reference";
}

function asOptionalNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function configuredOnePasswordDescriptor() {
  return {
    id: "onepassword" as const,
    label: "1Password",
    requiresExternalRef: false,
    supportsManagedValues: true,
    supportsExternalReferences: true,
    supportsExternalValueWrites: true,
    configured: Boolean(process.env.OP_SERVICE_ACCOUNT_TOKEN?.trim()),
  };
}

function readProviderVaultConfig(input: SecretProviderVaultRuntimeConfig): OnePasswordConfig {
  if (input.provider !== "onepassword") {
    throw unprocessable("1Password provider received a mismatched provider vault");
  }
  if (input.status === "disabled") {
    throw unprocessable("1Password provider vault is disabled");
  }
  if (input.status === "coming_soon") {
    throw unprocessable("1Password provider vault runtime is locked while coming soon");
  }
  const vaultId = asOptionalNonEmptyString(input.config.vaultId);
  if (!vaultId) {
    throw unprocessable("1Password provider vault requires non-secret config: vaultId");
  }
  return {
    vaultId,
    fieldId: asOptionalNonEmptyString(input.config.fieldId) ?? DEFAULT_FIELD_ID,
    itemTitlePrefix: asOptionalNonEmptyString(input.config.itemTitlePrefix) ?? "paperclip",
  };
}

function loadOnePasswordConfigFromEnv(): OnePasswordConfig {
  const vaultId = process.env.PAPERCLIP_SECRETS_ONEPASSWORD_VAULT_ID?.trim();
  if (!vaultId) {
    throw unprocessable(
      "1Password provider requires PAPERCLIP_SECRETS_ONEPASSWORD_VAULT_ID or a provider vault config",
    );
  }
  return {
    vaultId,
    fieldId: process.env.PAPERCLIP_SECRETS_ONEPASSWORD_FIELD_ID?.trim() || DEFAULT_FIELD_ID,
    itemTitlePrefix: process.env.PAPERCLIP_SECRETS_ONEPASSWORD_PREFIX?.trim() || "paperclip",
  };
}

function getOnePasswordConfigReadiness() {
  const missingConfig: string[] = [];
  if (!process.env.OP_SERVICE_ACCOUNT_TOKEN?.trim()) {
    missingConfig.push("OP_SERVICE_ACCOUNT_TOKEN");
  }
  if (!process.env.PAPERCLIP_SECRETS_ONEPASSWORD_VAULT_ID?.trim()) {
    missingConfig.push("PAPERCLIP_SECRETS_ONEPASSWORD_VAULT_ID (or a provider vault config)");
  }
  return { missingConfig };
}

function itemTitle(config: OnePasswordConfig, context: SecretProviderWriteContext | undefined): string {
  if (!context) {
    throw unprocessable("1Password provider requires secret context for managed values");
  }
  return `${config.itemTitlePrefix}/${context.companyId}/${context.secretKey}`;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function classifyOnePasswordError(error: unknown): SecretProviderClientErrorCode {
  if (error instanceof AuthExpiredError) return "access_denied";
  if (error instanceof RateLimitExceededError) return "throttled";
  const message = error instanceof Error ? error.message : String(error);
  if (/not[\s_-]?found/i.test(message)) return "not_found";
  if (/forbidden|unauthorized|access[\s_-]?denied|permission/i.test(message)) return "access_denied";
  if (/rate[\s_-]?limit|too many requests/i.test(message)) return "throttled";
  if (/already exists|conflict/i.test(message)) return "conflict";
  if (/invalid|validation/i.test(message)) return "invalid_request";
  if (/network|timeout|ECONN|ENOTFOUND|unreachable/i.test(message)) return "provider_unavailable";
  return "provider_error";
}

function onePasswordSafeMessage(code: SecretProviderClientErrorCode): string {
  switch (code) {
    case "access_denied":
      return "1Password denied the request. Check the service account token's vault permissions.";
    case "throttled":
      return "1Password throttled the request. Wait and try again.";
    case "not_found":
      return "1Password could not find the requested item.";
    case "conflict":
      return "1Password reported that the requested item already exists.";
    case "invalid_request":
      return "1Password rejected the request.";
    case "provider_unavailable":
      return "1Password is unavailable right now.";
    case "provider_error":
    default:
      return "1Password request failed.";
  }
}

function normalizeOnePasswordError(operation: string, error: unknown): never {
  const code = classifyOnePasswordError(error);
  const rawMessage = error instanceof Error ? error.message : String(error);
  throw new SecretProviderClientError({
    code,
    provider: "onepassword",
    operation,
    message: onePasswordSafeMessage(code),
    rawMessage,
    cause: error,
  });
}

function asOnePasswordMaterial(value: StoredSecretVersionMaterial): OnePasswordMaterial {
  if (
    value &&
    typeof value === "object" &&
    value.scheme === ONEPASSWORD_SCHEME &&
    typeof value.vaultId === "string" &&
    typeof value.itemId === "string" &&
    typeof value.fieldId === "string" &&
    (value.source === "managed" || value.source === "external_reference")
  ) {
    return value as OnePasswordMaterial;
  }
  throw unprocessable("Invalid 1Password material");
}

// externalRef format: "<vaultId>/<itemId>" or "<vaultId>/<itemId>#<fieldId>"
function parseExternalRef(externalRef: string, defaultFieldId: string): { vaultId: string; itemId: string; fieldId: string } {
  const trimmed = externalRef.trim();
  const [path, fieldId] = trimmed.split("#");
  const [vaultId, itemId] = (path ?? "").split("/");
  if (!vaultId || !itemId) {
    throw unprocessable(
      "1Password externalRef must be in the form <vaultId>/<itemId> or <vaultId>/<itemId>#<fieldId>",
    );
  }
  return { vaultId, itemId, fieldId: fieldId?.trim() || defaultFieldId };
}

function buildExternalRef(material: OnePasswordMaterial): string {
  return `${material.vaultId}/${material.itemId}#${material.fieldId}`;
}

function findField(item: Item, fieldId: string): ItemField | undefined {
  return item.fields.find((field) => field.id === fieldId);
}

function managedTagsFor(context: SecretProviderWriteContext): string[] {
  return [MANAGED_TAG, `${COMPANY_TAG_PREFIX}${context.companyId}`, `${SECRET_KEY_TAG_PREFIX}${context.secretKey}`];
}

function isForeignManagedItem(item: Item, context: SecretProviderWriteContext | undefined): boolean {
  if (!item.tags.includes(MANAGED_TAG)) return false;
  if (!context) return true;
  return !item.tags.includes(`${COMPANY_TAG_PREFIX}${context.companyId}`);
}

export function createOnePasswordProvider(
  options?: {
    config?: OnePasswordConfig;
    gateway?: OnePasswordItemsGateway;
  },
): SecretProviderModule {
  let cachedGateway: Promise<OnePasswordItemsGateway> | null = null;

  function resolveConfig(providerConfig?: SecretProviderVaultRuntimeConfig | null): OnePasswordConfig {
    if (providerConfig) return readProviderVaultConfig(providerConfig);
    return options?.config ?? loadOnePasswordConfigFromEnv();
  }

  async function resolveGateway(): Promise<OnePasswordItemsGateway> {
    if (options?.gateway) return options.gateway;
    if (!cachedGateway) {
      const token = process.env.OP_SERVICE_ACCOUNT_TOKEN?.trim();
      if (!token) {
        throw unprocessable("1Password provider requires OP_SERVICE_ACCOUNT_TOKEN");
      }
      cachedGateway = createClient({
        auth: token,
        integrationName: INTEGRATION_NAME,
        integrationVersion: INTEGRATION_VERSION,
      }).then((client) => client.items);
    }
    return cachedGateway;
  }

  async function validateConfig(
    input?: { providerConfig?: SecretProviderVaultRuntimeConfig | null },
  ): Promise<SecretProviderValidationResult> {
    const warnings: string[] = [];
    try {
      resolveConfig(input?.providerConfig);
    } catch (error) {
      return { ok: false, warnings: [error instanceof Error ? error.message : String(error)] };
    }
    if (!process.env.OP_SERVICE_ACCOUNT_TOKEN?.trim() && !options?.gateway) {
      warnings.push("OP_SERVICE_ACCOUNT_TOKEN is not set on this server process");
    }
    return { ok: true, warnings };
  }

  async function healthCheck(
    input?: { providerConfig?: SecretProviderVaultRuntimeConfig | null },
  ): Promise<SecretProviderHealthCheck> {
    try {
      const config = resolveConfig(input?.providerConfig);
      const readiness = getOnePasswordConfigReadiness();
      const warnings: string[] = [];
      if (readiness.missingConfig.length > 0 && !input?.providerConfig) {
        warnings.push(`Missing required config: ${readiness.missingConfig.join(", ")}.`);
      }
      warnings.push(
        "1Password versions whole items, not individual fields. A version bump on a sibling field looks like rotation on the Paperclip-tracked field too.",
      );
      return {
        provider: "onepassword",
        status: warnings.length > 1 ? "warn" : "ok",
        message: "1Password provider config is present; the service account token is resolved from OP_SERVICE_ACCOUNT_TOKEN.",
        warnings,
        details: {
          vaultId: config.vaultId,
          fieldId: config.fieldId,
        },
        backupGuidance: [
          "Back up Paperclip metadata separately from 1Password-managed items.",
          "Restoring access requires the Paperclip database plus the same 1Password vault and service account grant.",
        ],
      };
    } catch (error) {
      return {
        provider: "onepassword",
        status: "warn",
        message: error instanceof Error ? error.message : String(error),
        warnings: [
          "Managed secret create/rotate/resolve calls will fail until the 1Password provider configuration is complete.",
        ],
        details: { missingConfig: getOnePasswordConfigReadiness().missingConfig },
      };
    }
  }

  return {
    id: "onepassword",
    descriptor() {
      return configuredOnePasswordDescriptor();
    },
    validateConfig,
    async createSecret(input) {
      const config = resolveConfig(input.providerConfig);
      const gateway = await resolveGateway();
      const valueSha256 = sha256Hex(input.value);

      try {
        const created = await gateway.create({
          category: ItemCategory.ApiCredentials,
          vaultId: config.vaultId,
          title: itemTitle(config, input.context),
          fields: [
            {
              id: config.fieldId,
              title: DEFAULT_FIELD_TITLE,
              fieldType: ItemFieldType.Concealed,
              value: input.value,
            },
          ],
          tags: input.context ? managedTagsFor(input.context) : [],
        });
        const material: OnePasswordMaterial = {
          scheme: ONEPASSWORD_SCHEME,
          vaultId: config.vaultId,
          itemId: created.id,
          fieldId: config.fieldId,
          source: "managed",
        };
        return {
          material,
          valueSha256,
          fingerprintSha256: valueSha256,
          externalRef: buildExternalRef(material),
          providerVersionRef: String(created.version),
        };
      } catch (error) {
        normalizeOnePasswordError("createSecret", error);
      }
    },
    async createVersion(input) {
      const config = resolveConfig(input.providerConfig);
      const gateway = await resolveGateway();
      const valueSha256 = sha256Hex(input.value);
      if (!input.externalRef) {
        throw unprocessable("1Password createVersion requires an existing item externalRef");
      }
      const { vaultId, itemId, fieldId } = parseExternalRef(input.externalRef, config.fieldId);

      try {
        const existing = await gateway.get(vaultId, itemId);
        if (isForeignManagedItem(existing, input.context)) {
          throw unprocessable(
            "1Password managed item ref drifted outside the derived company scope",
          );
        }
        const field = findField(existing, fieldId);
        const nextFields = field
          ? existing.fields.map((candidate) =>
              candidate.id === fieldId ? { ...candidate, value: input.value } : candidate,
            )
          : [
              ...existing.fields,
              { id: fieldId, title: DEFAULT_FIELD_TITLE, fieldType: ItemFieldType.Concealed, value: input.value },
            ];
        const updated = await gateway.put({ ...existing, fields: nextFields });
        const material: OnePasswordMaterial = {
          scheme: ONEPASSWORD_SCHEME,
          vaultId,
          itemId: updated.id,
          fieldId,
          source: "managed",
        };
        return {
          material,
          valueSha256,
          fingerprintSha256: valueSha256,
          externalRef: buildExternalRef(material),
          providerVersionRef: String(updated.version),
        };
      } catch (error) {
        if (error instanceof SecretProviderClientError || (error as { status?: number })?.status === 422) throw error;
        normalizeOnePasswordError("createVersion", error);
      }
    },
    async linkExternalSecret(input) {
      const config = resolveConfig(input.providerConfig);
      const gateway = await resolveGateway();
      const { vaultId, itemId, fieldId } = parseExternalRef(input.externalRef, config.fieldId);

      try {
        const item = await gateway.get(vaultId, itemId);
        if (isForeignManagedItem(item, input.context)) {
          throw unprocessable("1Password Paperclip-managed items from another company cannot be imported as external references");
        }
        const field = findField(item, fieldId);
        const fingerprintSource = field ? sha256Hex(field.value) : sha256Hex(`${vaultId}:${itemId}:${fieldId}`);
        const material: OnePasswordMaterial = {
          scheme: ONEPASSWORD_SCHEME,
          vaultId,
          itemId,
          fieldId,
          source: "external_reference",
        };
        return {
          material,
          valueSha256: fingerprintSource,
          fingerprintSha256: fingerprintSource,
          externalRef: buildExternalRef(material),
          providerVersionRef: input.providerVersionRef?.trim() || String(item.version),
        };
      } catch (error) {
        if (error instanceof SecretProviderClientError || (error as { status?: number })?.status === 422) throw error;
        normalizeOnePasswordError("linkExternalSecret", error);
      }
    },
    async updateExternalSecretValue(input) {
      const gateway = await resolveGateway();
      const { vaultId, itemId, fieldId } = parseExternalRef(input.externalRef, DEFAULT_FIELD_ID);

      try {
        const existing = await gateway.get(vaultId, itemId);
        if (isForeignManagedItem(existing, input.context)) {
          throw unprocessable("1Password Paperclip-managed items from another company cannot be written through as external references");
        }
        const field = findField(existing, fieldId);
        const nextFields = field
          ? existing.fields.map((candidate) =>
              candidate.id === fieldId ? { ...candidate, value: input.value } : candidate,
            )
          : [
              ...existing.fields,
              { id: fieldId, title: DEFAULT_FIELD_TITLE, fieldType: ItemFieldType.Concealed, value: input.value },
            ];
        const updated = await gateway.put({ ...existing, fields: nextFields });
        const material: OnePasswordMaterial = {
          scheme: ONEPASSWORD_SCHEME,
          vaultId,
          itemId: updated.id,
          fieldId,
          source: "external_reference",
        };
        const valueSha256 = sha256Hex(input.value);
        return {
          material,
          valueSha256,
          fingerprintSha256: valueSha256,
          externalRef: buildExternalRef(material),
          providerVersionRef: String(updated.version),
        };
      } catch (error) {
        if (error instanceof SecretProviderClientError || (error as { status?: number })?.status === 422) throw error;
        normalizeOnePasswordError("updateExternalSecretValue", error);
      }
    },
    async listRemoteSecrets(input): Promise<RemoteSecretListResult> {
      const config = resolveConfig(input.providerConfig);
      const gateway = await resolveGateway();

      try {
        const items = await gateway.list(config.vaultId);
        const query = input.query?.trim().toLowerCase();
        const filtered = query ? items.filter((item) => item.title.toLowerCase().includes(query)) : items;
        const pageSize =
          input.pageSize && Number.isFinite(input.pageSize)
            ? Math.min(Math.max(Math.trunc(input.pageSize), 1), 100)
            : 50;
        return {
          nextToken: null,
          secrets: filtered.slice(0, pageSize).map((item) => ({
            externalRef: `${config.vaultId}/${item.id}#${config.fieldId}`,
            name: item.title,
            providerVersionRef: null,
            metadata: {
              category: item.category,
              tags: item.tags,
            },
          })),
        };
      } catch (error) {
        normalizeOnePasswordError("listSecrets", error);
      }
    },
    async resolveVersion(input) {
      const material = asOnePasswordMaterial(input.material);
      const gateway = await resolveGateway();
      const { vaultId, itemId, fieldId } =
        input.externalRef && input.externalRef.trim()
          ? parseExternalRef(input.externalRef, material.fieldId)
          : material;

      try {
        const item = await gateway.get(vaultId, itemId);
        const requestedVersionRef = input.providerVersionRef?.trim();
        if (requestedVersionRef && requestedVersionRef !== String(item.version)) {
          throw new SecretProviderClientError({
            code: "conflict",
            provider: "onepassword",
            operation: "resolveVersion",
            message:
              "The requested 1Password item version is no longer current. 1Password does not expose historical item versions through this API; only the latest value can be resolved.",
          });
        }
        const field = findField(item, fieldId);
        if (!field) {
          throw new SecretProviderClientError({
            code: "not_found",
            provider: "onepassword",
            operation: "resolveVersion",
            message: "1Password could not find the requested item field.",
          });
        }
        return field.value;
      } catch (error) {
        if (error instanceof SecretProviderClientError) throw error;
        normalizeOnePasswordError("resolveVersion", error);
      }
    },
    async deleteOrArchive(input) {
      const material =
        input.material && typeof input.material === "object" ? asOnePasswordMaterial(input.material) : null;
      if (!material) return;
      if (material.source === "external_reference") {
        // External references are metadata-only in Paperclip; 1Password does not expose a
        // historical-version rollback API, so there is nothing to revert here.
        return;
      }

      const gateway = await resolveGateway();
      try {
        if (input.mode === "archive") {
          await gateway.archive(material.vaultId, material.itemId);
        } else {
          await gateway.delete(material.vaultId, material.itemId);
        }
      } catch (error) {
        normalizeOnePasswordError(input.mode === "archive" ? "archive" : "delete", error);
      }
    },
    healthCheck,
  };
}

export const onePasswordProvider = createOnePasswordProvider();
