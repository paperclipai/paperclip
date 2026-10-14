import { readLocalAiCredentialFile } from "./local-ai-credential-file.js";
import fs from "node:fs/promises";
import path from "node:path";
import { readIsolatedClaudeKeychainToken } from "@paperclipai/adapter-claude-local/server";
import { readCodexAuthInfo, fetchCodexQuota } from "@paperclipai/adapter-codex-local/server";
import { parseGrokAuthPayload, hasUsableGrokAuthValue } from "@paperclipai/adapter-grok-local/server";
import type { AiProvider } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

/** Read and verify a connection-specific login home. */
export async function readVerifiedLocalAiCredential(provider: AiProvider, loginHome?: string): Promise<string> {
  if (provider === "openrouter") throw unprocessable("OpenRouter requires an API key.");
  if (!loginHome) throw unprocessable(provider === "xai"
    ? "Start local sign-in for this connection before connecting."
    : "Start browser sign-in for this connection before connecting.");
  try {
    if (provider === "anthropic") {
      // Never change process.env or fall back to the server account when an
      // authenticated user's isolated login is missing or invalid.
      let token: string | null = null;
      for (const name of [".credentials.json", "credentials.json"]) {
        const raw = await readLocalAiCredentialFile(path.join(loginHome, name)).catch(() => null);
        if (!raw) continue;
        let parsed;
        try { parsed = JSON.parse(raw); } catch { continue; }
        const value = parsed?.claudeAiOauth?.accessToken;
        if (typeof value === "string" && value.length) { token = value; break; }
      }
      // On macOS the CLI stores the isolated login in the auth home's own
      // suffixed Keychain item rather than a credentials file. The helper
      // never consults the unsuffixed operator item.
      if (!token) token = await readIsolatedClaudeKeychainToken(loginHome);
      if (!token) throw new Error("Missing login");
      // Claude's setup-token OAuth flow requests user:inference. The usage API
      // requires user:profile and returns 403 for that valid token, so it cannot
      // serve as a sign-in check. This isolated credential is written only after
      // the provider CLI completes the code exchange successfully.
      return token;
    }
    if (provider === "openai") {
      const auth = await readCodexAuthInfo(loginHome);
      if (!auth?.accessToken || !auth.refreshToken || !auth.idToken) throw new Error("Missing login");
      await fetchCodexQuota(auth.accessToken, auth.accountId);
      return JSON.stringify({ tokens: { access_token: auth.accessToken, refresh_token: auth.refreshToken, id_token: auth.idToken, account_id: auth.accountId }, last_refresh: auth.lastRefresh });
    }
    const raw = await fs.readFile(path.join(loginHome!, "auth.json"), "utf8");
    const payload = parseGrokAuthPayload(JSON.parse(raw));
    if (!payload || !hasUsableGrokAuthValue(payload.value)) throw new Error("Missing login");
    const response = await fetch("https://api.x.ai/v1/models", {
      headers: { Authorization: `Bearer ${payload.value.key}` },
      redirect: "error", signal: AbortSignal.timeout(15000),
    });
    await response.body?.cancel();
    if (!response.ok) throw new Error("Invalid login");
    return raw;
  } catch {
    // Provider/CLI errors may contain credential material; never return them.
    throw unprocessable(provider === "xai"
      ? "Could not verify the local subscription. Run the sign-in command shown for this connection, finish signing in, then try Connect again."
      : "Could not verify the local subscription. Finish browser sign-in for this connection, then try Connect again.");
  }
}
