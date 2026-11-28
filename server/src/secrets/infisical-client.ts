import { createHash } from "node:crypto";
import { unprocessable } from "../errors.js";
import type { SecretProviderClientErrorCode } from "./types.js";
import { SecretProviderClientError } from "./types.js";

const DEFAULT_SITE_URL = "https://app.infisical.com";
const DEFAULT_SECRET_PATH = "/";
const INFISICAL_REQUEST_TIMEOUT_MS = 30_000;
const INFISICAL_TOKEN_EXPIRATION_SKEW_MS = 60_000;
const INFISICAL_TOKEN_MAX_CACHE_MS = 10 * 60_000;

export interface InfisicalConfig {
  siteUrl: string;
  projectId: string;
  environment: string;
  secretPath: string;
}

export interface InfisicalCredentials {
  clientId: string;
  clientSecret: string;
}

export interface InfisicalSecretRef {
  secretPath: string;
  secretKey: string;
  environment: string;
}

export interface InfisicalRawSecret {
  id?: string;
  _id?: string;
  secretKey?: string;
  secretValue?: string;
  secretPath?: string;
  environment?: string;
  version?: number;
  type?: string;
  secretComment?: string;
  tags?: Array<{ slug?: string; name?: string }>;
}

export interface InfisicalGateway {
  getSecret(input: {
    projectId: string;
    environment: string;
    secretPath: string;
    secretKey: string;
    version?: string | null;
  }): Promise<InfisicalRawSecret>;
  listSecrets(input: {
    projectId: string;
    environment: string;
    secretPath: string;
    recursive: boolean;
  }): Promise<InfisicalRawSecret[]>;
  updateSecret(input: {
    projectId: string;
    environment: string;
    secretPath: string;
    secretKey: string;
    secretValue: string;
  }): Promise<InfisicalRawSecret>;
}

interface CachedInfisicalToken {
  accessToken: string | null;
  expiresAt: number;
  pending: Promise<string> | null;
}

const infisicalTokens = new Map<string, CachedInfisicalToken>();

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function asOptionalNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function normalizeSiteUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw unprocessable("Infisical site URL must be a valid HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw unprocessable("Infisical site URL must use http or https");
  }
  return url.origin;
}

export function normalizeInfisicalSecretPath(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return DEFAULT_SECRET_PATH;
  const segments = trimmed.split("/").map((segment) => segment.trim()).filter(Boolean);
  for (const segment of segments) {
    if (!/^[A-Za-z0-9_.-]+$/.test(segment) || segment === "." || segment === "..") {
      throw unprocessable(`Invalid Infisical secret path segment: ${segment}`);
    }
  }
  return `/${segments.join("/")}`;
}

function assertSecretKey(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^[A-Za-z0-9_.-]+$/.test(trimmed)) {
    throw unprocessable("Infisical secret key must contain only letters, numbers, _, ., and -");
  }
  return trimmed;
}

export function assertEnvironmentSlug(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || !/^[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw unprocessable("Infisical environment must be an environment slug such as dev, staging, or prod");
  }
  return trimmed;
}

export function parseInfisicalExternalRef(
  externalRef: string,
  defaults: { secretPath: string; environment: string },
): InfisicalSecretRef {
  let rest = externalRef.trim();
  if (!rest) throw unprocessable("Infisical external reference is required");

  let environment = defaults.environment;
  const atIndex = rest.lastIndexOf("@");
  if (atIndex !== -1) {
    environment = assertEnvironmentSlug(rest.slice(atIndex + 1));
    rest = rest.slice(0, atIndex);
  }

  let secretPath = defaults.secretPath;
  let secretKey: string;
  const colonIndex = rest.lastIndexOf(":");
  if (colonIndex !== -1) {
    secretPath = normalizeInfisicalSecretPath(rest.slice(0, colonIndex));
    secretKey = rest.slice(colonIndex + 1);
  } else if (rest.includes("/")) {
    const slashIndex = rest.lastIndexOf("/");
    secretPath = normalizeInfisicalSecretPath(rest.slice(0, slashIndex));
    secretKey = rest.slice(slashIndex + 1);
  } else {
    secretKey = rest;
  }

  return {
    secretPath: normalizeInfisicalSecretPath(secretPath),
    secretKey: assertSecretKey(secretKey),
    environment: assertEnvironmentSlug(environment),
  };
}

export function formatInfisicalExternalRef(ref: InfisicalSecretRef): string {
  return `${ref.secretPath}:${ref.secretKey}@${ref.environment}`;
}

export function parseCsvEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function deploymentSiteUrl(): string {
  const configured = process.env.PAPERCLIP_SECRETS_INFISICAL_SITE_URL?.trim();
  return normalizeSiteUrl(configured || DEFAULT_SITE_URL);
}

