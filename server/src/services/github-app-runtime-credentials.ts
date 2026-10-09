import { createSign } from "node:crypto";

export const GITHUB_APP_RUNTIME_SECRET_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_APP_PRIVATE_KEY",
] as const;

export const GITHUB_APP_RUNTIME_TOKEN_KEYS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

type RuntimeEnv = Record<string, unknown>;

export type DirectGitHubAppRuntime = {
  token: string;
  expiresAt: string | null;
};

function readEnv(env: RuntimeEnv, key: string): string {
  return typeof env[key] === "string" ? env[key].trim() : "";
}

function base64UrlJson(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function normalizePrivateKey(value: string): string {
  return value.replaceAll("\\n", "\n");
}

function validateNumericId(name: string, value: string): void {
  if (!/^\d+$/.test(value)) {
    throw new Error(`GitHub App ${name} is invalid`);
  }
}

/**
 * Mint one short-lived installation token from App credentials already resolved
 * by Paperclip's secret system. The returned token is intentionally an
 * in-memory value; this helper never writes it to config, a file, or logs.
 */
export async function mintDirectGitHubAppToken(input: {
  env: RuntimeEnv;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
}): Promise<DirectGitHubAppRuntime | null> {
  const appId = readEnv(input.env, "GITHUB_APP_ID");
  const installationId = readEnv(input.env, "GITHUB_APP_INSTALLATION_ID");
  const privateKey = normalizePrivateKey(readEnv(input.env, "GITHUB_APP_PRIVATE_KEY"));
  const present = [appId, installationId, privateKey].filter(Boolean).length;
  if (present === 0) return null;
  if (present !== 3) {
    throw new Error("GitHub App runtime binding is incomplete");
  }
  validateNumericId("ID", appId);
  validateNumericId("installation ID", installationId);

  const now = input.now ?? (() => Date.now());
  const issuedAt = Math.floor(now() / 1000) - 30;
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: issuedAt,
    exp: issuedAt + 540,
    iss: appId,
  });
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const appJwt = `${header}.${payload}.${signer.sign(privateKey, "base64url")}`;

  const fetchImpl = input.fetch ?? globalThis.fetch;
  const response = await fetchImpl(
    `https://api.github.com/app/installations/${encodeURIComponent(installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${appJwt}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: "{}",
      signal: AbortSignal.timeout(15_000),
    },
  );
  const body = (await response.json().catch(() => ({}))) as {
    token?: unknown;
    expires_at?: unknown;
  };
  if (!response.ok || typeof body.token !== "string" || !body.token.trim()) {
    throw new Error(`GitHub App installation token request failed (HTTP ${response.status})`);
  }
  return {
    token: body.token,
    expiresAt: typeof body.expires_at === "string" ? body.expires_at : null,
  };
}

/**
 * Replace resolved App material with the installation token that the agent
 * process needs. The App ID, installation ID, and private key never cross the
 * Paperclip controller/agent boundary.
 */
export function applyDirectGitHubAppRuntimeToken(
  env: RuntimeEnv,
  runtime: DirectGitHubAppRuntime,
): Record<string, unknown> {
  const next = { ...env };
  for (const key of GITHUB_APP_RUNTIME_SECRET_KEYS) delete next[key];
  next.GH_TOKEN = runtime.token;
  next.GITHUB_TOKEN = runtime.token;
  return next;
}
