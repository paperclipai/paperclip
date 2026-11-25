import { rm } from "node:fs/promises";
import { join } from "node:path";
import { stageManagedCodexCredential, type AcpxProviderLifetimeLease } from "./codex-credentials.js";

import { retainAcpxCredentialRefresh } from "./credential-refresh.js";

export const GROK_AUTH_REFRESH_FILE = "auth-refresh.json";

/** Shares the established credential staging, crash cleanup and process fence.
 * The Grok document uses the same auth.json filename, but its own source and
 * validation. Never forward the controller's inline credential to the provider.
 */
export async function stageManagedGrokCredential(input: {
  agentHomeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  retainRefresh?: () => boolean;
}): Promise<AcpxProviderLifetimeLease> {
  const source = input.environment ?? {};
  const inline = source.PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET;
  const apiKey = source.XAI_API_KEY;
  if (inline && apiKey) throw new Error("Grok credential source is ambiguous");
  if (!inline && !apiKey) throw new Error("Grok login or explicit XAI_API_KEY is required");
  if (inline) {
    if (Buffer.byteLength(inline) > 256 * 1024) throw new Error("Grok credential exceeds its bound");
    let value: unknown;
    try { value = JSON.parse(inline); } catch { throw new Error("Grok credential is malformed"); }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Grok credential is malformed");
    const entries = Object.entries(value);
    // Keep aligned with grok-local's parseGrokAuthPayload / hasUsableGrokAuthValue.
    const [identity, auth] = entries[0] ?? [];
    if (entries.length !== 1 || !/^.+::[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(identity ?? "") ||
      !auth || typeof auth.key !== "string" || !auth.key.trim() ||
      typeof auth.refresh_token !== "string" || !auth.refresh_token.trim()) {
      throw new Error("Grok credential is malformed");
    }
  }
  const lease = await stageManagedCodexCredential({
    agentHomeDirectory: input.agentHomeDirectory,
    environment: inline ? { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: inline } : { OPENAI_API_KEY: apiKey },
  });
  return retainAcpxCredentialRefresh({
    lease, agentHomeDirectory: input.agentHomeDirectory,
    retainRefresh: () => Boolean(inline) && (input.retainRefresh?.() ?? true),
    // Diagnostics may contain auth fields; session history remains resumable.
    beforeClose: () => rm(join(input.agentHomeDirectory, "logs"), { recursive: true, force: true }),
  });
}
