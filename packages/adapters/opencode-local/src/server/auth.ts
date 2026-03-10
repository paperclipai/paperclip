import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function hasNonEmptyEnvValue(env: Record<string, string>, key: string): boolean {
  return typeof env[key] === "string" && env[key].trim().length > 0;
}

function defaultOpenCodeAuthPaths(homeDir: string): string[] {
  return [
    path.join(homeDir, ".local", "share", "opencode", "auth.json"),
    path.join(homeDir, ".config", "opencode", "auth.json"),
  ];
}

async function readLiteLlmApiKeyFromOpenCodeAuth(
  authPaths: string[],
): Promise<{ key: string; source: string } | null> {
  for (const authPath of authPaths) {
    try {
      const raw = await fs.readFile(authPath, "utf8");
      const parsed = JSON.parse(raw) as {
        litellm?: {
          key?: unknown;
        };
      };
      const key = typeof parsed?.litellm?.key === "string" ? parsed.litellm.key.trim() : "";
      if (key) {
        return { key, source: authPath };
      }
    } catch {
      continue;
    }
  }

  return null;
}

export async function hydrateLiteLlmApiKey(
  env: Record<string, string>,
  options?: { homeDir?: string; authPaths?: string[] },
): Promise<
  | { env: Record<string, string>; source: "existing_litellm_env" | "openai_env" | "opencode_auth" | "missing"; detail?: string }
> {
  if (hasNonEmptyEnvValue(env, "LITELLM_API_KEY")) {
    return { env, source: "existing_litellm_env" };
  }

  const openAiKey = typeof env.OPENAI_API_KEY === "string" ? env.OPENAI_API_KEY.trim() : "";
  if (openAiKey) {
    return {
      env: { ...env, LITELLM_API_KEY: openAiKey },
      source: "openai_env",
      detail: "Copied OPENAI_API_KEY into LITELLM_API_KEY for the OpenCode litellm provider.",
    };
  }

  const homeDir = options?.homeDir ?? os.homedir();
  const authPaths = options?.authPaths ?? defaultOpenCodeAuthPaths(homeDir);
  const auth = await readLiteLlmApiKeyFromOpenCodeAuth(authPaths);
  if (auth) {
    return {
      env: { ...env, LITELLM_API_KEY: auth.key },
      source: "opencode_auth",
      detail: auth.source,
    };
  }

  return { env, source: "missing" };
}
