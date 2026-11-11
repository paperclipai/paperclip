import { constants } from "node:fs";
import { open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AcpxProviderLifetimeLease } from "./codex-credentials.js";

/** Called only by owners that close their credential lease after provider exit. */
export async function retainAcpxCredentialRefresh(input: {
  lease: AcpxProviderLifetimeLease;
  agentHomeDirectory: string;
  retainRefresh: () => boolean;
  beforeClose?: () => Promise<void>;
}): Promise<AcpxProviderLifetimeLease> {
  const { lease } = input;
  const refresh = join(input.agentHomeDirectory, "auth-refresh.json");
  await rm(refresh, { force: true }).catch(async (error) => { await lease.close(); throw error; });
  let prepared = false;
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
        // The runtime host has verified provider exit. Keep the final snapshot
        // private until Core persists it, before auth.json is scrubbed.
        // Do not touch a successor's files if lease cleanup needs a retry.
        if (!prepared) {
          if (input.retainRefresh()) {
            const auth = await open(join(input.agentHomeDirectory, "auth.json"), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch((error) => {
              if (error.code === "ENOENT") return null;
              throw error;
            });
            if (auth) {
              try {
                const stat = await auth.stat();
                if (!stat.isFile() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.size > 256 * 1024) throw new Error("ACPX refreshed credential is invalid");
                const buffer = Buffer.alloc(256 * 1024 + 1);
                let size = 0;
                while (size < buffer.length) {
                  const read = await auth.read(buffer, size, buffer.length - size, size);
                  if (!read.bytesRead) break;
                  size += read.bytesRead;
                }
                if (size > 256 * 1024) { buffer.fill(0); throw new Error("ACPX refreshed credential exceeds its bound"); }
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
          await input.beforeClose?.();
          prepared = true;
        }
        await lease.close();
        closed = true;
      })().finally(() => { closing = null; });
      return closing;
    },
  };
}
