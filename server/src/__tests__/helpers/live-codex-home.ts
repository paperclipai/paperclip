import fs from "node:fs";
import path from "node:path";

const PLACEHOLDER_API_KEY = "sk-vitest";

function containsPlaceholderCredential(value: unknown): boolean {
  if (value === PLACEHOLDER_API_KEY) return true;
  if (Array.isArray(value)) return value.some(containsPlaceholderCredential);
  if (value && typeof value === "object") {
    return Object.values(value).some(containsPlaceholderCredential);
  }
  return false;
}

export function requireLiveCodexHome(codexHome: string | undefined): string {
  const configuredHome = codexHome?.trim();
  if (!configuredHome) {
    throw new Error(
      "live_codex_home_missing: PAPERCLIP_LIVE_CODEX_NATIVE_RESUME requires CODEX_HOME with real Codex credentials",
    );
  }

  const authPath = path.join(configuredHome, "auth.json");
  let auth: unknown;
  try {
    auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  } catch {
    throw new Error(
      "live_codex_auth_unreadable: PAPERCLIP_LIVE_CODEX_NATIVE_RESUME requires readable CODEX_HOME/auth.json credentials",
    );
  }
  if (containsPlaceholderCredential(auth)) {
    throw new Error(
      "live_codex_placeholder_credential: PAPERCLIP_LIVE_CODEX_NATIVE_RESUME cannot use the Vitest placeholder credential",
    );
  }
  return configuredHome;
}
