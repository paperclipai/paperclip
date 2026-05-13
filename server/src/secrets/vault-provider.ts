import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { request as undiciRequest } from "undici";
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

export const VAULT_MATERIAL_SCHEME = "vault_kv_v2";
export const DEFAULT_KV_MOUNT = "secret";
export const DEFAULT_KV_PATH_PREFIX = "paperclip";
export const DEFAULT_VERSION_RETENTION = 10;
export const MIN_VERSION_RETENTION = 2;
export const MAX_VERSION_RETENTION = 100;
export const DEFAULT_SA_TOKEN_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/token";
export const TOKEN_RENEWAL_THRESHOLD = 0.7;
export const TOKEN_EXPIRY_SKEW_MS = 30_000;

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
    method: "kubernetes" | "token";
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
  const segments = [
    input.config.kvPathPrefix,
    input.deploymentId,
    input.companyId,
    input.secretKey,
  ].filter((s) => s.length > 0);
  return segments.join("/");
}

export interface VaultHttpGateway {
  health(): Promise<{
    initialized?: boolean;
    sealed?: boolean;
    standby?: boolean;
    version?: string;
    cluster_name?: string;
  }>;
  loginKubernetes(input: { role: string; jwt: string }): Promise<{
    clientToken: string;
    leaseDurationSec: number;
    renewable: boolean;
  }>;
  /**
   * Renew the supplied token in-place. Takes the token as a parameter
   * rather than reaching back through getToken() because this method is
   * called from inside VaultTokenManager.acquireInner — going through
   * getToken would re-enter acquire() and wait on the same inflight
   * promise, deadlocking the renewal path on every kubernetes-mode
   * vault operation past the renewal threshold.
   */
  renewSelf(token: string): Promise<{ leaseDurationSec: number; renewable: boolean }>;
  lookupSelf(): Promise<{ leaseDurationSec: number; renewable: boolean; policies: string[] }>;
  capabilitiesSelf(paths: string[]): Promise<Record<string, string[]>>;
  readMount(mount: string): Promise<{ type: string; options: Record<string, string> }>;
  putKv(input: {
    mount: string;
    path: string;
    data: Record<string, string>;
    cas?: number;
  }): Promise<{ version: number }>;
  getKv(input: {
    mount: string;
    path: string;
    version?: number;
  }): Promise<{ data: Record<string, string>; version: number }>;
  setKvMetadata(input: {
    mount: string;
    path: string;
    maxVersions: number;
  }): Promise<void>;
  deleteKv(input: { mount: string; path: string }): Promise<void>;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function validateAddress(raw: unknown, warnings: string[]): URL | null {
  const value = asString(raw);
  if (!value) {
    warnings.push("vault address is required (set vault config address or PAPERCLIP_SECRETS_VAULT_ADDR)");
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
  if (!KV_PREFIX_PATTERN.test(value)) {
    warnings.push(`kvPathPrefix must match [A-Za-z0-9._/-]; got ${value}`);
    return null;
  }
  return value;
}

function validateAuthBlock(
  raw: unknown,
  warnings: string[],
): { method: "kubernetes" | "token"; role: string | null; saTokenPath: string } | null {
  const block = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const methodRaw = asString(block.method);
  if (methodRaw && methodRaw !== "kubernetes" && methodRaw !== "token") {
    warnings.push(`auth.method must be 'kubernetes' or 'token'; got ${methodRaw}`);
    return null;
  }
  const method = (methodRaw ?? "token") as "kubernetes" | "token";
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

export type VaultAuthSource =
  | { mode: "token"; token: string }
  | { mode: "kubernetes"; role: string; jwt: string; saTokenPath: string }
  | { mode: "error"; message: string };

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

  function fromConfigOrEnv(key: keyof typeof vaultConfig, envKey: string): unknown {
    if (vaultConfig[key] !== undefined) return vaultConfig[key];
    return input.env[envKey];
  }

  const url = validateAddress(
    fromConfigOrEnv("address", "PAPERCLIP_SECRETS_VAULT_ADDR"),
    warnings,
  );
  const kvMount = validateKvMount(
    fromConfigOrEnv("kvMount", "PAPERCLIP_SECRETS_VAULT_KV_MOUNT"),
    warnings,
  );
  const kvPathPrefix = validateKvPathPrefix(
    fromConfigOrEnv("kvPathPrefix", "PAPERCLIP_SECRETS_VAULT_KV_PATH_PREFIX"),
    warnings,
  );

  const authRaw = (vaultConfig.auth ?? null) as Record<string, unknown> | null;
  const authMerged = authRaw ?? {
    method: input.env.PAPERCLIP_SECRETS_VAULT_AUTH_METHOD,
    role: input.env.PAPERCLIP_SECRETS_VAULT_K8S_ROLE,
    saTokenPath: input.env.PAPERCLIP_SECRETS_VAULT_SA_TOKEN_PATH,
  };
  const auth = validateAuthBlock(authMerged, warnings);

  const versionRetentionRaw =
    vaultConfig.versionRetention !== undefined
      ? vaultConfig.versionRetention
      : input.env.PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION !== undefined
        ? parseInt(input.env.PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION, 10)
        : undefined;
  const versionRetention = validateVersionRetention(versionRetentionRaw, warnings);

  const namespace =
    asString(vaultConfig.namespace) ??
    asString(input.env.PAPERCLIP_SECRETS_VAULT_NAMESPACE);

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

export function detectVaultAuthSource(input: {
  config: VaultProviderConfig;
  env: NodeJS.ProcessEnv;
  readSaToken: (path: string) => string | null;
}): VaultAuthSource {
  const { config, env, readSaToken } = input;

  if (config.auth.method === "kubernetes") {
    const jwt = readSaToken(config.auth.saTokenPath);
    if (!jwt) {
      return {
        mode: "error",
        message:
          "auth.method = 'kubernetes' but no SA token found at " +
          config.auth.saTokenPath,
      };
    }
    if (!config.auth.role) {
      return {
        mode: "error",
        message: "auth.method = 'kubernetes' requires auth.role",
      };
    }
    return { mode: "kubernetes", role: config.auth.role, jwt, saTokenPath: config.auth.saTokenPath };
  }

  // method = token (explicit or defaulted)
  const token = asString(env.VAULT_TOKEN);
  if (token) return { mode: "token", token };

  return {
    mode: "error",
    message:
      "no Vault auth source detected: configure auth.method = 'kubernetes' " +
      "with role=<role> in cluster, or set VAULT_TOKEN env for local dev",
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

function assertNotManagedOverlap(config: VaultProviderConfig, ref: ParsedExternalRef): void {
  if (ref.mount === config.kvMount && (ref.path === config.kvPathPrefix || ref.path.startsWith(`${config.kvPathPrefix}/`))) {
    throw unprocessable(
      `vault external ref overlaps Paperclip-managed prefix '${config.kvMount}/${config.kvPathPrefix}'`,
    );
  }
}

function fingerprintFromVersionAndPath(mount: string, path: string, version: number): string {
  return createHash("sha256").update(`${mount}/${path}@v${version}`).digest("hex");
}

export class UndiciVaultGateway implements VaultHttpGateway {
  private readonly address: string;
  private readonly namespace: string | null;
  private readonly getToken: () => Promise<string>;

  constructor(input: { address: string; namespace: string | null; getToken: () => Promise<string> }) {
    this.address = input.address.replace(/\/$/, "");
    this.namespace = input.namespace;
    this.getToken = input.getToken;
  }

  private async call<T>(input: {
    method: "GET" | "POST" | "PUT" | "DELETE" | "LIST";
    path: string;
    body?: unknown;
    authenticated?: boolean;
    /**
     * Explicit token override. When provided, getToken() is bypassed —
     * required for renewSelf, which is called from inside the token
     * manager's acquire path and would otherwise re-enter and deadlock.
     */
    token?: string;
  }): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (input.token !== undefined) {
      headers["x-vault-token"] = input.token;
    } else if (input.authenticated !== false) {
      headers["x-vault-token"] = await this.getToken();
    }
    if (this.namespace) headers["x-vault-namespace"] = this.namespace;

    const url = `${this.address}${input.path}`;
    const response = await undiciRequest(url, {
      method: input.method,
      headers,
      body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
    });
    const text = await response.body.text();
    const status = response.statusCode;
    if (status >= 200 && status < 300) {
      return (text ? JSON.parse(text) : {}) as T;
    }
    const errBody = (() => { try { return JSON.parse(text); } catch { return { errors: [text] }; } })();
    const errors = Array.isArray(errBody?.errors) ? errBody.errors.join("; ") : String(text);
    const code = mapStatusToCode(status);
    throw new SecretProviderClientError({
      code,
      provider: "vault",
      operation: input.path,
      message: `vault ${input.method} ${input.path} returned ${status}: ${errors}`,
      status,
      rawMessage: errors,
    });
  }

  async health() {
    return this.call<{
      initialized?: boolean;
      sealed?: boolean;
      standby?: boolean;
      version?: string;
      cluster_name?: string;
    }>({ method: "GET", path: "/v1/sys/health?standbycode=200&sealedcode=200", authenticated: false });
  }
  async loginKubernetes(input: { role: string; jwt: string }) {
    const r = await this.call<{ auth: { client_token: string; lease_duration: number; renewable: boolean } }>({
      method: "POST",
      path: "/v1/auth/kubernetes/login",
      body: { role: input.role, jwt: input.jwt },
      authenticated: false,
    });
    return {
      clientToken: r.auth.client_token,
      leaseDurationSec: r.auth.lease_duration,
      renewable: r.auth.renewable,
    };
  }
  async renewSelf(token: string) {
    // Pass the token explicitly so call() does not invoke getToken(),
    // which would re-enter VaultTokenManager.acquire() while
    // acquireInner() is already in flight — a circular await that
    // permanently hangs the kubernetes-mode renewal path.
    const r = await this.call<{ auth: { lease_duration: number; renewable: boolean } }>({
      method: "POST",
      path: "/v1/auth/token/renew-self",
      token,
    });
    return { leaseDurationSec: r.auth.lease_duration, renewable: r.auth.renewable };
  }
  async lookupSelf() {
    const r = await this.call<{ data: { ttl: number; renewable: boolean; policies: string[] } }>({
      method: "GET",
      path: "/v1/auth/token/lookup-self",
    });
    return { leaseDurationSec: r.data.ttl, renewable: r.data.renewable, policies: r.data.policies };
  }
  async capabilitiesSelf(paths: string[]) {
    const r = await this.call<Record<string, string[]>>({
      method: "POST",
      path: "/v1/sys/capabilities-self",
      body: { paths },
    });
    return r;
  }
  async readMount(mount: string) {
    return this.call<{ type: string; options: Record<string, string> }>({
      method: "GET",
      path: `/v1/sys/mounts/${encodeURIComponent(mount)}`,
    });
  }
  async putKv(input: { mount: string; path: string; data: Record<string, string>; cas?: number }) {
    const body: Record<string, unknown> = { data: input.data };
    if (input.cas !== undefined) body.options = { cas: input.cas };
    const r = await this.call<{ data: { version: number } }>({
      method: "POST",
      path: `/v1/${input.mount}/data/${input.path}`,
      body,
    });
    return { version: r.data.version };
  }
  async getKv(input: { mount: string; path: string; version?: number }) {
    const query = input.version !== undefined ? `?version=${input.version}` : "";
    const r = await this.call<{ data: { data: Record<string, string>; metadata: { version: number } } }>({
      method: "GET",
      path: `/v1/${input.mount}/data/${input.path}${query}`,
    });
    return { data: r.data.data, version: r.data.metadata.version };
  }
  async setKvMetadata(input: { mount: string; path: string; maxVersions: number }) {
    await this.call({
      method: "POST",
      path: `/v1/${input.mount}/metadata/${input.path}`,
      body: { max_versions: input.maxVersions },
    });
  }
  async deleteKv(input: { mount: string; path: string }) {
    await this.call({ method: "DELETE", path: `/v1/${input.mount}/data/${input.path}` });
  }
}

function mapStatusToCode(status: number): SecretProviderClientErrorCode {
  if (status === 401 || status === 403) return "access_denied";
  if (status === 404) return "not_found";
  if (status === 409 || status === 400) return "conflict";
  if (status === 429) return "throttled";
  if (status === 502 || status === 503 || status === 504) return "provider_unavailable";
  return "provider_error";
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

  function resolveConfig(providerConfig?: SecretProviderVaultRuntimeConfig | null): VaultProviderConfig {
    if (options?.config) return options.config;
    const resolved = resolveVaultConfig({
      env: process.env,
      providerConfig: providerConfig ?? null,
    });
    if (!resolved.config) {
      throw unprocessable(
        `vault provider config invalid: ${resolved.warnings.join("; ")}`,
      );
    }
    return resolved.config;
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
    let tokenManager!: VaultTokenManager;
    const gateway: VaultHttpGateway =
      options?.gateway ??
      new UndiciVaultGateway({
        address: config.address,
        namespace: config.namespace,
        getToken: () => tokenManager.acquire(),
      });
    const source = detectVaultAuthSource({ config, env: process.env, readSaToken });
    tokenManager = new VaultTokenManager({ source, gateway });
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
      validateKvMount(rawConfig.kvMount, warnings);
      validateKvPathPrefix(rawConfig.kvPathPrefix, warnings);
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
          const { version } = await gateway.putKv({
            mount: config.kvMount,
            path,
            data: { value: input.value },
          });
          await gateway.setKvMetadata({
            mount: config.kvMount,
            path,
            maxVersions: config.versionRetention,
          });
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

      const ctxWithExtras = ctx as SecretProviderWriteContext & { deploymentId?: string };
      const path = buildManagedKvPath({
        config,
        deploymentId: ctxWithExtras.deploymentId ?? deploymentId(),
        companyId: ctx.companyId,
        secretKey: ctx.secretKey,
      });
      const valueSha256 = createHash("sha256").update(input.value).digest("hex");

      const cas = ctx.version > 0 ? ctx.version : undefined;

      return await withVaultTokenRetry({
        tokenManager,
        sourceMode: tokenManager.sourceMode,
        operation: async () => {
          await tokenManager.acquire();
          const { version } = await gateway.putKv({
            mount: config.kvMount,
            path,
            data: { value: input.value },
            cas,
          });
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
    async linkExternalSecret(input) {
      const config = resolveConfig(input.providerConfig);
      const parsed = parseExternalRef(input.externalRef);
      assertNotManagedOverlap(config, parsed);
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
        config = resolveConfig(input?.providerConfig);
      } catch (error) {
        return {
          provider: "vault",
          status: "warn" as const,
          message:
            "vault provider is not configured for runtime resolution; external references can still be stored as metadata",
          warnings: [(error as Error).message],
        };
      }
      const { gateway, tokenManager } = getOrCreateSession(config);
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
          const info = await gateway.lookupSelf();
          details.tokenTtlSec = info.leaseDurationSec;
          details.tokenRenewable = info.renewable;
          details.policies = info.policies;
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
        details.capabilities = granted;
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

export class VaultTokenManager {
  private readonly source: VaultAuthSource;
  private readonly gateway: Pick<VaultHttpGateway, "loginKubernetes" | "renewSelf">;
  private readonly now: () => number;
  private readonly readSaToken: (path: string) => string | null;
  private cached: { token: string; acquiredAt: number; ttlMs: number; renewable: boolean } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(input: {
    source: VaultAuthSource;
    gateway: Pick<VaultHttpGateway, "loginKubernetes" | "renewSelf">;
    now?: () => number;
    /** Test seam: re-read the SA token file on each login. Defaults to readFileSync. */
    readSaToken?: (path: string) => string | null;
  }) {
    this.source = input.source;
    this.gateway = input.gateway;
    this.now = input.now ?? (() => Date.now());
    this.readSaToken =
      input.readSaToken ??
      ((path: string) => {
        try {
          if (!existsSync(path)) return null;
          return readFileSync(path, "utf8").trim() || null;
        } catch {
          return null;
        }
      });
  }

  get sourceMode(): VaultAuthSource["mode"] {
    return this.source.mode;
  }

  invalidate(): void {
    this.cached = null;
  }

  async acquire(): Promise<string> {
    if (this.source.mode === "token") return this.source.token;
    if (this.source.mode === "error") throw unprocessable(this.source.message);

    if (this.inflight) return this.inflight;
    this.inflight = this.acquireInner().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async acquireInner(): Promise<string> {
    if (this.source.mode !== "kubernetes") {
      throw new Error("acquireInner only used in kubernetes mode");
    }
    const now = this.now();
    if (this.cached) {
      const elapsed = now - this.cached.acquiredAt;
      const ttlMs = this.cached.ttlMs;
      // Subtract a clock-skew margin so we never serve a token that is within
      // TOKEN_EXPIRY_SKEW_MS of expiry on a slow/skewed clock — Vault would
      // reject it as expired even though our local clock still thinks it's
      // valid. Concretely: a 100s TTL with 30s skew renews at 40s, not 70s.
      const renewThreshold = ttlMs * TOKEN_RENEWAL_THRESHOLD - TOKEN_EXPIRY_SKEW_MS;
      if (elapsed < renewThreshold) return this.cached.token;
      if (this.cached.renewable) {
        try {
          const renewed = await this.gateway.renewSelf(this.cached.token);
          this.cached = {
            token: this.cached.token,
            acquiredAt: now,
            ttlMs: renewed.leaseDurationSec * 1000,
            renewable: renewed.renewable,
          };
          return this.cached.token;
        } catch {
          // fallthrough to re-login
        }
      }
    }
    if (this.source.mode !== "kubernetes") throw new Error("unreachable");
    // Re-read the SA JWT from disk on every login attempt. Kubernetes
    // projected SA tokens are rotated on disk roughly every hour; the
    // value captured at session-creation time goes stale and the
    // resulting login attempt fails with 403, leaving vault auth
    // permanently broken until process restart.
    //
    // If the disk read fails or the file is missing, fall back to the
    // jwt captured at session creation — the subsequent 403 (if any) will
    // be surfaced through withVaultTokenRetry rather than silently
    // swallowed here.
    let jwt = this.source.jwt;
    try {
      const fresh = this.readSaToken(this.source.saTokenPath);
      if (fresh) {
        jwt = fresh;
      }
    } catch (error) {
      console.error(
        `vault-provider: failed to re-read SA token at ${this.source.saTokenPath}: ${(error as Error).message}; falling back to cached JWT`,
      );
    }
    const login = await this.gateway.loginKubernetes({
      role: this.source.role,
      jwt,
    });
    this.cached = {
      token: login.clientToken,
      acquiredAt: now,
      ttlMs: login.leaseDurationSec * 1000,
      renewable: login.renewable,
    };
    return this.cached.token;
  }
}

export async function withVaultTokenRetry<T>(input: {
  tokenManager: VaultTokenManager;
  sourceMode: VaultAuthSource["mode"];
  operation: () => Promise<T>;
}): Promise<T> {
  try {
    return await input.operation();
  } catch (error) {
    if (
      input.sourceMode === "kubernetes" &&
      error instanceof SecretProviderClientError &&
      error.code === "access_denied"
    ) {
      input.tokenManager.invalidate();
      return await input.operation();
    }
    throw error;
  }
}

export const vaultProvider: SecretProviderModule = createVaultProvider();
