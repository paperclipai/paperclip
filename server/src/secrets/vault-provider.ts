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
  renewSelf(): Promise<{ leaseDurationSec: number; renewable: boolean }>;
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
        ? Number(input.env.PAPERCLIP_SECRETS_VAULT_VERSION_RETENTION)
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

  function resolveGateway(_config: VaultProviderConfig): VaultHttpGateway {
    if (options?.gateway) return options.gateway;
    throw unprocessable(
      "vault provider has no http gateway configured; production gateway is added in a follow-up task",
    );
    // Replaced by UndiciVaultGateway construction in Task 17.
  }

  function tokenManagerFor(config: VaultProviderConfig, gateway: VaultHttpGateway): VaultTokenManager {
    const source = detectVaultAuthSource({
      config,
      env: process.env,
      readSaToken,
    });
    return new VaultTokenManager({ source, gateway });
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
      const gateway = resolveGateway(config);
      const tokenManager = tokenManagerFor(config, gateway);
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
    async createVersion() {
      throw new Error("createVersion not implemented yet");
    },
    async linkExternalSecret() {
      throw new Error("linkExternalSecret not implemented yet");
    },
    async resolveVersion() {
      throw new Error("resolveVersion not implemented yet");
    },
    async deleteOrArchive() { /* later */ },
    async healthCheck() {
      return { provider: "vault", status: "warn", message: "healthCheck not implemented yet" };
    },
  };
}

export class VaultTokenManager {
  private readonly source: VaultAuthSource;
  private readonly gateway: Pick<VaultHttpGateway, "loginKubernetes" | "renewSelf">;
  private readonly now: () => number;
  private cached: { token: string; acquiredAt: number; ttlMs: number; renewable: boolean } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(input: {
    source: VaultAuthSource;
    gateway: Pick<VaultHttpGateway, "loginKubernetes" | "renewSelf">;
    now?: () => number;
  }) {
    this.source = input.source;
    this.gateway = input.gateway;
    this.now = input.now ?? (() => Date.now());
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
      const renewThreshold = ttlMs * TOKEN_RENEWAL_THRESHOLD;
      if (elapsed < renewThreshold) return this.cached.token;
      if (this.cached.renewable) {
        try {
          const renewed = await this.gateway.renewSelf();
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
    const login = await this.gateway.loginKubernetes({
      role: this.source.role,
      jwt: this.source.jwt,
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
