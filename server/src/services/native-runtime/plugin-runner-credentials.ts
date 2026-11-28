import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { copyBackCodexAuth } from "@paperclipai/adapter-codex-local/server";
import { hasUsableGrokAuthValue, parseGrokAuthPayload } from "@paperclipai/adapter-grok-local/server";
import {
  ENVIRONMENT_TASK_PROVIDER_CREDENTIAL_KEY_SETS, environmentTaskCredentialSchema,
  type PluginEnvironmentTaskCredential, type PluginEnvironmentTaskCredentialProvider,
} from "@paperclipai/plugin-sdk";
import { readLocalAiCredentialFile } from "../local-ai-credential-file.js";
import { sanitizeAntigravityCredential } from "../../vendor/paperclip-runner/index.js";

const ANTIGRAVITY_SIGN_IN_ENV = "PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET";

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
    const credential = environmentTaskCredentialSchema.parse({ type: "auth-file", provider: "codex", content: authJson });
    return { ...github, accountIdentity, credential, needsWriteback: !!parsed.tokens,
      onCredentials: async (snapshot: PluginEnvironmentTaskCredential) => {
        if (snapshot.type !== "auth-file" || snapshot.provider !== "codex") throw new Error("Plugin Runner credential provider mismatch");
        await copyBackCodexAuth({ hostAuthPath, readSandboxAuth: async () => Buffer.from(snapshot.content), log: () => {} });
      },
    };
  }
  if (input.provider === "grok" && !input.environment.XAI_API_KEY) {
    // A Grok subscription travels as the saved sign-in file. Its refreshed copy
    // always returns through the managed account writeback.
    if (input.environment.XAI_BASE_URL) throw new Error("Plugin Runner does not support the selected provider routing");
    if (!input.home) throw new Error("Plugin Runner selected credential home unavailable");
    const content = await readLocalAiCredentialFile(join(await realpath(input.home), "auth.json"));
    let usable = false;
    try {
      const parsed = parseGrokAuthPayload(JSON.parse(content));
      usable = parsed !== null && hasUsableGrokAuthValue(parsed.value);
    } catch { /* Do not expose credential bytes through JSON parser errors. */ }
    if (!usable) throw new Error("Plugin Runner selected credential invalid");
    return { ...github, accountIdentity, needsWriteback: true,
      credential: environmentTaskCredentialSchema.parse({ type: "auth-file", provider: "grok", content }) };
  }
  if (input.provider === "claude") {
    if (input.environment.ANTHROPIC_BASE_URL || input.environment.ANTHROPIC_AUTH_TOKEN) {
      throw new Error("Plugin Runner does not support the selected provider routing");
    }
    const environment = Object.fromEntries(["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]
      .flatMap(key => input.environment[key] ? [[key, input.environment[key]]] : []));
    return { ...github, accountIdentity, credential: environmentTaskCredentialSchema.parse({ type: "claude-env", environment }) };
  }
  if (input.provider === "grok" || input.provider === "copilot" || input.provider === "opencode" || input.provider === "antigravity") {
    const provider: PluginEnvironmentTaskCredentialProvider = input.provider;
    if (provider === "grok") {
      if (input.environment.XAI_BASE_URL) throw new Error("Plugin Runner does not support the selected provider routing");
    }
    if (provider === "antigravity") {
      if (input.environment[ANTIGRAVITY_SIGN_IN_ENV]?.trim()) throw new Error("Plugin Runner selected credential unavailable");
      if (!input.environment.GEMINI_API_KEY?.trim()) {
        if (!input.home) throw new Error("Google Antigravity needs a Gemini API key or a saved Google sign-in.");
        let authJson: string;
        try {
          authJson = sanitizeAntigravityCredential(await readLocalAiCredentialFile(join(await realpath(input.home), "antigravity-acp", "acp_token.json")));
        } catch {
          throw new Error("The selected Google Antigravity account is unavailable. Reconnect the Google account, then retry.");
        }
        const credential = environmentTaskCredentialSchema.parse({ type: "provider-env", provider, environment: { [ANTIGRAVITY_SIGN_IN_ENV]: authJson } });
        return { ...github, accountIdentity, credential, needsWriteback: true };
      }
    }
    const names = new Set(provider === "antigravity" ? ["GEMINI_API_KEY"] : ENVIRONMENT_TASK_PROVIDER_CREDENTIAL_KEY_SETS[provider].flat());
    const environment = Object.fromEntries([...names]
      .flatMap(key => input.environment[key] ? [[key, input.environment[key]]] : []));
    const credential = environmentTaskCredentialSchema.safeParse({ type: "provider-env", provider, environment });
    if (!credential.success) throw new Error("Plugin Runner selected credential unavailable");
    return { ...github, accountIdentity, credential: credential.data };
  }
  throw new Error("Plugin Runner does not support the selected credential provider");
}
