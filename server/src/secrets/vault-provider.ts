import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import type {
  PreparedSecretVersion,
  SecretProviderClientErrorCode,
  SecretProviderHealthCheck,
  SecretProviderModule,
  SecretProviderRuntimeContext,
  SecretProviderValidationResult,
  SecretProviderVaultRuntimeConfig,
  SecretProviderWriteContext,
  StoredSecretVersionMaterial,
} from "./types.js";
import { SecretProviderClientError } from "./types.js";
import { unprocessable } from "../errors.js";
import {
  asString,
  DEFAULT_SA_TOKEN_PATH,
  DEFAULT_VAULT_HTTP_TIMEOUT_MS,
  HttpVaultGateway,
  TOKEN_EXPIRY_SKEW_MS,
  TOKEN_RENEWAL_THRESHOLD,
  VaultTokenManager,
  detectVaultAuthSource,
  resolveVaultHttpTimeoutMs,
  withVaultTokenRetry,
} from "./vault-token.js";
import type { VaultAuthSource, VaultHttpGateway } from "./vault-token.js";

export {
  asString,
  DEFAULT_SA_TOKEN_PATH,
  DEFAULT_VAULT_HTTP_TIMEOUT_MS,
  HttpVaultGateway,
  TOKEN_EXPIRY_SKEW_MS,
  TOKEN_RENEWAL_THRESHOLD,
  VaultTokenManager,
  detectVaultAuthSource,
  resolveVaultHttpTimeoutMs,
  withVaultTokenRetry,
};
export type { VaultAuthSource, VaultHttpGateway };

import { logger } from "../middleware/logger.js";

export const VAULT_MATERIAL_SCHEME = "vault_kv_v2";
export const DEFAULT_KV_MOUNT = "secret";
export const DEFAULT_KV_PATH_PREFIX = "paperclip";
export const DEFAULT_VERSION_RETENTION = 10;
export const MIN_VERSION_RETENTION = 2;
export const MAX_VERSION_RETENTION = 100;

const CREDENTIAL_FIELD_DENYLIST = [
  "token",
  "password",
  "roleid",
  "secretid",
  "unsealkey",
  "clientcert",
  "privatekey",
  "accesskeyid",
  "secretaccesskey",
  "serviceaccountjson",
  "keyfile",
];

export interface VaultProviderConfig {
  address: string;
  namespace: string | null;
  kvMount: string;
  kvPathPrefix: string;
  auth: {
    method: "kubernetes" | "token" | "approle";
    role: string | null;
    saTokenPath: string;
  };
  versionRetention: number;
}

export interface ParsedExternalRef {
  mount: string;
  path: string;
  dataKey: string;
}

export function parseExternalRef(raw: string): ParsedExternalRef {
  if (!raw || raw === "/") throw unprocessable("vault external ref is empty");
  const [pathPart, dataKey = "value"] = raw.split("#", 2);
  const segments = pathPart.split("/").filter((s) => s.length > 0);
  if (segments.length < 2) {
    throw unprocessable(
      `vault external ref must be '<mount>/<path>[#<dataKey>]'; got ${raw}`,
    );
  }
  const [mount, ...rest] = segments;
  if (!KV_MOUNT_PATTERN.test(mount) || /^\.+$/.test(mount)) {
    throw unprocessable(
      `vault external ref mount must match [A-Za-z0-9._-] and not be pure dots; got '${mount}'`,
    );
  }
  if (rest.some((s) => /^\.+$/.test(s))) {
    throw unprocessable(
      `vault external ref path must not contain pure-dot segments (e.g. '.', '..'); got ${raw}`,
    );
  }
  for (const segment of rest) {
    if (!KV_MOUNT_PATTERN.test(segment)) {
      throw unprocessable(
        `vault external ref path segments must match [A-Za-z0-9._-]; got segment '${segment}' in ${raw}`,
      );
    }
  }
  return { mount, path: rest.join("/"), dataKey };
}

export function buildManagedKvPath(input: {
  config: VaultProviderConfig;
  deploymentId: string;
  companyId: string;
  secretKey: string;
}): string {
  const segments = [input.config.kvPathPrefix, input.deploymentId, input.companyId, input.secretKey].filter((s) => s.length > 0);
  // Reject dot/empty segments so a key like `..` cannot collapse the path out
  // of the managed prefix (Vault KV treats `..` as a literal segment, but a
  // normalized path would escape it, and parseExternalRef would later reject
  // the stored ref). secretKey is restricted to [A-Za-z0-9_.-] so a `.`/`..`
  // segment is the only traversal vector.
  for (const s of segments) {
    if (s === "." || s === "..") {
      throw unprocessable(`vault managed path segment must not be '.' or '..'; got ${s}`);
    }
  }
  return segments.join("/");
}



function safeUrlOrigin(raw: string): string {
  try {
    return new URL(raw).origin;
  } catch {
    return raw;
  }
}

function validateAddress(raw: unknown, warnings: string[]): URL | null {
  const value = asString(raw);
  if (!value) {
    warnings.push("vault address is required (set vault config address, PAPERCLIP_SECRETS_VAULT_ADDR, or VAULT_ADDR)");
    return null;
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    warnings.push(`vault address is not a valid URL: ${value}`);
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    warnings.push(`vault address must use http(s); got ${parsed.protocol}`);
    return null;
  }
  if (parsed.username || parsed.password) {
    warnings.push("vault address must not embed credentials in the URL");
    return null;
  }
  if (parsed.pathname && parsed.pathname !== "/") {
    warnings.push(`vault address must be origin-only; got path ${parsed.pathname}`);
    return null;
  }
  if (parsed.search) {
    warnings.push("vault address must not include a query string");
    return null;
  }
  if (parsed.hash) {
    warnings.push("vault address must not include a fragment");
    return null;
  }
  return parsed;
}

