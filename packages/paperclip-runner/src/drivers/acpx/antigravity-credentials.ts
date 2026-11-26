import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sanitizeAntigravityCredential } from "./antigravity-auth.js";
import { stageManagedCodexCredential, type AcpxProviderLifetimeLease } from "./codex-credentials.js";

export const ANTIGRAVITY_AUTH_ENV = "PAPERCLIP_ACPX_ANTIGRAVITY_AUTH_JSON_SECRET";

/** The controller's selected credential crosses stdio admission once, then lives
 * only in a private, fenced native home. It never enters provider environment.
 */
export async function stageManagedAntigravityCredential(input: {
  agentHomeDirectory: string;
  environment?: NodeJS.ProcessEnv;
  /** Unchanged copies may be omitted; consumed refresh rotations always survive. */
  retainRefresh?: () => boolean;
}): Promise<AcpxProviderLifetimeLease> {
  const source = input.environment ?? {};
  const inline = source[ANTIGRAVITY_AUTH_ENV];
  const key = source.GEMINI_API_KEY?.trim();
  if (Boolean(inline) === Boolean(key)) throw new Error("Antigravity requires exactly one selected runtime credential");
  const canonical = inline ? sanitizeAntigravityCredential(inline) : undefined;
  const directory = join(input.agentHomeDirectory, "antigravity-acp");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0
    || metadata.uid !== process.getuid?.() || await realpath(directory) !== directory) {
    throw new Error("Antigravity credential home is unsafe");
  }
  // Reuse the established crash scrub, cleanup intent, and inherited quorum.
  // The extra native token filename is scrubbed while that quorum is held.
  const lease = await stageManagedCodexCredential({ agentHomeDirectory: directory,
    environment: canonical ? { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: canonical } : { OPENAI_API_KEY: key } });
  const token = join(directory, "acp_token.json");
  const refresh = join(directory, "auth-refresh.json");
  try {
    for (const filename of [token, refresh, `${refresh}.tmp`]) await rm(filename, { force: true });
    if (canonical) await writeFile(token, canonical, { flag: "wx", mode: 0o600 });
  } catch (error) {
    await rm(token, { force: true });
    await lease.close();
    throw error;
  }
  let closed = false;
  let tokenProcessed = false;
  let closing: Promise<void> | undefined;
  return {
    lifetimeFenceCandidates: lease.lifetimeFenceCandidates,
    lifetimeFenceFds: lease.lifetimeFenceFds,
    activateLifetimeOwner: pid => lease.activateLifetimeOwner(pid),
    close() {
      if (closed) return Promise.resolve();
      return closing ??= (async () => {
        if (canonical && !tokenProcessed) {
          const handle = await open(token, constants.O_RDONLY | constants.O_NOFOLLOW);
          try {
            const stat = await handle.stat();
            if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()
              || (stat.mode & 0o777) !== 0o600 || stat.size > 65_536) throw new Error("Antigravity refreshed credential is unsafe");
            const buffer = Buffer.alloc(65_537);
            try {
              let size = 0;
              while (size < buffer.length) {
                const read = await handle.read(buffer, size, buffer.length - size, size);
                if (!read.bytesRead) break;
                size += read.bytesRead;
              }
              if (size > 65_536) throw new Error("Antigravity refreshed credential exceeds its bound");
              const refreshed = sanitizeAntigravityCredential(buffer.subarray(0, size).toString("utf8"));
              // Failed/cancelled startup can still consume a refresh token.
              // Admission controls retaining an unchanged copy, never rotation.
              if (refreshed !== canonical || (input.retainRefresh?.() ?? true)) {
                await rm(`${refresh}.tmp`, { force: true });
                const handoff = await open(`${refresh}.tmp`, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
                try { await handoff.writeFile(refreshed); await handoff.sync(); } finally { await handoff.close(); }
                await rename(`${refresh}.tmp`, refresh);
                const parent = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
                try { await parent.sync(); } finally { await parent.close(); }
              }
            } finally { buffer.fill(0); await rm(`${refresh}.tmp`, { force: true }); }
          } finally { await handle.close(); }
          // A failed underlying lease close must retry that same lease without
          // reopening the token removed only after this durable handoff.
          tokenProcessed = true;
        }
        await rm(token, { force: true });
        await rm(join(directory, "logs"), { recursive: true, force: true });
        await lease.close();
        closed = true;
      })().finally(() => { closing = undefined; });
    },
  };
}
