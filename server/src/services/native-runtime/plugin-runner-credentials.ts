import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { copyBackCodexAuth } from "@paperclipai/adapter-codex-local/server";
import { environmentTaskCredentialSchema, type PluginEnvironmentTaskCredential } from "@paperclipai/plugin-sdk";
import { readLocalAiCredentialFile } from "../local-ai-credential-file.js";

interface PreparedPluginRunnerCredentials {
  githubBroker?: { url: string; token: string };
  accountIdentity?: string;
  credential?: PluginEnvironmentTaskCredential;
  needsWriteback?: boolean;
  onCredentials?: (snapshot: PluginEnvironmentTaskCredential) => Promise<void>;
}

/** Transfer only the selected account. Provider configuration stays at the dedicated provider boundary. */
export async function preparePluginRunnerCredentials(input: {
  provider: string;
  identity?: string;
  accountIdentity?: string;
  home?: string;
  environment: NodeJS.ProcessEnv;
}): Promise<PreparedPluginRunnerCredentials> {
  const github = input.environment.PAPERCLIP_GITHUB_BROKER_TOKEN ? { githubBroker: {
    url: input.environment.PAPERCLIP_GITHUB_BROKER_URL ?? "",
    token: input.environment.PAPERCLIP_GITHUB_BROKER_TOKEN,
  } } : {};
  if (!input.identity) return github;
  const accountIdentity = input.accountIdentity ?? input.identity;
  if (input.provider === "codex") {
    if (!input.home) throw new Error("Plugin Runner selected credential home unavailable");
    const hostAuthPath = join(await realpath(input.home), "auth.json");
    const authJson = await readLocalAiCredentialFile(hostAuthPath);
    const parsed = JSON.parse(authJson);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Plugin Runner selected credential invalid");
    const credential = environmentTaskCredentialSchema.parse({ type: "codex-auth-json", authJson });
    return { ...github, accountIdentity, credential, needsWriteback: !!parsed.tokens,
      onCredentials: async (snapshot: PluginEnvironmentTaskCredential) => {
        if (snapshot.type !== "codex-auth-json") throw new Error("Plugin Runner credential provider mismatch");
        await copyBackCodexAuth({ hostAuthPath, readSandboxAuth: async () => Buffer.from(snapshot.authJson), log: () => {} });
      },
    };
  }
  if (input.provider === "claude") {
    if (input.environment.ANTHROPIC_BASE_URL || input.environment.ANTHROPIC_AUTH_TOKEN) {
      throw new Error("Plugin Runner does not support the selected provider routing");
    }
    const environment = Object.fromEntries(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]
      .flatMap(key => input.environment[key] ? [[key, input.environment[key]]] : []));
    return { ...github, accountIdentity, credential: environmentTaskCredentialSchema.parse({ type: "claude-env", environment }) };
  }
  throw new Error("Plugin Runner does not support the selected credential provider");
}