const KV_MOUNT_PATTERN = /^[A-Za-z0-9._-]+$/;
const KV_PREFIX_PATTERN = /^[A-Za-z0-9._/-]+$/;
const NAMESPACE_PATTERN = /^[A-Za-z0-9._/-]+$/;
const ROLE_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

function validateKvMount(raw: unknown, warnings: string[]): string | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_KV_MOUNT;
  const value = asString(raw);
  if (!value) {
    warnings.push("kvMount must be a non-empty string");
    return null;
  }
  if (value.startsWith("/") || value.startsWith("data/")) {
    warnings.push(`kvMount must not start with '/' or 'data/'; got ${value}`);
    return null;
  }
  if (!KV_MOUNT_PATTERN.test(value)) {
    warnings.push(`kvMount must match [A-Za-z0-9._-]; got ${value}`);
    return null;
  }
  return value;
}

function validateKvPathPrefix(raw: unknown, warnings: string[]): string | null {
  if (raw === undefined || raw === null || raw === "") return DEFAULT_KV_PATH_PREFIX;
  const value = asString(raw);
  if (!value) {
    warnings.push("kvPathPrefix must be a non-empty string");
    return null;
  }
  if (value.startsWith("/")) {
    warnings.push(`kvPathPrefix must not start with '/'; got ${value}`);
    return null;
  }
  if (value.endsWith("/") || value.includes("//")) {
    warnings.push(`kvPathPrefix must not end with '/' or contain '//'; got ${value}`);
    return null;
  }
  if (value.split("/").some((s) => s === "." || s === "..")) {
    warnings.push(`kvPathPrefix must not contain '.' or '..' segments; got ${value}`);
    return null;
  }
  if (!KV_PREFIX_PATTERN.test(value)) {
    warnings.push(`kvPathPrefix must match [A-Za-z0-9._/-]; got ${value}`);
    return null;
  }
  return value;
}

function validateNamespace(raw: unknown, warnings: string[]): string | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const value = asString(raw);
  if (!value) {
    warnings.push("namespace must be a non-empty string");
    return null;
  }
  // namespace is injected into the x-vault-namespace header. undici rejects
  // CR/LF so a control character cannot smuggle a header, but a company
  // writer could still store a namespace that breaks its own requests; keep
  // it to the same safe character class as the other path fields.
  if (!NAMESPACE_PATTERN.test(value) || value.includes("\r") || value.includes("\n")) {
    warnings.push(`namespace must match [A-Za-z0-9._/-] with no control characters; got ${value}`);
    return null;
  }
  return value;
}

function validateAuthBlock(
  raw: unknown,
  warnings: string[],
): { method: "kubernetes" | "token" | "approle"; role: string | null; saTokenPath: string } | null {
  const block = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const methodRaw = asString(block.method);
  if (methodRaw && methodRaw !== "kubernetes" && methodRaw !== "token" && methodRaw !== "approle") {
    warnings.push(`auth.method must be 'kubernetes', 'token', or 'approle'; got ${methodRaw}`);
    return null;
  }
  const method = (methodRaw ?? "token") as "kubernetes" | "token" | "approle";
  const role = asString(block.role);
  if (method === "kubernetes") {
    if (!role) {
      warnings.push("auth.role is required when auth.method = 'kubernetes'");
      return null;
    }
    if (!ROLE_PATTERN.test(role)) {
      warnings.push(`auth.role must match [A-Za-z0-9_-]{1,128}; got ${role}`);
      return null;
    }
  }
  return {
    method,
    role,
    saTokenPath: asString(block.saTokenPath) ?? DEFAULT_SA_TOKEN_PATH,
  };
}

function validateVersionRetention(raw: unknown, warnings: string[]): number | null {
  if (raw === undefined || raw === null) return DEFAULT_VERSION_RETENTION;
  if (typeof raw !== "number" || !Number.isInteger(raw)) {
    warnings.push("versionRetention must be an integer");
    return null;
  }
  if (raw < MIN_VERSION_RETENTION || raw > MAX_VERSION_RETENTION) {
    warnings.push(
      `versionRetention must be between ${MIN_VERSION_RETENTION} and ${MAX_VERSION_RETENTION}; got ${raw}`,
    );
    return null;
  }
  return raw;
}

function validateNoCredentialFields(
  config: Record<string, unknown>,
  warnings: string[],
): void {
  for (const key of Object.keys(config)) {
    if (CREDENTIAL_FIELD_DENYLIST.includes(key.toLowerCase())) {
      warnings.push(
        `vault config must not contain credential-shaped field '${key}'; bootstrap credentials live in workload identity or VAULT_TOKEN env, never in vault config`,
      );
    }
  }
}

/**
 * Resolve one operator-pinned field with the same policy as the address: the
 * operator env value wins; a per-vault company-config value is honored only
 * when no operator pin is set AND the operator has opted in with
 * PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR=1; otherwise it is ignored and a
 * warning is emitted. Returns the effective raw value (or null), which the
 * caller validates (validators map null/undefined to their own default).
 */
