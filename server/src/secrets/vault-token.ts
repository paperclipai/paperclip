import { readFileSync, existsSync } from "node:fs";
import type {
  SecretProviderClientErrorCode,
  SecretProviderHealthCheck,
} from "./types.js";
import { SecretProviderClientError } from "./types.js";
import { unprocessable } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { VaultProviderConfig } from "./vault-provider.js";

/**
 * Vault HTTP transport + token/session lifecycle, extracted from
 * vault-provider.ts (which would otherwise exceed the 1,000-line module
 * limit). The provider file re-exports these names for compatibility.
 */

export const DEFAULT_SA_TOKEN_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/token";
export const TOKEN_RENEWAL_THRESHOLD = 0.7;
export const TOKEN_EXPIRY_SKEW_MS = 30_000;

/**
 * Bounded lifetime for a single Vault request (including response body
 * read), mirroring AWS_SECRETS_MANAGER_REQUEST_TIMEOUT_MS. Without it a
 * Vault that stalls mid-response can pin the whole request pipeline; a
 * timed-out write must fall through to the normal client error paths, and
 * a later request must proceed unaffected.
 */
export const DEFAULT_VAULT_HTTP_TIMEOUT_MS = 30_000;

export function resolveVaultHttpTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.VAULT_HTTP_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_VAULT_HTTP_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_VAULT_HTTP_TIMEOUT_MS;
  return parsed;
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
  loginApprole(input: { roleId: string; secretId: string }): Promise<{
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

export class HttpVaultGateway implements VaultHttpGateway {
  private readonly address: string;
  private readonly namespace: string | null;
  private readonly getToken: () => Promise<string>;
  private readonly timeoutMs: number;

  constructor(input: {
    address: string;
    namespace: string | null;
    getToken: () => Promise<string>;
    timeoutMs?: number;
  }) {
    this.address = input.address.replace(/\/$/, "");
    this.namespace = input.namespace;
    this.getToken = input.getToken;
    this.timeoutMs = input.timeoutMs ?? resolveVaultHttpTimeoutMs();
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
    let response: Response;
    let text: string;
    try {
      response = await fetch(url, {
        method: input.method,
        headers,
        body: input.body !== undefined ? JSON.stringify(input.body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      text = await response.text();
    } catch (error) {
      // Network/timeout failures (including the AbortSignal.timeout that
      // bounds the request) must surface as a provider error code so the
      // retry helper and caller error mapping work. A timeout maps to
      // provider_unavailable; a plain network error does too.
      const name = (error as { name?: string })?.name;
      const isTimeout = name === "TimeoutError" || name === "AbortError";
      throw new SecretProviderClientError({
        code: "provider_unavailable",
        provider: "vault",
        operation: input.path,
        message: `vault ${input.method} ${input.path} ${isTimeout ? `timed out after ${this.timeoutMs}ms` : "failed"}: ${(error as Error).message}`,
        rawMessage: (error as Error).message,
      });
    }
    const status = response.status;
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
  async loginApprole(input: { roleId: string; secretId: string }) {
    const r = await this.call<{ auth: { client_token: string; lease_duration: number; renewable: boolean } }>({
      method: "POST",
      path: "/v1/auth/approle/login",
      body: { role_id: input.roleId, secret_id: input.secretId },
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

export type VaultAuthSource =
  | {
      mode: "token";
      token: string;
      /**
       * Optional path to a file holding the token. When set, the token is
       * re-read from the file on every acquire so an orchestrator (e.g. a Nomad
       * Vault agent) can rotate it without an env change; the env `token` is the
       * fallback when the file is absent or unreadable.
       */
      tokenPath?: string;
    }
  | { mode: "kubernetes"; role: string; jwt: string; saTokenPath: string }
  | {
      mode: "approle";
      roleId: string;
      secretId: string;
      /**
       * Optional paths to files holding the role_id/secret_id. When set, each
       * value is re-read from its file on every login so an orchestrator (e.g.
       * a Nomad Vault agent) can rotate it in place with no env change.
       */
      roleIdPath?: string;
      secretIdPath?: string;
    }
  | { mode: "error"; message: string };

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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

  if (config.auth.method === "approle") {
    // The env var wins; the vault config's auth.role is the fallback so a
    // company that saved the role in the UI is not broken when the env var
    // is later removed. The secret_id is always from env (or file) — it is
    // a bootstrap credential, not a managed secret.
    const roleId = asString(env.PAPERCLIP_SECRETS_VAULT_APPROLE_ROLE_ID) ?? config.auth.role ?? undefined;
    const secretId = asString(env.PAPERCLIP_SECRETS_VAULT_APPROLE_SECRET_ID);
    const roleIdPath = asString(env.PAPERCLIP_SECRETS_VAULT_APPROLE_ROLE_ID_FILE) ?? undefined;
    const secretIdPath = asString(env.PAPERCLIP_SECRETS_VAULT_APPROLE_SECRET_ID_FILE) ?? undefined;
    if ((!roleId && !roleIdPath) || (!secretId && !secretIdPath)) {
      return {
        mode: "error",
        message:
          "auth.method = 'approle' requires role_id and secret_id via " +
          "PAPERCLIP_SECRETS_VAULT_APPROLE_ROLE_ID and PAPERCLIP_SECRETS_VAULT_APPROLE_SECRET_ID " +
          "(or the corresponding *_FILE paths), or auth.role in the vault config",
      };
    }
    return {
      mode: "approle",
      roleId: roleId ?? "",
      secretId: secretId ?? "",
      roleIdPath,
      secretIdPath,
    };
  }

  // method = token (explicit or defaulted). The token can come from the
  // standard VAULT_TOKEN env or, optionally, a file
  // (PAPERCLIP_SECRETS_VAULT_TOKEN_FILE) that an orchestrator can rotate in
  // place; the file is re-read on every acquire, with the env value as the
  // fallback. This keeps the provider orchestrator-agnostic: no k8s in-cluster
  // SA, no Nomad-specific assumption.
  const token = asString(env.VAULT_TOKEN);
  const tokenPath = asString(env.PAPERCLIP_SECRETS_VAULT_TOKEN_FILE) ?? undefined;
  if (token) return { mode: "token", token, tokenPath };
  if (tokenPath) return { mode: "token", token: "", tokenPath };

  return {
    mode: "error",
    message:
      "no Vault auth source detected: configure auth.method = 'kubernetes' " +
      "with role=<role> in cluster, set the VAULT_TOKEN env, or point " +
      "PAPERCLIP_SECRETS_VAULT_TOKEN_FILE at a token file",
  };
}

export class VaultTokenManager {
  private readonly source: VaultAuthSource;
  private readonly gateway: Pick<VaultHttpGateway, "loginKubernetes" | "loginApprole" | "renewSelf">;
  private readonly now: () => number;
  private readonly readSaToken: (path: string) => string | null;
  private cached: { token: string; acquiredAt: number; ttlMs: number; renewable: boolean } | null = null;
  private inflight: Promise<string> | null = null;

  constructor(input: {
    source: VaultAuthSource;
    gateway: Pick<VaultHttpGateway, "loginKubernetes" | "loginApprole" | "renewSelf">;
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
    if (this.source.mode === "token") {
      // Re-read the token file each time so an orchestrator (e.g. a Nomad
      // Vault agent) can rotate the token in place; fall back to the env token.
      if (this.source.tokenPath) {
        const fromFile = this.readSaToken(this.source.tokenPath);
        if (fromFile) return fromFile;
      }
      return this.source.token;
    }
    if (this.source.mode === "error") throw unprocessable(this.source.message);

    if (this.inflight) return this.inflight;
    this.inflight = this.acquireInner().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async acquireInner(): Promise<string> {
    if (this.source.mode !== "kubernetes" && this.source.mode !== "approle") {
      throw new Error("acquireInner only used for kubernetes/approle login modes");
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
    const login = await this.loginFresh();
    this.cached = {
      token: login.clientToken,
      acquiredAt: now,
      ttlMs: login.leaseDurationSec * 1000,
      renewable: login.renewable,
    };
    return this.cached.token;
  }

  /**
   * Perform a fresh login for kubernetes or approle mode, re-reading any
   * on-disk credential (SA JWT or role_id/secret_id files) on every attempt
   * so an orchestrator can rotate them in place without a restart.
   */
  private async loginFresh(): Promise<{
    clientToken: string;
    leaseDurationSec: number;
    renewable: boolean;
  }> {
    if (this.source.mode === "kubernetes") {
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
        logger.warn(
          {
            err: error,
            saTokenPath: this.source.saTokenPath,
          },
          "vault-provider: failed to re-read SA token; falling back to cached JWT",
        );
      }
      return this.gateway.loginKubernetes({
        role: this.source.role,
        jwt,
      });
    }
    if (this.source.mode === "approle") {
      // Re-read role_id/secret_id files on each login so an orchestrator
      // (e.g. a Nomad Vault agent) can rotate them in place; fall back to
      // the env values when a file is absent or unreadable.
      let roleId = this.source.roleId;
      let secretId = this.source.secretId;
      if (this.source.roleIdPath) {
        const fresh = this.readSaToken(this.source.roleIdPath);
        if (fresh) roleId = fresh;
      }
      if (this.source.secretIdPath) {
        const fresh = this.readSaToken(this.source.secretIdPath);
        if (fresh) secretId = fresh;
      }
      return this.gateway.loginApprole({ roleId, secretId });
    }
    throw new Error("unreachable");
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
      (input.sourceMode === "kubernetes" || input.sourceMode === "approle") &&
      error instanceof SecretProviderClientError &&
      error.code === "access_denied"
    ) {
      input.tokenManager.invalidate();
      return await input.operation();
    }
    throw error;
  }
}
