import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import path from "node:path";
import { z } from "zod";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { validateWorkFilePath } from "@paperclipai/shared";

const entrySchema = z.object({ path: z.string().refine((value) => { try { validateWorkFilePath(value); return true; } catch { return false; } }),
  kind: z.enum(["file", "directory"]), byteSize: z.number().int().nonnegative().max(1024 ** 3),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(), executable: z.boolean(), linkTarget: z.string().max(1024).optional() });
export type WorkTreeEntry = z.infer<typeof entrySchema>;
let source: Promise<string> | undefined;
// Requests are base64 encoded twice (file bytes, then JSON). Stay below
// Linux's 128 KiB single-argument limit, including a provider shell wrapper.
const WRITE_CHUNK_BYTES = 48 * 1024;

function transientReadFailure(error: unknown) {
  if (!(error instanceof Error)) return false;
  const code = (error as Error & { code?: string }).code;
  return ["ECONNRESET", "EPIPE", "EAI_AGAIN", "ECONNABORTED"].includes(code ?? "")
    || error.message === "socket hang up";
}

export function workFolderTransport(runner: CommandManagedRuntimeRunner) {
  async function command(input: Record<string, unknown>): Promise<unknown> {
    source ??= readFile(new URL("./scripts/work-folder-io.mjs", import.meta.url), "utf8");
    const args = ["--input-type=module", "-e", await source, Buffer.from(JSON.stringify(input)).toString("base64")];
    const readOnly = ["home", "scan", "read"].includes(String(input.operation));
    const deadline = Date.now() + 120_000;
    let result;
    for (let attempt = 0; ; attempt++) {
      try {
        result = await runner.execute({ command: "node", args, bypassSession: true,
          timeoutMs: Math.max(1, deadline - Date.now()) });
        break;
      } catch (error) {
        // A lost read response is safe to repeat. Staging writes, publishes and
        // moves may already have happened, so never replay them here.
        const waitMs = 250 * (attempt + 1);
        if (!readOnly || attempt >= 2 || !transientReadFailure(error) || Date.now() + waitMs >= deadline) throw error;
        await delay(waitMs);
      }
    }
    if (result.exitCode !== 0 || result.timedOut) throw new Error(`Work folder ${String(input.operation)} failed: ${result.stderr.slice(0, 1500)}`);
    return JSON.parse(result.stdout);
  }
  async function home() {
    const result = z.object({ home: z.string().startsWith("/") }).parse(await command({ operation: "home" }));
    return result.home;
  }
  async function scan(root: string, repository = false) {
    return z.array(entrySchema).max(100_000).parse(await command({ operation: "scan", root, repository }));
  }
  function read(root: string, filePath: string, byteSize: number) {
    validateWorkFilePath(filePath);
    return Readable.from((async function* () {
      for (let offset = 0; offset < byteSize;) {
        const result = z.object({ data: z.string().max(350_000) }).parse(await command({ operation: "read", root, path: filePath, offset }));
        const bytes = Buffer.from(result.data, "base64");
        if (bytes.length === 0 || offset + bytes.length > byteSize) throw new Error("Work file changed during transfer");
        offset += bytes.length;
        yield bytes;
      }
    })());
  }
  async function write(root: string, stagingRoot: string, entry: WorkTreeEntry, body: Readable) {
    const stagingPath = randomUUID();
    let offset = 0;
    for await (const value of body) {
      const chunk = Buffer.from(value);
      for (let start = 0; start < chunk.length; start += WRITE_CHUNK_BYTES) {
        const bytes = chunk.subarray(start, start + WRITE_CHUNK_BYTES);
        await command({ operation: "write", root: stagingRoot, path: stagingPath, offset, data: bytes.toString("base64") });
        offset += bytes.length;
      }
    }
    if (offset === 0) await command({ operation: "write", root: stagingRoot, path: stagingPath, offset: 0, data: "" });
    if (offset !== entry.byteSize) throw new Error("Work file size changed during transfer");
    await command({ operation: "publish", root, stagingRoot, stagingPath, path: entry.path,
      sha256: entry.sha256, executable: entry.executable });
  }
  return { home, scan, read, write,
    moveRoot: async (source: string, root: string) => { await command({ operation: "move-root", source, root }); },
    symlink: async (root: string, stagingRoot: string, entry: WorkTreeEntry) => { await command({ operation: "symlink", root, stagingRoot, stagingPath: randomUUID(), path: entry.path, linkTarget: entry.linkTarget }); },
    mkdirRoot: async (root: string) => { await command({ operation: "mkdir-root", root }); },
    mkdir: async (root: string, filePath: string) => { await command({ operation: "mkdir", root, path: filePath }); },
    remove: async (root: string, filePath: string) => { await command({ operation: "remove", root, path: filePath }); },
  };
}
export type WorkFolderTransport = ReturnType<typeof workFolderTransport>;
export function workFolderPaths(home: string) {
  return Object.fromEntries(["task", "agent", "user", "project", "repos", ".cache", ".codex", ".paperclip-work-folders"].map((name) => [name, path.posix.join(home, name)]));
}