function pinOperatorField(input: {
  operatorValue: string | undefined;
  configValue: string | null;
  allowConfig: boolean;
  label: string;
  envName: string;
  consequence: string;
  warnings: string[];
}): string | null {
  const { operatorValue, configValue, allowConfig, label, envName, consequence, warnings } = input;
  if (configValue === null) return operatorValue ?? null;
  if (operatorValue !== undefined) {
    if (configValue !== operatorValue) {
      warnings.push(
        `vault config ${label} is overridden by the operator-deployed ${label}; ` +
          `a per-vault ${label} cannot ${consequence}`,
      );
    }
    return operatorValue;
  }
  if (!allowConfig) {
    warnings.push(
      `vault config ${label} is ignored: no operator-pinned ${label} is set ` +
        `(${envName}) and the operator has not set PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR=1, ` +
        `so a company-config ${label} may not ${consequence}`,
    );
    return null;
  }
  return configValue;
}

/**
 * The deployment-wide managed prefix (mount + path prefix), resolved from
 * operator env only (never a company config). This is the boundary
 * `assertNotManagedOverlap` and `createVersion`'s managed-prefix check guard
 * against, so no per-vault company override of `mountPath`/`secretPathPrefix`
 * can relocate the boundary and make an external reference to another
 * company's managed path pass the guard.
 */
export function resolveDeploymentManagedPrefix(
  env: NodeJS.ProcessEnv = process.env,
): { mount: string; pathPrefix: string } {
  const warnings: string[] = [];
  const mount =
    validateKvMount(env.PAPERCLIP_SECRETS_VAULT_KV_MOUNT, warnings) ?? DEFAULT_KV_MOUNT;
  const pathPrefix =
    validateKvPathPrefix(env.PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX, warnings) ?? DEFAULT_KV_PATH_PREFIX;
  return { mount, pathPrefix };
}

export interface ResolvedVaultConfig {
  config: VaultProviderConfig | null;
  warnings: string[];
}

