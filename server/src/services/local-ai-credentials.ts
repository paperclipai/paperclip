import fs from "node:fs/promises";
import path from "node:path";
import { readClaudeToken, fetchClaudeQuota } from "@paperclipai/adapter-claude-local/server";
import { readCodexAuthInfo, fetchCodexQuota } from "@paperclipai/adapter-codex-local/server";
import { parseGrokAuthPayload, hasUsableGrokAuthValue } from "@paperclipai/adapter-grok-local/server";
import type { AiProvider } from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

/** Explicit local-operator import only. Callers must authorize before reading. */
export async function readVerifiedLocalAiCredential(provider: AiProvider, loginHome?: string): Promise<string> {
  if (provider === "openrouter") throw unprocessable("OpenRouter requires an API key.");
  if ((provider === "openai" || provider === "xai") && !loginHome)
    throw unprocessable("Start a separate local sign-in for this connection before connecting.");
  try {
    if (provider === "anthropic") {
      const token = await readClaudeToken({ allowKeychain: true });
      if (!token) throw new Error("Missing login");
      await fetchClaudeQuota(token);
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
    throw unprocessable(provider === "anthropic"
      ? "Could not verify the local subscription. Run claude auth login in a terminal on the machine running Paperclip, then try Connect again."
      : "Could not verify the local subscription. Run the sign-in command shown for this connection, finish signing in, then try Connect again.");
  }
}