export function readInfisicalCredentials(): InfisicalCredentials | null {
  const clientId = process.env.PAPERCLIP_SECRETS_INFISICAL_CLIENT_ID?.trim();
  const clientSecret = process.env.PAPERCLIP_SECRETS_INFISICAL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function missingCredentialEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.PAPERCLIP_SECRETS_INFISICAL_CLIENT_ID?.trim()) {
    missing.push("PAPERCLIP_SECRETS_INFISICAL_CLIENT_ID");
  }
  if (!process.env.PAPERCLIP_SECRETS_INFISICAL_CLIENT_SECRET?.trim()) {
    missing.push("PAPERCLIP_SECRETS_INFISICAL_CLIENT_SECRET");
  }
  return missing;
}

export function assertAllowedSiteUrl(siteUrl: string) {
  const allowed = deploymentSiteUrl();
  if (siteUrl !== allowed) {
    throw unprocessable(
      `Infisical provider vault site URL must match the deployment Infisical site (${allowed}); set PAPERCLIP_SECRETS_INFISICAL_SITE_URL to change it`,
    );
  }
}

export function assertAllowedProject(projectId: string) {
  const allowedProjects = parseCsvEnv("PAPERCLIP_SECRETS_INFISICAL_ALLOWED_PROJECT_IDS");
  if (allowedProjects.length > 0 && !allowedProjects.includes(projectId)) {
    throw unprocessable(
      "Infisical project is not in PAPERCLIP_SECRETS_INFISICAL_ALLOWED_PROJECT_IDS for this deployment",
    );
  }
}

export function classifyInfisicalStatus(status: number, message: string): SecretProviderClientErrorCode {
  if (status === 401 || status === 403) return "access_denied";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 429) return "throttled";
  if (status === 400 || status === 422) return "invalid_request";
  if (status >= 500) return "provider_unavailable";
  if (/fetch failed|ECONN|ENOTFOUND|ETIMEDOUT|network|timeout|aborted/i.test(message)) {
    return "provider_unavailable";
  }
  return "provider_error";
}

export function infisicalSafeMessage(code: SecretProviderClientErrorCode): string {
  switch (code) {
    case "access_denied":
      return "Infisical denied the request. Check the machine identity credentials and its project/environment/path permissions.";
    case "throttled":
      return "Infisical rate-limited the request. Wait and try again.";
    case "not_found":
      return "Infisical could not find the requested secret, environment, or folder.";
    case "conflict":
      return "Infisical reported a conflict for the requested secret.";
    case "invalid_request":
      return "Infisical rejected the request.";
    case "provider_unavailable":
      return "Infisical is unavailable right now.";
    case "provider_error":
    default:
      return "Infisical request failed.";
  }
}

export function normalizeInfisicalError(operation: string, error: unknown): never {
  if (error instanceof SecretProviderClientError) throw error;
  if (error && typeof error === "object" && "status" in error && typeof (error as { status: unknown }).status === "number") {
    throw error;
  }
  const rawMessage = error instanceof Error ? error.message : String(error);
  const code = classifyInfisicalStatus(0, rawMessage);
  throw new SecretProviderClientError({
    code,
    provider: "infisical",
    operation,
    message: infisicalSafeMessage(code),
    rawMessage,
    cause: error,
  });
}

