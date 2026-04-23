/**
 * Copilot token resolution and auth helpers for copilot_local.
 *
 * Credential search order:
 *   1. COPILOT_GITHUB_TOKEN env var
 *   2. GH_TOKEN env var
 *   3. GITHUB_TOKEN env var
 *   4. `gh auth token` CLI fallback (with --hostname for GHE)
 */
import { runChildProcess, fetchWithRetry } from "@paperclipai/adapter-utils/server-utils";

const COPILOT_TOKEN_ENV_VARS = [
  "COPILOT_GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_TOKEN",
] as const;

/**
 * Validate that a token is a supported type for the Copilot API.
 * Classic PATs (ghp_) are explicitly rejected.
 */
export function validateCopilotToken(token: string): { valid: boolean; reason?: string } {
  const trimmed = token.trim();
  if (!trimmed) return { valid: false, reason: "Token is empty" };
  if (trimmed.startsWith("ghp_")) {
    return {
      valid: false,
      reason: "Classic personal access tokens (ghp_) are not supported by the Copilot API. Use a fine-grained PAT (github_pat_) or OAuth token (gho_) instead.",
    };
  }
  return { valid: true };
}

export interface CopilotTokenResult {
  token: string;
  source: string;
}

/**
 * Resolve a Copilot API token from environment or gh CLI.
 *
 * @param env      - The environment to search (usually process.env merged with adapter env)
 * @param gheHost  - GitHub Enterprise hostname (empty or undefined = github.com)
 * @param tokenSource - "auto" (default), "env", or "gh_cli"
 */
export async function resolveCopilotToken(
  env: Record<string, string | undefined>,
  gheHost?: string,
  tokenSource: string = "auto",
): Promise<CopilotTokenResult | null> {
  // Step 1: Try environment variables (unless tokenSource is "gh_cli")
  if (tokenSource !== "gh_cli") {
    for (const envVar of COPILOT_TOKEN_ENV_VARS) {
      const value = env[envVar]?.trim();
      if (value && value.length > 0) {
        const validation = validateCopilotToken(value);
        if (validation.valid) {
          return { token: value, source: `env:${envVar}` };
        }
      }
    }
    if (tokenSource === "env") return null;
  }

  // Step 2: Try gh auth token CLI (strip GH_TOKEN/GITHUB_TOKEN from env so gh reads its own store)
  try {
    const args = ["auth", "token"];
    if (gheHost) {
      args.push("--hostname", gheHost);
    }
    const cleanEnv = Object.fromEntries(
      Object.entries(env)
        .filter((e): e is [string, string] => typeof e[1] === "string")
        .filter(([k]) => k !== "GITHUB_TOKEN" && k !== "GH_TOKEN"),
    );
    const result = await runChildProcess(
      `copilot-token-resolve-${Date.now()}`,
      "gh",
      args,
      {
        cwd: process.cwd(),
        env: cleanEnv,
        timeoutSec: 10,
        graceSec: 2,
        onLog: async () => {},
      },
    );
    const token = result.stdout.trim();
    if (token && (result.exitCode ?? 1) === 0) {
      const validation = validateCopilotToken(token);
      if (validation.valid) {
        return { token, source: `gh_cli${gheHost ? `:${gheHost}` : ""}` };
      }
    }
  } catch {
    // gh CLI not available or failed — fall through
  }

  return null;
}

/**
 * Build Copilot API request headers.
 */
export function buildCopilotHeaders(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
    "Editor-Version": "vscode/1.104.1",
    "Editor-Plugin-Version": "copilot-chat/0.27.2025070801",
    "User-Agent": "GitHubCopilotChat/0.27.2025070801",
    "Copilot-Integration-Id": "vscode-chat",
    "Openai-Intent": "conversation-edits",
  };
}

/**
 * Detect if a Copilot error indicates auth problems.
 */
export function isCopilotAuthError(errorMessage: string | null, stdout: string, stderr: string): boolean {
  const combined = `${errorMessage ?? ""}\n${stdout}\n${stderr}`;
  return /(?:unauthorized|401|403|invalid.*token|auth.*required|not.*authenticated)/i.test(combined);
}

/**
 * Response from the /copilot_internal/user endpoint.
 */
interface CopilotUserInfo {
  login: string;
  copilot_plan: string;
  chat_enabled: boolean;
  endpoints: {
    api: string;
    proxy?: string;
    telemetry?: string;
    "origin-tracker"?: string;
  };
}

// In-memory cache for discovered endpoints.
// Keyed by token hash + host to avoid cross-tenant cache poisoning in
// multi-company deployments where different users on the same gheHost
// may resolve to different Copilot plans (individual vs. business).
const endpointCache = new Map<string, { url: string; expiresAt: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

/** Cheap cache key that avoids storing the raw token in the key. */
function cacheKey(token: string, gheHost?: string): string {
  // Use first 8 + last 4 chars as a fingerprint — not cryptographic,
  // but sufficient for dedup across concurrent callers.
  const fp = token.length > 12
    ? `${token.slice(0, 8)}…${token.slice(-4)}`
    : token;
  return `${fp}@${gheHost || "github.com"}`;
}

/**
 * Discover the correct Copilot API base URL by calling /copilot_internal/user.
 *
 * The Copilot API URL is tenant/plan-specific:
 *   - github.com individual: https://api.individual.githubcopilot.com
 *   - github.com business:   https://api.business.githubcopilot.com
 *   - GHE (e.g. foo.ghe.com): https://copilot-api.foo.ghe.com
 *
 * Results are cached for 10 minutes.
 */
export async function discoverCopilotApiUrl(
  token: string,
  gheHost?: string,
): Promise<{ apiUrl: string; userInfo: CopilotUserInfo } | null> {
  const ck = cacheKey(token, gheHost);
  const cached = endpointCache.get(ck);
  if (cached && cached.expiresAt > Date.now()) {
    return { apiUrl: cached.url, userInfo: { login: "", copilot_plan: "", chat_enabled: true, endpoints: { api: cached.url } } };
  }

  const apiHost = gheHost ? `api.${gheHost}` : "api.github.com";
  const url = `https://${apiHost}/copilot_internal/user`;

  try {
    const response = await fetchWithRetry(url, {
      method: "GET",
      headers: {
        Authorization: `token ${token}`,
        "Editor-Version": "vscode/1.104.1",
        "Copilot-Integration-Id": "vscode-chat",
        Accept: "application/json",
      },
    }, {
      timeoutMs: 10_000,
      maxRetries: 2,
      retryableStatuses: [429, 502, 503, 504],
    });

    if (!response.ok) return null;

    const data = (await response.json()) as CopilotUserInfo;
    const apiUrl = data.endpoints?.api;
    if (!apiUrl) return null;

    const cleanUrl = apiUrl.replace(/\/+$/, "");
    endpointCache.set(ck, { url: cleanUrl, expiresAt: Date.now() + CACHE_TTL_MS });

    return { apiUrl: cleanUrl, userInfo: data };
  } catch {
    return null;
  }
}
