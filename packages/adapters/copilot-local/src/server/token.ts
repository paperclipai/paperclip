import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { COPILOT_TOKEN_URL } from "../index.js";

const execFileAsync = promisify(execFile);

export interface CopilotToken {
  token: string;
  expiresAt: Date;
}

/**
 * Exchange a GitHub PAT for a short-lived GitHub Copilot API token.
 * The returned token is valid for ~30 minutes and works with api.githubcopilot.com.
 */
export async function exchangeGithubToken(githubToken: string): Promise<CopilotToken> {
  const res = await fetch(COPILOT_TOKEN_URL, {
    headers: {
      Authorization: `Bearer ${githubToken}`,
      Accept: "application/json",
      "User-Agent": "paperclip-copilot-adapter/1.0",
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (res.status === 401) {
    throw new Error(
      "GitHub token rejected by Copilot API. Ensure your PAT has the `read:user` or `copilot` scope and your account has an active Copilot subscription.",
    );
  }
  if (res.status === 403) {
    throw new Error(
      "GitHub Copilot access forbidden. Your account may not have an active Copilot subscription.",
    );
  }
  if (!res.ok) {
    throw new Error(
      `Failed to exchange GitHub token for Copilot token: HTTP ${res.status} ${res.statusText}`,
    );
  }

  let data: { token?: unknown; expires_at?: unknown };
  try {
    data = await res.json();
  } catch (err) {
    throw new Error(
      `Copilot token exchange returned non-JSON response (HTTP ${res.status}). ` +
        `The endpoint may be unavailable or blocked. Detail: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof data.token !== "string" || !data.token) {
    throw new Error("Copilot token exchange returned an empty token.");
  }

  // expires_at may be a unix timestamp (number) or an ISO string
  const expiresAt =
    typeof data.expires_at === "number"
      ? new Date(data.expires_at * 1000)
      : new Date(data.expires_at as string);
  if (isNaN(expiresAt.getTime())) {
    throw new Error(`Copilot token exchange returned an invalid expires_at value: ${JSON.stringify(data.expires_at)}`);
  }

  return { token: data.token, expiresAt };
}

/**
 * Resolve a ready-to-use Copilot API token from config env vars or the gh CLI.
 *
 * Priority:
 * 1. GITHUB_COPILOT_TOKEN — pre-fetched short-lived token, used as-is
 * 2. GITHUB_TOKEN — GitHub PAT, exchanged for a Copilot token
 * 3. gh auth token — GitHub CLI login, result exchanged for a Copilot token
 */
export async function resolveCopilotToken(
  env: Record<string, string>,
): Promise<string> {
  // 1. Pre-fetched short-lived Copilot token
  const directToken = env.GITHUB_COPILOT_TOKEN?.trim();
  if (directToken) return directToken;

  // 2. GitHub PAT
  const githubToken = env.GITHUB_TOKEN?.trim();
  if (githubToken) {
    const result = await exchangeGithubToken(githubToken);
    return result.token;
  }

  // 3. Fall back to gh CLI
  try {
    const { stdout } = await execFileAsync("gh", ["auth", "token", "--hostname", "github.com"], {
      env: { ...process.env, ...env },
      timeout: 10_000,
    });
    const ghToken = stdout.trim();
    if (!ghToken) throw new Error("gh auth token returned empty output.");
    const result = await exchangeGithubToken(ghToken);
    return result.token;
  } catch (err) {
    throw new Error(
      `Could not resolve a GitHub token for Copilot. ` +
        `Set GITHUB_TOKEN or GITHUB_COPILOT_TOKEN in the adapter env, or run \`gh auth login\`. ` +
        `Detail: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
