import { constants } from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stageManagedCodexCredential, type AcpxProviderLifetimeLease } from "./codex-credentials.js";

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
  const refresh = join(input.agentHomeDirectory, GROK_AUTH_REFRESH_FILE);
  await rm(refresh, { force: true }).catch(async (error) => { await lease.close(); throw error; });
  let closed = false;
  let closing: Promise<void> | null = null;
  return {
    lifetimeFenceCandidates: lease.lifetimeFenceCandidates,
    lifetimeFenceFds: lease.lifetimeFenceFds,
    activateLifetimeOwner: (pid) => lease.activateLifetimeOwner(pid),
    close() {
      if (closed) return Promise.resolve();
      if (closing) return closing;
      closing = (async () => {
      // The runtime host calls close only after verified provider exit. Retain
      // a private refresh handoff for the controller's existing Grok merge
      // predicate, then scrub auth.json before releasing the process fence.
      if (inline && (input.retainRefresh?.() ?? true)) {
        const auth = await open(join(input.agentHomeDirectory, "auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (auth) {
          try {
            const stat = await auth.stat();
            if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 256 * 1024) throw new Error("Grok refreshed credential is invalid");
            const buffer = Buffer.alloc(256 * 1024 + 1);
            let size = 0;
            while (size < buffer.length) {
              const read = await auth.read(buffer, size, buffer.length - size, size);
              if (!read.bytesRead) break;
              size += read.bytesRead;
            }
            if (size > 256 * 1024) { buffer.fill(0); throw new Error("Grok refreshed credential exceeds its bound"); }
            const bytes = buffer.subarray(0, size);
            const temporary = `${refresh}.tmp`;
            try {
              await rm(temporary, { force: true });
              await writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
              await rename(temporary, refresh);
            } finally { bytes.fill(0); await rm(temporary, { force: true }); }
          } finally { await auth.close(); }
        }
      }
      // Grok diagnostics can contain account/authentication fields. They are
      // disposable, unlike session history, and must not outlive this owner.
      // close is invoked only after the provider has been contained.
      await rm(join(input.agentHomeDirectory, "logs"), { recursive: true, force: true });
      await lease.close();
      closed = true;
      })().finally(() => { closing = null; });
      return closing;
    },
  };
}