export function resolveVaultConfig(input: {
  env: NodeJS.ProcessEnv;
  providerConfig: SecretProviderVaultRuntimeConfig | null;
}): ResolvedVaultConfig {
  const warnings: string[] = [];
  const vaultConfig =
    (input.providerConfig?.config ?? {}) as Record<string, unknown>;

  validateNoCredentialFields(vaultConfig, warnings);

  // The address is the endpoint that receives the deployment's Vault bootstrap
  // credential (env VAULT_TOKEN, the k8s SA token, or
  // PAPERCLIP_SECRETS_VAULT_TOKEN_FILE), so — like the AWS provider's
  // PAPERCLIP_SECRETS_AWS_ENDPOINT — it is operator-controlled. Operator env
  // (PAPERCLIP_SECRETS_VAULT_ADDR, then the standard VAULT_ADDR set natively by
  // orchestrator Vault agents such as Nomad's) wins over any per-vault config
  // address: a company config may restate the operator address, or supply one
  // only when the operator set none, but it must not redirect the deployment
  // credential to a different host.
  const operatorAddress =
    input.env.PAPERCLIP_SECRETS_VAULT_ADDR ?? input.env.VAULT_ADDR;
  const configAddress = asString(vaultConfig.address);
  // A per-vault company-config address is only used to receive the
  // deployment's bootstrap credential when there is no operator pin. That is
  // an explicit, security-relevant fallback, so it is off by default: the
  // operator must set PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR=1 (or pin
  // PAPERCLIP_SECRETS_VAULT_ADDR / VAULT_ADDR) for a company-chosen host to
  // ever receive the credential. Otherwise a company writer could add a
  // config pointing at their own endpoint and read the token/JWT sent there.
  const allowConfigAddress = input.env.PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR === "1";
  const effectiveAddress =
    operatorAddress !== undefined
      ? operatorAddress
      : configAddress !== null && allowConfigAddress
        ? configAddress
        : undefined;
  const url = validateAddress(effectiveAddress, warnings);
  if (effectiveAddress === undefined && configAddress !== null && operatorAddress === undefined) {
    warnings.push(
      "vault config address is ignored: no operator-pinned address is set " +
        "(PAPERCLIP_SECRETS_VAULT_ADDR or VAULT_ADDR) and the operator has not set " +
        "PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR=1, so a company-config endpoint " +
        "may not receive the deployment's Vault credential",
    );
  }
  if (
    operatorAddress !== undefined &&
    configAddress !== null &&
    safeUrlOrigin(operatorAddress) !== safeUrlOrigin(configAddress)
  ) {
    warnings.push(
      "vault config address is overridden by the operator-deployed address; " +
        "a per-vault vault address cannot redirect the deployment's Vault credential to a different host",
    );
  }
  // kvMount/kvPathPrefix/namespace locate where Paperclip's *managed* secrets
  // live. They are operator-pinned for the same reason as the address: if a
  // company config could relocate the managed prefix, the external-reference
  // overlap guard (assertNotManagedOverlap) would be keyed on the company's
  // own prefix and a company writer could point an external_reference at
  // another company's managed path and read it with the shared deployment
  // token. So operator env wins; a company config value is honored only when
  // no operator pin is set AND the operator opted in with
  // PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR=1 (the same flag that gates the
  // address), otherwise it is ignored + warned.
  const operatorKvMount = asString(input.env.PAPERCLIP_SECRETS_VAULT_KV_MOUNT) ?? undefined;
  const configKvMount =
    asString(vaultConfig.mountPath) ?? asString(vaultConfig.kvMount);
  const kvMount = validateKvMount(
    pinOperatorField({
      operatorValue: operatorKvMount,
      configValue: configKvMount,
      allowConfig: allowConfigAddress,
      label: "mountPath",
      envName: "PAPERCLIP_SECRETS_VAULT_KV_MOUNT",
      consequence: "relocate the managed prefix",
      warnings,
    }),
    warnings,
  );
  const operatorKvPathPrefix =
    asString(input.env.PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX) ?? undefined;
  const configKvPathPrefix =
    asString(vaultConfig.secretPathPrefix) ?? asString(vaultConfig.kvPathPrefix);
  const kvPathPrefix = validateKvPathPrefix(
    pinOperatorField({
      operatorValue: operatorKvPathPrefix,
      configValue: configKvPathPrefix,
      allowConfig: allowConfigAddress,
      label: "secretPathPrefix",
      envName: "PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX",
      consequence: "relocate the managed prefix",
      warnings,
    }),
    warnings,
  );

  const authRaw = (vaultConfig.auth ?? null) as Record<string, unknown> | null;
  // When the company config carries an auth block it wins over env; otherwise
  // we fall back to the operator env values. (Preserves the prior behavior.)
  const authMerged: Record<string, unknown> = authRaw ?? {
    method: input.env.PAPERCLIP_SECRETS_VAULT_AUTH_METHOD,
    role: input.env.PAPERCLIP_SECRETS_VAULT_K8S_ROLE,
    saTokenPath: input.env.PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH,
  };
  let auth = validateAuthBlock(authMerged, warnings);
  // saTokenPath is a file the server reads and whose bytes are sent as the
  // k8s login JWT, so it is an information-disclosure primitive: an operator
  // may pin it, but a company config may only set a custom path when the
  // operator has opted in (same flag that gates the address), otherwise the
  // in-cluster default is used and a differing config value is ignored.
  const operatorSaTokenPath = input.env.PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH;
  const configSaTokenPath = authRaw ? asString((authRaw as Record<string, unknown>).saTokenPath) : null;
  if (auth) {
    if (operatorSaTokenPath !== undefined) {
      if (auth.saTokenPath !== operatorSaTokenPath) {
        if (configSaTokenPath !== null && configSaTokenPath !== operatorSaTokenPath) {
          warnings.push(
            "vault auth.saTokenPath is overridden by the operator-deployed path; " +
              "a per-vault saTokenPath cannot redirect which file the deployment reads as the JWT",
          );
        }
        auth = { ...auth, saTokenPath: operatorSaTokenPath };
      }
    } else if (configSaTokenPath !== null && configSaTokenPath !== DEFAULT_SA_TOKEN_PATH && !allowConfigAddress) {
      warnings.push(
        "vault auth.saTokenPath is ignored: no operator-pinned path is set " +
          "(PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH) and the operator has not set " +
          "PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR=1, so a company-config path may not " +
          "choose which file the deployment reads as the Vault login JWT",
      );
      auth = { ...auth, saTokenPath: DEFAULT_SA_TOKEN_PATH };
    }
  }
  // The Kubernetes role selects which Vault auth/kubernetes role the server's
  // login JWT is authenticated against, and different roles carry different
  // policies, so a company writer must not be able to swap the deployment's
  // login into a more privileged role. Operator env wins; a company-config role
  // is honored only under the same opt-in flag that gates the address.
  const operatorK8sRole = asString(input.env.PAPERCLIP_SECRETS_VAULT_K8S_ROLE) ?? undefined;
  const configK8sRole = authRaw ? asString((authRaw as Record<string, unknown>).role) : null;
  if (auth && auth.method === "kubernetes") {
    if (operatorK8sRole !== undefined) {
      if (auth.role !== operatorK8sRole) {
        if (configK8sRole !== null && configK8sRole !== operatorK8sRole) {
          warnings.push(
            "vault auth.role is overridden by the operator-deployed Kubernetes role; " +
              "a per-vault role cannot change which Vault auth role the deployment login uses",
          );
        }
        auth = { ...auth, role: operatorK8sRole };
      }
    } else if (configK8sRole !== null && !allowConfigAddress) {
      warnings.push(
        "vault auth.role is ignored: no operator-pinned role is set " +
          "(PAPERCLIP_SECRETS_VAULT_K8S_ROLE) and the operator has not set " +
          "PAPERCLIP_SECRETS_VAULT_ALLOW_CONFIG_ADDR=1, so a company-config role may not " +
          "choose which Vault auth role the deployment login uses",
      );
      // Kubernetes login requires a role; without an operator-approved role
      // the auth block is unusable, so fail closed rather than guessing.
      return { config: null, warnings };
    }
  }

  const versionRetentionRaw =
    vaultConfig.versionRetention !== undefined
      ? vaultConfig.versionRetention
      : input.env.PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION !== undefined
        ? parseInt(input.env.PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION, 10)
        : undefined;
  const versionRetention = validateVersionRetention(versionRetentionRaw, warnings);

  const pinnedNamespace = pinOperatorField({
      operatorValue: asString(input.env.PAPERCLIP_SECRETS_VAULT_NAMESPACE) ?? undefined,
      configValue: asString(vaultConfig.namespace),
      allowConfig: allowConfigAddress,
      label: "namespace",
      envName: "PAPERCLIP_SECRETS_VAULT_NAMESPACE",
      consequence: "change the Vault namespace the deployment credential targets",
      warnings,
    });
  const namespace = validateNamespace(pinnedNamespace, warnings);
  // A namespace that was supplied (operator pin or opted-in config) but fails
  // validation must not silently fall back to the root namespace: the gateway
  // omits x-vault-namespace when namespace is null, so reads and writes would
  // target root instead of the intended namespace. An ABSENT namespace is the
  // only valid null.
  if (pinnedNamespace !== null && namespace === null) {
    return { config: null, warnings };
  }

  if (!url || !kvMount || !kvPathPrefix || !auth || versionRetention === null) {
    return { config: null, warnings };
  }
  return {
    config: {
      address: url.origin,
      namespace,
      kvMount,
      kvPathPrefix,
      auth,
      versionRetention,
    },
    warnings,
  };
}


