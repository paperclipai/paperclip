import { rm } from "node:fs/promises";
import { join } from "node:path";
import { stageManagedCodexCredential, type AcpxProviderLifetimeLease } from "./codex-credentials.js";
import { validateGrokAuthDocument } from "./credential-file.js";

import { retainAcpxCredentialRefresh } from "./credential-refresh.js";

export const GROK_AUTH_REFRESH_FILE = "auth-refresh.json";

/** Shares the established credential staging, crash cleanup and process fence.
 * The Grok document uses the same auth.json filename, but its own source and
 * validation. Never forward the controller's inline credential or the host
 * credential file path to the provider.
 */
export async function stageManagedGrokCredential(input: {
  agentHomeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  /** Absolute path of a host-owned Grok auth.json to seed the isolated home from. */
  sourcePath?: string;
  retainRefresh?: () => boolean;
}): Promise<AcpxProviderLifetimeLease> {
  const source = input.environment ?? {};
  const inline = source.PAPERCLIP_ACPX_GROK_AUTH_JSON_SECRET;
  const apiKey = source.XAI_API_KEY;
  const file = typeof input.sourcePath === "string" && input.sourcePath.length > 0 ? input.sourcePath : undefined;
  const sources = [inline, apiKey, file].filter(Boolean).length;
  if (sources > 1) throw new Error("Grok credential source is ambiguous");
  if (sources === 0) throw new Error("Grok login or explicit XAI_API_KEY is required");
  if (inline) {
    if (Buffer.byteLength(inline) > 256 * 1024) throw new Error("Grok credential exceeds its bound");
    validateGrokAuthDocument(Buffer.from(inline, "utf8"));
  }
  const lease = await stageManagedCodexCredential({
    agentHomeDirectory: input.agentHomeDirectory,
    ...(file
      // The shared reader enforces an external absolute path, no symlink,
      // private mode, Runner ownership and the size bound; the Grok format is
      // checked on the exact bytes it stages.
      ? { sourcePath: file, validateDocument: validateGrokAuthDocument }
      : { environment: inline ? { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: inline } : { OPENAI_API_KEY: apiKey } }),
  });
  const subscription = Boolean(inline || file);
  return retainAcpxCredentialRefresh({
    lease, agentHomeDirectory: input.agentHomeDirectory,
    retainRefresh: () => subscription && (input.retainRefresh?.() ?? true),
    // Diagnostics may contain auth fields; session history remains resumable.
    beforeClose: () => rm(join(input.agentHomeDirectory, "logs"), { recursive: true, force: true }),
  });
}