export class InfisicalHttpGateway implements InfisicalGateway {
  constructor(
    private readonly siteUrl: string,
    private readonly credentials: () => InfisicalCredentials | null = readInfisicalCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async getSecret(input: {
    projectId: string;
    environment: string;
    secretPath: string;
    secretKey: string;
    version?: string | null;
  }): Promise<InfisicalRawSecret> {
    const params = new URLSearchParams({
      workspaceId: input.projectId,
      environment: input.environment,
      secretPath: input.secretPath,
      type: "shared",
    });
    if (input.version) params.set("version", input.version);
    const body = await this.request<{ secret?: InfisicalRawSecret }>(
      "getSecret",
      "GET",
      `/api/v3/secrets/raw/${encodeURIComponent(input.secretKey)}?${params.toString()}`,
    );
    if (!body.secret) throw this.error("getSecret", 502, "Infisical response did not include a secret");
    return body.secret;
  }

  async listSecrets(input: {
    projectId: string;
    environment: string;
    secretPath: string;
    recursive: boolean;
  }): Promise<InfisicalRawSecret[]> {
    const params = new URLSearchParams({
      workspaceId: input.projectId,
      environment: input.environment,
      secretPath: input.secretPath,
      recursive: input.recursive ? "true" : "false",
      include_imports: "false",
      expandSecretReferences: "false",
      viewSecretValue: "false",
    });
    const body = await this.request<{ secrets?: InfisicalRawSecret[] }>(
      "listSecrets",
      "GET",
      `/api/v3/secrets/raw?${params.toString()}`,
    );
    if (!Array.isArray(body.secrets)) {
      throw this.error("listSecrets", 502, "Infisical list response did not include a secrets array");
    }
    return body.secrets;
  }

  async updateSecret(input: {
    projectId: string;
    environment: string;
    secretPath: string;
    secretKey: string;
    secretValue: string;
  }): Promise<InfisicalRawSecret> {
    const body = await this.request<{ secret?: InfisicalRawSecret }>(
      "updateSecret",
      "PATCH",
      `/api/v3/secrets/raw/${encodeURIComponent(input.secretKey)}`,
      {
        workspaceId: input.projectId,
        environment: input.environment,
        secretPath: input.secretPath,
        secretValue: input.secretValue,
        type: "shared",
      },
    );
    if (!body.secret) throw this.error("updateSecret", 502, "Infisical response did not include a secret");
    return body.secret;
  }

  private cacheKey(credentials: InfisicalCredentials) {
    return `${this.siteUrl}\0${credentials.clientId}\0${sha256Hex(credentials.clientSecret)}`;
  }

  async accessToken(): Promise<string> {
    const credentials = this.credentials();
    if (!credentials) {
      throw new SecretProviderClientError({
        code: "access_denied",
        provider: "infisical",
        operation: "login",
        message: `Infisical machine identity credentials are not configured: ${missingCredentialEnv().join(", ")}`,
      });
    }
    const key = this.cacheKey(credentials);
    let cached = infisicalTokens.get(key);
    if (!cached) {
      cached = { accessToken: null, expiresAt: 0, pending: null };
      infisicalTokens.set(key, cached);
    }
    const now = Date.now();
    if (cached.accessToken && cached.expiresAt > now) return cached.accessToken;
    if (cached.pending) return cached.pending;

    const entry = cached;
    entry.pending = (async () => {
      const body = await this.send<{ accessToken?: string; expiresIn?: number }>(
        "login",
        "POST",
        "/api/v1/auth/universal-auth/login",
        { clientId: credentials.clientId, clientSecret: credentials.clientSecret },
        null,
      );
      if (!body.accessToken) {
        throw this.error("login", 502, "Infisical login response did not include an access token");
      }
      const expiresInMs =
        typeof body.expiresIn === "number" && body.expiresIn > 0 ? body.expiresIn * 1000 : INFISICAL_TOKEN_MAX_CACHE_MS;
      entry.accessToken = body.accessToken;
      entry.expiresAt = now + Math.min(
        INFISICAL_TOKEN_MAX_CACHE_MS,
        Math.max(0, expiresInMs - INFISICAL_TOKEN_EXPIRATION_SKEW_MS),
      );
      return body.accessToken;
    })().finally(() => {
      entry.pending = null;
    });
    return entry.pending;
  }

  private invalidateToken(rejectedToken: string) {
    const credentials = this.credentials();
    if (!credentials) return;
    const cached = infisicalTokens.get(this.cacheKey(credentials));
    if (cached && cached.accessToken === rejectedToken) {
      cached.accessToken = null;
      cached.expiresAt = 0;
    }
  }

  private async request<T>(
    operation: string,
    method: string,
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<T> {
    const token = await this.accessToken();
    try {
      return await this.send<T>(operation, method, path, payload, token);
    } catch (error) {
      if (error instanceof SecretProviderClientError && error.rawMessage?.startsWith("401:")) {
        this.invalidateToken(token);
        const retryToken = await this.accessToken();
        return this.send<T>(operation, method, path, payload, retryToken);
      }
      throw error;
    }
  }

  private async send<T>(
    operation: string,
    method: string,
    path: string,
    payload: Record<string, unknown> | undefined,
    token: string | null,
  ): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json" };
    if (payload) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.siteUrl}${path}`, {
        method,
        headers,
        body: payload ? JSON.stringify(payload) : undefined,
        redirect: "error",
        signal: AbortSignal.timeout(INFISICAL_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const rawMessage = error instanceof Error ? error.message : String(error);
      throw new SecretProviderClientError({
        code: "provider_unavailable",
        provider: "infisical",
        operation,
        message: infisicalSafeMessage("provider_unavailable"),
        rawMessage,
        cause: error,
      });
    }
    const text = await response.text();
    let parsed: Record<string, unknown> | null = null;
    if (text) {
      try {
        const json: unknown = JSON.parse(text);
        if (json && typeof json === "object" && !Array.isArray(json)) parsed = json as Record<string, unknown>;
      } catch {
        parsed = null;
      }
    }
    if (!response.ok) {
      const message = typeof parsed?.message === "string" ? parsed.message : response.statusText || "Request failed";
      throw this.error(operation, response.status, message);
    }
    if (!parsed) {
      throw this.error(operation, 502, "Infisical returned a response that was not a JSON object");
    }
    return parsed as T;
  }

  private error(operation: string, status: number, message: string) {
    const code = classifyInfisicalStatus(status, message);
    return new SecretProviderClientError({
      code,
      provider: "infisical",
      operation,
      message: infisicalSafeMessage(code),
      rawMessage: `${status}: ${message}`,
    });
  }
}

export function resetInfisicalTokenCache() {
  infisicalTokens.clear();
}