interface VaultManagedMaterial extends StoredSecretVersionMaterial {
  scheme: typeof VAULT_MATERIAL_SCHEME;
  source: "managed" | "external_reference";
  mount: string;
  path: string;
  dataKey: string;
  version: number | null;
}

function managedMaterial(input: {
  mount: string;
  path: string;
  version: number;
}): VaultManagedMaterial {
  return {
    scheme: VAULT_MATERIAL_SCHEME,
    source: "managed",
    mount: input.mount,
    path: input.path,
    dataKey: "value",
    version: input.version,
  };
}

function externalReferenceMaterial(ref: ParsedExternalRef): VaultManagedMaterial {
  return {
    scheme: VAULT_MATERIAL_SCHEME,
    source: "external_reference",
    mount: ref.mount,
    path: ref.path,
    dataKey: ref.dataKey,
    version: null,
  };
}

function assertNotManagedOverlap(
  managed: { mount: string; pathPrefix: string },
  ref: ParsedExternalRef,
): void {
  if (
    ref.mount === managed.mount &&
    (ref.path === managed.pathPrefix || ref.path.startsWith(`${managed.pathPrefix}/`))
  ) {
    throw unprocessable(
      `vault external ref overlaps Paperclip-managed prefix '${managed.mount}/${managed.pathPrefix}'`,
    );
  }
}

function fingerprintFromVersionAndPath(mount: string, path: string, version: number): string {
  return createHash("sha256").update(`${mount}/${path}@v${version}`).digest("hex");
}

