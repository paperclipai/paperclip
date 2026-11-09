import { readClaudeAuthStatus } from "@paperclipai/adapter-claude-local/server";
import { readCodexAuthInfo } from "@paperclipai/adapter-codex-local/server";
import type { AdapterAuthSignal } from "@paperclipai/shared";

/** Detect subscription credentials in the same home used by local adapters.
 * Never returns or imports credentials: the CLI retains ownership of its login.
 * Call only after authorizing local-trusted board access and a local target.
 */
export async function readLocalCliAuthSignal(adapterType: string): Promise<AdapterAuthSignal> {
  try {
    if (adapterType === "claude_local") {
      const auth = await readClaudeAuthStatus();
      if (!auth) return "unknown";
      return auth.loggedIn && auth.authMethod === "claude.ai" ? "present" : "absent";
    }
    if (adapterType === "codex_local") {
      return await readCodexAuthInfo() ? "present" : "absent";
    }
  } catch {
    // A detection failure must leave the normal login path available.
  }
  return "unknown";
}
