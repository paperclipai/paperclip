import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { CheckCtx, CheckDef, CheckResult } from "../types.js";

const TTL_MS = 60 * 60 * 1000;

function getCreativeRoot(): string {
  return process.env.PAPERCLIP_CREATIVE_ROOT
    ?? join(homedir(), ".openclaw/workspace/projects/happygang");
}

async function* walkMarkers(dir: string): AsyncGenerator<string> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      yield* walkMarkers(full);
    } else if (e.name.startsWith(".drive-approved-")) {
      yield full;
    }
  }
}

async function run(ctx: CheckCtx): Promise<CheckResult> {
  const root = getCreativeRoot();
  const cutoff = ctx.now().getTime() - TTL_MS;
  const removed: string[] = [];
  const errors: Array<{ path: string; err: string }> = [];

  for await (const filePath of walkMarkers(root)) {
    try {
      const st = await stat(filePath);
      if (st.mtimeMs < cutoff) {
        await unlink(filePath);
        removed.push(filePath);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push({ path: filePath, err: msg });
      ctx.logger.warn({ path: filePath, err: msg }, "drive-marker-ttl: stat/unlink failed");
    }
  }

  return {
    status: "ok",
    findings: removed.length,
    payload: { removed, errors },
    summary: removed.length > 0
      ? `removed ${removed.length} stale drive markers`
      : "no stale drive markers",
  };
}

export const driveMarkerTtl: CheckDef = {
  name: "drive-marker-ttl",
  schedule: "*/15 * * * *",
  notify: "silent",
  run,
};