export function createVaultProvider(
  options?: { config?: VaultProviderConfig; gateway?: VaultHttpGateway },
): SecretProviderModule {
  function readSaToken(path: string): string | null {
    try {
      if (!existsSync(path)) return null;
      return readFileSync(path, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  function resolveConfigWithWarnings(
    providerConfig?: SecretProviderVaultRuntimeConfig | null,
  ): { config: VaultProviderConfig; warnings: string[] } {
    if (options?.config) return { config: options.config, warnings: [] };
    const resolved = resolveVaultConfig({
      env: process.env,
      providerConfig: providerConfig ?? null,
    });
    if (!resolved.config) {
      throw unprocessable(
        `vault provider config invalid: ${resolved.warnings.join("; ")}`,
      );
    }
    // Warnings accompany a *usable* config too (e.g. an ignored company
    // mountPath/namespace): callers that only need the resolved config drop
    // them, but healthCheck surfaces them so a silently-ignored setting is
    // diagnosable instead of looking healthy.
    return { config: resolved.config, warnings: resolved.warnings };
  }

  function resolveConfig(providerConfig?: SecretProviderVaultRuntimeConfig | null): VaultProviderConfig {
    return resolveConfigWithWarnings(providerConfig).config;
  }

  // One (gateway, tokenManager) pair per unique vault config, cached for the
  // lifetime of the provider instance. Caching keeps `VaultTokenManager`'s
  // proactive renewal logic effective (without this, every method call would
  // construct a fresh token manager with an empty cache and re-run
  // `auth/kubernetes/login`). The gateway's `getToken` closure captures the
  // specific token manager for its vault, so concurrent operations against
  // different vaults cannot cross-contaminate authentication.
  interface VaultSession {
    gateway: VaultHttpGateway;
    tokenManager: VaultTokenManager;
  }
  const sessionCache = new Map<string, VaultSession>();

  function sessionCacheKey(config: VaultProviderConfig): string {
    return [
      config.address,
      config.namespace ?? "",
      config.kvMount,
      config.kvPathPrefix,
      config.auth.method,
      config.auth.role ?? "",
      config.auth.saTokenPath,
    ].join("|");
  }

  function getOrCreateSession(config: VaultProviderConfig): VaultSession {
    const key = sessionCacheKey(config);
    const cached = sessionCache.get(key);
    if (cached) return cached;
    const gateway: VaultHttpGateway =
      options?.gateway ??
      new HttpVaultGateway({
        address: config.address,
        namespace: config.namespace,
        getToken: () => tokenManager.acquire(),
      });
    const source = detectVaultAuthSource({ config, env: process.env, readSaToken });
    // A transient failure while detecting the auth source (e.g. the
    // in-cluster SA token file momentarily unreadable) must not be cached:
    // an error-mode session would otherwise pin the vault broken until the
    // provider restarts. Leave it out of the cache and let the next request
    // re-detect.
    if (source.mode === "error") {
      throw new Error(
        `vault auth source detection failed for ${config.address}: ${source.message}`,
      );
    }
    const tokenManager = new VaultTokenManager({ source, gateway });
    const session = { gateway, tokenManager };
    sessionCache.set(key, session);
    return session;
  }
  function deploymentId(): string {
    return process.env.PAPERCLIP_DEPLOYMENT_ID || "default";
  }

  return {
    id: "vault",
    descriptor() {
      return {
        id: "vault",
        label: "HashiCorp Vault / OpenBao",
        requiresExternalRef: false,
        supportsManagedValues: true,
        supportsExternalReferences: true,
        configured: true,
      };
    },
    async validateConfig(input) {
      const warnings: string[] = [];
      const rawConfig = (input?.providerConfig?.config ?? {}) as Record<string, unknown>;
      validateNoCredentialFields(rawConfig, warnings);
      validateAddress(rawConfig.address, warnings);
      // Validate the effective mount/prefix — canonical mountPath/secretPathPrefix
      // win, with kvMount/kvPathPrefix as legacy fallback — so an invalid
      // canonical config is flagged here rather than only in resolveVaultConfig.
      validateKvMount(rawConfig.mountPath ?? rawConfig.kvMount, warnings);
      validateKvPathPrefix(rawConfig.secretPathPrefix ?? rawConfig.kvPathPrefix, warnings);
      validateNamespace(rawConfig.namespace, warnings);
      validateAuthBlock(rawConfig.auth, warnings);
      validateVersionRetention(rawConfig.versionRetention, warnings);
      return { ok: warnings.length === 0, warnings };
    },
    async createSecret(input) {
      const config = resolveConfig(input.providerConfig);
      const { gateway, tokenManager } = getOrCreateSession(config);
      const ctx = input.context;
      if (!ctx) {
        throw unprocessable("vault createSecret requires SecretProviderWriteContext");
      }
      const ctxWithExtras = ctx as SecretProviderWriteContext & { deploymentId?: string };
      const path = buildManagedKvPath({
        config,
        deploymentId: ctxWithExtras.deploymentId ?? deploymentId(),
        companyId: ctx.companyId,
        secretKey: ctx.secretKey,
      });
      const valueSha256 = createHash("sha256").update(input.value).digest("hex");
      return await withVaultTokenRetry({
        tokenManager,
        sourceMode: tokenManager.sourceMode,
        operation: async () => {
          await tokenManager.acquire();
          // Set retention before the value write: putKv is the only
          // non-idempotent step and it is last, so an auth-retry cannot replay
          // a value write or leave a value behind if the (idempotent) metadata
          // call fails.
          await gateway.setKvMetadata({
            mount: config.kvMount,
            path,
            maxVersions: config.versionRetention,
          });
          // cas: 0 = create-only. A managed path must be empty when createSecret
          // runs; if a lost-response retry already wrote it, the CAS fails and
          // we re-read the existing version instead of writing a second one
          // (which would advance the Vault version and desync the
          // cas = next-1 alignment that createVersion relies on).
          let version: number;
          try {
            ({ version } = await gateway.putKv({
              mount: config.kvMount,
              path,
              data: { value: input.value },
              cas: 0,
            }));
          } catch (err) {
            if (err instanceof SecretProviderClientError && err.code === "conflict") {
              // Vault returns 400 for both a genuine create-only CAS conflict
              // (a lost-response retry already wrote the entry) and other
              // create errors. Confirm the entry exists AND holds the value we
              // are writing before treating this as a replay: a matching value
              // is a lost-response replay (adopt the existing version); a
              // DIFFERENT value means the path was re-keyed to a colliding
              // secret key (rename-then-recreate) and adopting its version
              // would silently point the new secret at the old secret's value,
              // so reject with a clear conflict instead.
              try {
                const existing = await gateway.getKv({ mount: config.kvMount, path });
                if (existing.data["value"] !== input.value) {
                  throw new SecretProviderClientError({
                    code: "conflict",
                    provider: "vault",
                    operation: "putKv",
                    message:
                      `vault managed path '${config.kvMount}/${path}' already holds a different value`,
                  });
                }
                version = existing.version;
              } catch (reReadErr) {
                if (reReadErr instanceof SecretProviderClientError && reReadErr.code === "not_found") {
                  // The key was soft-deleted (Vault KV v2 DELETE marks the
                  // latest version deleted but keeps the version history).
                  // cas:0 rejects it because the key still exists. Write a
                  // new version on top of the soft-deleted entry so the
                  // re-created secret gets a clean value.
                  ({ version } = await gateway.putKv({
                    mount: config.kvMount,
                    path,
                    data: { value: input.value },
                  }));
                } else {
                  throw reReadErr;
                }
              }
            } else {
              throw err;
            }
          }
          return {
            material: managedMaterial({ mount: config.kvMount, path, version }),
            valueSha256,
            fingerprintSha256: fingerprintFromVersionAndPath(config.kvMount, path, version),
            externalRef: `${config.kvMount}/${path}`,
            providerVersionRef: String(version),
          };
        },
      });
    },
    async createVersion(input) {
      const config = resolveConfig(input.providerConfig);
      const { gateway, tokenManager } = getOrCreateSession(config);
      const ctx = input.context;
      if (!ctx) throw unprocessable("vault createVersion requires SecretProviderWriteContext");

      // Rotate the existing secret in place: reuse the stored mount/path from
      // the recorded externalRef rather than rebuilding from the current key,
      // so a rename of the secret does not redirect the write to a new, empty
      // path. Falls back to the built path when no externalRef is recorded.
      const storedRef = input.externalRef ? parseExternalRef(input.externalRef) : null;
      const mount = storedRef?.mount ?? config.kvMount;
      const path =
        storedRef?.path ??
        buildManagedKvPath({
          config,
          deploymentId:
            (ctx as SecretProviderWriteContext & { deploymentId?: string }).deploymentId ??
            deploymentId(),
          companyId: ctx.companyId,
          secretKey: ctx.secretKey,
        });
      const valueSha256 = createHash("sha256").update(input.value).digest("hex");

      // A managed secret's externalRef always points at the managed prefix in
      // config.kvMount. If a reused reference points outside it (e.g. an
      // external_reference secret whose value lives on an external path), we
      // must not rotate it in place with the provider token — the service routes
      // those through linkExternalSecret/updateExternalSecretValue. Guard it here
      // so a stale or mis-typed ref cannot write into an external path.
      const underManagedPrefix =
        path === config.kvPathPrefix || path.startsWith(config.kvPathPrefix + "/");
      if (input.externalRef && (mount !== config.kvMount || !underManagedPrefix)) {
        throw unprocessable(
          "vault createVersion can rotate only managed secrets; the recorded " +
            `reference ${mount}/${path} is outside the managed prefix ` +
            `${config.kvMount}/data/${config.kvPathPrefix}`,
        );
      }
      // CAS against the CURRENT Vault version (not the next Paperclip version).
      // Managed writes are version-aligned, so the current version is next-1.
      const cas = ctx.version > 1 ? ctx.version - 1 : undefined;

      return await withVaultTokenRetry({
        tokenManager,
        sourceMode: tokenManager.sourceMode,
        operation: async () => {
          await tokenManager.acquire();
          // Set retention before the value write: putKv is the only
          // non-idempotent step and it is last, so an auth-retry cannot replay
          // a value write or leave a value behind if the (idempotent) metadata
          // call fails.
          await gateway.setKvMetadata({
            mount,
            path,
            maxVersions: config.versionRetention,
          });
          let version: number;
          try {
            ({ version } = await gateway.putKv({
              mount,
              path,
              data: { value: input.value },
              cas,
            }));
          } catch (err) {
            if (err instanceof SecretProviderClientError && err.code === "conflict") {
              // The CAS base (ctx.version - 1) is stale when a prior rotate's
              // write committed but its response was lost (or a DB rollback
              // left an orphaned version): Vault is ahead of Paperclip's
              // latestVersion. Self-heal by re-reading the actual current
              // version. If it already holds the value we are writing, this is
              // an idempotent replay — adopt it. Otherwise, only write on top
              // when Vault is exactly one ahead (existing.version ===
              // ctx.version, i.e. the slot Paperclip expected to write next);
              // that is the orphaned-write case and rotation must not brick.
              // If Vault is MORE than one ahead, a newer rotation has since
              // committed a different value — rethrow the conflict rather than
              // clobber it (a stale replay must not silently revert a newer
              // value).
              const existing = await gateway.getKv({ mount, path });
              if (existing.data["value"] === input.value) {
                version = existing.version;
              } else if (existing.version <= ctx.version) {
                // Vault is at or behind the Paperclip version we are writing:
                // an orphaned write from a failed DB save left Vault at or
                // past ctx.version. Write on top of the current Vault version
                // so rotation re-aligns instead of bricking.
                if (existing.version < ctx.version - 1) {
                  logger.warn(
                    {
                      mount,
                      path,
                      vaultVersion: existing.version,
                      paperclipVersion: ctx.version,
                    },
                    "vault createVersion: Vault is more than one version behind Paperclip; writing on top",
                  );
                }
                ({ version } = await gateway.putKv({
                  mount,
                  path,
                  data: { value: input.value },
                  cas: existing.version,
                }));
              } else {
                // Vault is MORE than one ahead of Paperclip: a newer rotation
                // committed a different value that Paperclip did not record.
                // Rethrow the conflict rather than silently clobbering a
                // newer value with a stale replay.
                throw err;
              }
            } else {
              throw err;
            }
          }
          return {
            material: managedMaterial({ mount, path, version }),
            valueSha256,
            fingerprintSha256: fingerprintFromVersionAndPath(mount, path, version),
            externalRef: `${mount}/${path}`,
            providerVersionRef: String(version),
          };
        },
      });
    },
    async linkExternalSecret(input) {
      const config = resolveConfig(input.providerConfig);
      const parsed = parseExternalRef(input.externalRef);
      // Guard against the deployment-wide managed prefix (operator env or
      // default), never the caller's own resolved config: a company that
      // relocated its own prefix (when the operator opted in) must still be
      // unable to link an external reference into another company's managed
      // path under the deployment-wide prefix.
      assertNotManagedOverlap(resolveDeploymentManagedPrefix(), parsed);
      const fingerprint = createHash("sha256")
        .update(`${parsed.mount}/${parsed.path}#${parsed.dataKey}`)
        .digest("hex");
      return {
        material: externalReferenceMaterial(parsed),
        valueSha256: fingerprint,
        fingerprintSha256: fingerprint,
        externalRef: input.externalRef,
        providerVersionRef: input.providerVersionRef ?? null,
      };
    },
    async resolveVersion(input) {
      const config = resolveConfig(input.providerConfig);
      const { gateway, tokenManager } = getOrCreateSession(config);

      if (!input.material || (input.material as { scheme?: string }).scheme !== VAULT_MATERIAL_SCHEME) {
        throw unprocessable("vault resolveVersion: material is not vault_kv_v2");
      }
      const material = input.material as unknown as VaultManagedMaterial;

      const versionOverride = input.providerVersionRef
        ? Number(input.providerVersionRef)
        : material.version ?? undefined;
      const version = typeof versionOverride === "number" && Number.isFinite(versionOverride) && versionOverride > 0
        ? versionOverride
        : undefined;

      return await withVaultTokenRetry({
        tokenManager,
        sourceMode: tokenManager.sourceMode,
        operation: async () => {
          await tokenManager.acquire();
          const { data } = await gateway.getKv({
            mount: material.mount,
            path: material.path,
            version,
          });
          const value = data[material.dataKey ?? "value"];
          if (typeof value !== "string") {
            throw new SecretProviderClientError({
              code: "not_found",
              provider: "vault",
              operation: "getKv",
              message: `vault data key '${material.dataKey ?? "value"}' missing from KV response`,
            });
          }
          return value;
        },
      });
    },
    async deleteOrArchive(input) {
      if (input.mode === "archive") return;

      const material = input.material as VaultManagedMaterial | undefined;
      if (!material || material.scheme !== VAULT_MATERIAL_SCHEME) return;
      if (material.source !== "managed") return;

      const config = resolveConfig(input.providerConfig);
      const { gateway, tokenManager } = getOrCreateSession(config);

      await withVaultTokenRetry({
        tokenManager,
        sourceMode: tokenManager.sourceMode,
        operation: async () => {
          await tokenManager.acquire();
          await gateway.deleteKv({ mount: material.mount, path: material.path });
        },
      });
    },
    async healthCheck(input) {
      const warnings: string[] = [];
      let config: VaultProviderConfig | null;
      try {
        const resolved = resolveConfigWithWarnings(input?.providerConfig);
        config = resolved.config;
        warnings.push(...resolved.warnings);
      } catch (error) {
        return {
          provider: "vault",
          status: "warn" as const,
          message:
            "vault provider is not configured for runtime resolution; external references can still be stored as metadata",
          warnings: [(error as Error).message],
        };
      }
      let gateway: VaultHttpGateway;
      let tokenManager: VaultTokenManager;
      try {
        ({ gateway, tokenManager } = getOrCreateSession(config));
      } catch (error) {
        // A transient auth-source detection failure (e.g. no SA token yet) is
        // not a permanent vault failure — report it as an error health and let
        // the next call re-detect, rather than throwing out of the health path.
        return {
          provider: "vault",
          status: "error" as const,
          message: (error as Error).message,
          warnings,
          details: {
            address: config.address,
            kvMount: config.kvMount,
            kvPathPrefix: config.kvPathPrefix,
            authMethod: config.auth.method,
          },
        };
      }
      const details: Record<string, unknown> = {
        address: config.address,
        kvMount: config.kvMount,
        kvPathPrefix: config.kvPathPrefix,
        authMethod: config.auth.method,
      };

      // 1) reachability
      let healthStatus: { sealed?: boolean; standby?: boolean; version?: string } = {};
      try {
        healthStatus = await gateway.health();
        details.vaultVersion = healthStatus.version;
        details.standby = healthStatus.standby ?? false;
        if (healthStatus.sealed) warnings.push("vault is sealed; auth/data calls will fail until unsealed");
      } catch (error) {
        return {
          provider: "vault",
          status: "error" as const,
          message: `vault unreachable at ${config.address}`,
          warnings: [(error as Error).message],
          details,
        };
      }

      // 2) auth probe
      try {
        if (tokenManager.sourceMode === "error") {
          throw new Error("no vault auth source detected");
        }
        await tokenManager.acquire();
        if (tokenManager.sourceMode === "token") {
          // Verify the bootstrap token is live (lookup-self). Do NOT expose
          // its TTL, renewability, or policy names to company writers: health
          // is company-scoped, and those fields disclose the deployment
          // credential's auth posture. The probe still fails here on an
          // invalid token, but the token's posture stays server-side.
          await gateway.lookupSelf();
        }
      } catch (error) {
        warnings.push(`auth probe failed: ${(error as Error).message}`);
      }

      // 3) KV engine probe
      try {
        const mount = await gateway.readMount(config.kvMount);
        if (mount.options?.version !== "2") {
          warnings.push(`mount '${config.kvMount}' is kv v${mount.options?.version ?? "?"}; the vault provider requires kv v2`);
        }
      } catch (error) {
        warnings.push(`could not inspect mount '${config.kvMount}': ${(error as Error).message}`);
      }

      // 4) capabilities probe
      try {
        const probePath = `${config.kvMount}/data/${config.kvPathPrefix}/_health_probe`;
        const caps = await gateway.capabilitiesSelf([probePath]);
        const granted = caps[probePath] ?? [];
        const required = ["create", "read", "update", "delete"];
        const missing = required.filter((cap) => !granted.includes(cap));
        if (missing.length > 0) {
          warnings.push(`missing vault capabilities on ${probePath}: ${missing.join(", ")}`);
        }
        // capabilities are not surfaced to company writers (health is
        // company-scoped); the missing-capability warnings above are the only
        // consumer-facing signal.
      } catch (error) {
        warnings.push(`capabilities probe failed: ${(error as Error).message}`);
      }

      const status = warnings.length === 0 ? "ok" : "warn";
      return {
        provider: "vault",
        status: status as "ok" | "warn",
        message:
          status === "ok"
            ? `vault provider healthy at ${config.address} (mount=${config.kvMount}, auth=${config.auth.method})`
            : `vault provider has warnings at ${config.address}`,
        warnings: warnings.length > 0 ? warnings : undefined,
        details,
      };
    },
  };
}



export const vaultProvider: SecretProviderModule = createVaultProvider();
