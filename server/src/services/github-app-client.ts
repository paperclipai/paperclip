import { createHash, createPrivateKey, createSign } from "node:crypto";
import { z } from "zod";
import type { ConnectionGrant } from "@paperclipai/shared";
import { HttpError, unprocessable } from "../errors.js";

export const GITHUB_APP_METHOD = "app-installation";
export const GITHUB_APP_MCP_URL = "https://api.githubcopilot.com/mcp/";
export const GITHUB_APP_KEY_PATH = "credentials.privateKey";
const FRESH_MS = 5 * 60_000;
const MAX_CACHE = 128;
type Metadata = NonNullable<ConnectionGrant["providerTenant"]>["github"];
export type GitHubAppConfig = {
  version: 1;
  appId: string;
  installationId: string;
  repositories: string[];
  permissions: Record<string, "read" | "write" | "admin">;
};
const profiles = {
  read: { contents: "read", pull_requests: "read", issues: "read" },
  author: { contents: "write", pull_requests: "write", issues: "read" },
  reviewer: { contents: "read", pull_requests: "write", issues: "read" },
} as const;
const permissionLevels = { read: 1, write: 2, admin: 3 } as const;
const customPermissionsSchema = z.record(
  z.string().regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/),
  z.enum(["read", "write", "admin"]),
).refine(permissions => Object.keys(permissions).length > 0 && Object.keys(permissions).length <= 100);

