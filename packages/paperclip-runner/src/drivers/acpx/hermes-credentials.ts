import { constants } from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stageManagedCodexCredential, type AcpxProviderLifetimeLease } from "./codex-credentials.js";

export const HERMES_AUTH_REFRESH_FILE = "auth-refresh.json";

/** Shares the established credential staging, crash cleanup and process fence.
 * The Hermes document uses the same auth.json filename, but its own source and
 * validation. Never forward the controller's inline credential to the provider.
 */
export async function stageManagedHermesCredential(input: {
  agentHomeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  retainRefresh?: () => boolean;
  beforeRelease?: () => Promise<void>;
}): Promise<AcpxProviderLifetimeLease> {
  const source = input.environment ?? {};
  const inline = source.PAPERCLIP_HERMES_AUTH_JSON_SECRET;
  if (inline) {
    if (Buffer.byteLength(inline) > 256 * 1024) throw new Error("Hermes credential exceeds its bound");
    const value = JSON.parse(inline);
    if (value?.version !== 1 || !value.providers || typeof value.providers !== "object" || Array.isArray(value.providers)
      || Object.keys(value.providers).length !== 1 || !["openai-codex", "xai-oauth"].includes(Object.keys(value.providers)[0]!)) {
      throw new Error("Hermes subscription credential is malformed");
    }
  }
  const lease = await stageManagedCodexCredential({
    agentHomeDirectory: input.agentHomeDirectory,
    environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: inline ?? JSON.stringify({ version: 1, providers: {} }) },
  });
  const refresh = join(input.agentHomeDirectory, HERMES_AUTH_REFRESH_FILE);
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
      const errors: unknown[] = [];
      const attempt = async (operation: () => Promise<void>) => {
        try { await operation(); } catch (error) { errors.push(error); }
      };
      // The runtime host calls close only after verified provider exit. Retain
      // a private refresh handoff for the controller's existing Hermes merge
      // predicate, then scrub auth.json before releasing the process fence.
      await attempt(async () => {
      if (inline && (input.retainRefresh?.() ?? true)) {
        const auth = await open(join(input.agentHomeDirectory, "auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (auth) {
          try {
            const stat = await auth.stat();
            if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 256 * 1024) throw new Error("Hermes refreshed credential is invalid");
            const buffer = Buffer.alloc(256 * 1024 + 1);
            let size = 0;
            while (size < buffer.length) {
              const read = await auth.read(buffer, size, buffer.length - size, size);
              if (!read.bytesRead) break;
              size += read.bytesRead;
            }
            if (size > 256 * 1024) { buffer.fill(0); throw new Error("Hermes refreshed credential exceeds its bound"); }
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
      });
      // Hermes diagnostics can contain account/authentication fields. They are
      // disposable, unlike session history, and must not outlive this owner.
      // close is invoked only after the provider has been contained.
      for (const name of ["logs", "auth.json.corrupt", "auth.lock"]) {
        await attempt(() => rm(join(input.agentHomeDirectory, name), { recursive: true, force: true }));
      }
      await attempt(async () => { await input.beforeRelease?.(); });
      // Persistence errors must remain visible, but cannot retain credentials
      // or their ownership fence after the provider has verifiably exited.
      await attempt(async () => { await lease.close(); closed = true; });
      if (errors.length) throw new AggregateError(errors, "Hermes state save or credential cleanup failed");
      })().finally(() => { closing = null; });
      return closing;
    },
  };
}