function parseCustomPermissions(value: unknown): GitHubAppConfig["permissions"] {
  if (typeof value !== "string" || value.length > 10_000) githubAppFailure("custom_permissions");
  let decoded: unknown;
  try { decoded = JSON.parse(value); } catch { githubAppFailure("custom_permissions"); }
  const parsed = customPermissionsSchema.safeParse(decoded);
  if (!parsed.success) githubAppFailure("custom_permissions");
  return Object.fromEntries(Object.entries(parsed.data).sort(([a], [b]) => a.localeCompare(b)));
}
const failureReasons = {
  configuration: "Check the App ID or Client ID, numeric installation ID, repository names, and permission template or custom permissions.",
  custom_permissions: 'Custom permissions must be a non-empty JSON object of GitHub permission names and "read", "write", or "admin" levels (at most 100 entries).',
  private_key: "The private key could not be read as an RSA PEM. Paste the complete key with its header, footer, and line breaks.",
  app_authentication: "GitHub could not authenticate the App. Check the App ID or Client ID, matching private key, and container clock.",
  app_identity: "GitHub returned a different App identity. Check the App ID or Client ID.",
  installation: "GitHub could not verify this installation for the App. Check the installation ID and that the installation is active.",
  permissions: "The installation lacks the selected permissions. Check the permission template or custom permissions and approve any updated permissions in GitHub installation settings.",
  token: "GitHub could not issue a restricted installation token. Check that every selected repository belongs to this installation and the requested permissions are granted.",
  bot_identity: "GitHub could not verify the App's bot account.",
  repositories: "GitHub could not verify the selected repositories. Use owner/repository names and grant the installation access to each one.",
  network: "The GitHub request failed. Check the container's network access to api.github.com and try again.",
} as const;
type FailureReason = keyof typeof failureReasons;
function githubAppDiagnostic(reason: unknown) {
  const safeReason = typeof reason === "string" && Object.hasOwn(failureReasons, reason)
    ? reason as FailureReason : undefined;
  return {
    code: "github_app_access_unavailable" as const,
    ...(safeReason ? { reason: safeReason } : {}),
    message: `GitHub App access is unavailable. ${safeReason ? failureReasons[safeReason] : "Check the App key, installation, selected repositories, and permissions."}`,
  };
}
export function githubAppFailure(reason?: FailureReason): never {
  const { message, ...details } = githubAppDiagnostic(reason);
  throw unprocessable(message, details);
}
export function sanitizeGitHubAppFailure(error: unknown) {
  if (!(error instanceof HttpError)) return null;
  const details = error.details as { code?: unknown; reason?: unknown } | undefined;
  return details?.code === "github_app_access_unavailable" ? githubAppDiagnostic(details.reason) : null;
}
export function rethrowGitHubAppFailure(error: unknown): never {
  githubAppFailure(sanitizeGitHubAppFailure(error)?.reason);
}
export function isGitHubAppConnection(connection: { config: Record<string, unknown> }) {
  return connection.config.sourceTemplateKey === "github" && connection.config.connectionMethodKey === GITHUB_APP_METHOD;
}
export function parseGitHubAppConfig(value: unknown): GitHubAppConfig {
  const v = value as Record<string, unknown> | null;
  if (!v || (v.version !== undefined && v.version !== "1" && v.version !== 1) || !/^(?:[1-9]\d*|Iv[0-9][A-Za-z0-9.]{1,97})$/.test(String(v.appId ?? "")) || !/^[1-9]\d*$/.test(String(v.installationId ?? ""))
    || typeof v.repositories !== "string" || (v.permissionProfile !== "custom" && !Object.hasOwn(profiles, String(v.permissionProfile)))) githubAppFailure("configuration");
  const repositories = [...new Set(v.repositories.split(/[,\n]/).map(s => s.trim().toLowerCase()).filter(Boolean))].sort();
  if (!repositories.length || repositories.length > 500 || repositories.some(r => !/^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/.test(r))) githubAppFailure("configuration");
  return { version: 1, appId: String(v.appId), installationId: String(v.installationId), repositories,
    permissions: v.permissionProfile === "custom" ? parseCustomPermissions(v.customPermissions) : { ...profiles[v.permissionProfile as keyof typeof profiles] } };
}
export function githubAppJwt(appId: string, privateKey: string, now = Date.now()) {
  const key = createPrivateKey(privateKey);
  if (key.asymmetricKeyType !== "rsa") githubAppFailure();
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const issued = Math.floor(now / 1000) - 60;
  const body = Buffer.from(JSON.stringify({ iat: issued, exp: issued + 600, iss: appId })).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${body}`);
  return `${header}.${body}.${signer.sign(key).toString("base64url")}`;
}
export type AppCredential = { token: string; expiresAt: number; github: NonNullable<Metadata> };

const providerId = z.number().int().positive().safe();
const appSchema = z.object({ id: providerId, client_id: z.string().optional(), slug: z.string().regex(/^[a-z0-9-]+$/) });
const installationSchema = z.object({
  id: providerId,
  app_id: providerId,
  suspended_at: z.string().nullable().optional(),
  account: z.object({ login: z.string().min(1) }),
  permissions: z.record(z.string(), z.string()),
});
const tokenSchema = z.object({ token: z.string().min(1), expires_at: z.string() });
const botSchema = z.object({ id: providerId, login: z.string(), type: z.literal("Bot") });
const repositoriesSchema = z.object({ repositories: z.array(z.object({
  id: providerId, full_name: z.string(), private: z.boolean().optional(),
})) });

export function createGitHubAppClient(fetcher: typeof fetch = fetch, clock = Date.now) {
  const cache = new Map<string, { until: number; settled: boolean; promise: Promise<AppCredential> }>();
  async function request<T>(path: string, token: string, reason: FailureReason, schema: z.ZodType<T>, body?: unknown): Promise<T> {
    let response: Response;
    try { response = await fetcher(`https://api.github.com${path}`, {
      method: body ? "POST" : "GET", redirect: "error", signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }); } catch { githubAppFailure("network"); }
    if (!response.ok) githubAppFailure(reason);
    try {
      const parsed = schema.safeParse(await response.json());
      if (parsed.success) return parsed.data;
    } catch {}
    githubAppFailure(reason);
  }
  async function acquire(config: GitHubAppConfig, key: string): Promise<AppCredential> {
    let jwt: string;
    try { jwt = githubAppJwt(config.appId, key, clock()); } catch { githubAppFailure("private_key"); }
    const app = await request("/app", jwt, "app_authentication", appSchema);
    const configuredAppId = config.appId.startsWith("Iv") ? app.client_id : String(app.id);
    if (configuredAppId !== config.appId) githubAppFailure("app_identity");
    const installation = await request(`/app/installations/${config.installationId}`, jwt, "installation", installationSchema);
    if (String(installation.id) !== config.installationId || installation.app_id !== app.id
      || installation.suspended_at) githubAppFailure("installation");
    const owner = installation.account.login.toLowerCase();
    if (config.repositories.some(repo => repo.split("/")[0] !== owner)) githubAppFailure("repositories");
    for (const [name, level] of Object.entries(config.permissions)) {
      const allowed = installation.permissions?.[name];
      if (!Object.hasOwn(permissionLevels, allowed ?? "")
        || permissionLevels[allowed as keyof typeof permissionLevels] < permissionLevels[level]) githubAppFailure("permissions");
    }
    const minted = await request(`/app/installations/${config.installationId}/access_tokens`, jwt, "token", tokenSchema, {
      repositories: config.repositories.map(repo => repo.split("/")[1]), permissions: config.permissions,
    });
    const expiresAt = Date.parse(minted.expires_at);
    if (!minted.token.trim() || !Number.isFinite(expiresAt) || expiresAt <= clock() + 60_000) githubAppFailure("token");
    const bot = await request(`/users/${encodeURIComponent(`${app.slug}[bot]`)}`, minted.token, "bot_identity", botSchema);
    if (bot.login !== `${app.slug}[bot]`) githubAppFailure("bot_identity");
    const repositories: NonNullable<NonNullable<Metadata>["repositories"]> = [];
    for (let page = 1; page <= 6; page++) {
      const data = await request(`/installation/repositories?per_page=100&page=${page}`, minted.token, "repositories", repositoriesSchema);
      for (const repo of data.repositories) {
        if (!config.repositories.includes(repo.full_name.toLowerCase())) githubAppFailure("repositories");
        repositories.push({ id: String(repo.id), fullName: repo.full_name, installationId: config.installationId, private: repo.private === true });
      }
      if (data.repositories.length < 100) break;
      if (page === 6) githubAppFailure("repositories");
    }
    if (new Set(repositories.map(r => r.fullName.toLowerCase())).size !== config.repositories.length) githubAppFailure("repositories");
    return { token: minted.token, expiresAt, github: {
      userId: String(bot.id), login: bot.login, appSlug: app.slug,
      installationCount: 1, repositoryCount: repositories.length, repositorySelection: "selected",
      installationIds: [config.installationId], installationOwnerLogins: [installation.account.login], repositories,
      managementUrl: `https://github.com/settings/installations/${config.installationId}`,
      lastAccessRefreshAt: new Date(clock()).toISOString(),
    } };
  }
  return {
    async acquire(namespace: string, config: GitHubAppConfig, key: string, force = false) {
      const hash = createHash("sha256").update(JSON.stringify(config)).update(key).digest("hex");
      const cacheKey = `${namespace}:${hash}`;
      const current = cache.get(cacheKey);
      if (current && !current.settled) return current.promise;
      if (!force && current && current.until > clock()) return current.promise;
      if ([...cache.values()].filter(entry => !entry.settled).length >= 16) githubAppFailure();
      if (cache.size >= MAX_CACHE) {
        const oldest = [...cache.entries()].find(([, entry]) => entry.settled);
        if (!oldest) githubAppFailure();
        cache.delete(oldest[0]);
      }
      const entry = { until: clock() + FRESH_MS, settled: false, promise: acquire(config, key).catch(rethrowGitHubAppFailure) };
      cache.set(cacheKey, entry);
      try {
        const result = await entry.promise;
        entry.until = Math.min(entry.until, result.expiresAt - 60_000);
        entry.settled = true;
        return result;
      } catch (error) {
        if (cache.get(cacheKey) === entry) cache.delete(cacheKey);
        throw error;
      }
    },
  };
}
