import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import { createStoppedCodexTurnInventory } from "./stopped-codex-turn.js";

const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const unchanged = (a: Awaited<ReturnType<typeof lstat>>, b: Awaited<ReturnType<typeof lstat>>) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;

/** Closed JSONL inventory and raw-byte digest with no total transcript limit.
 * The record bound is per provider frame; it never counts historical bytes. */
export async function inspectStoppedCodexRollout(path: string, input?: Parameters<typeof createStoppedCodexTurnInventory>[0]): Promise<{ safe: boolean; sha256: string }> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error("native_crash_inventory_unproven");
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), hash = createHash("sha256");
  const inventory = input ? createStoppedCodexTurnInventory(input) : null;
  let pending: Buffer = Buffer.alloc(0), valid = true;
  try {
    if (!unchanged(before, await file.stat())) throw new Error("native_crash_inventory_unproven");
    for await (const raw of file.createReadStream({ highWaterMark: 64 * 1024, autoClose: false })) {
      const chunk = raw as Buffer; hash.update(chunk);
      if (!inventory) continue;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      let offset = 0, newline: number;
      while ((newline = pending.indexOf(10, offset)) >= 0) {
        if (newline - offset > MAX_RECORD_BYTES || !inventory.push(JSON.parse(pending.subarray(offset, newline).toString("utf8")))) valid = false;
        offset = newline + 1;
        if (!valid) return { safe: false, sha256: "" };
      }
      pending = Buffer.from(pending.subarray(offset));
      if (pending.length > MAX_RECORD_BYTES) return { safe: false, sha256: "" };
    }
    if (!unchanged(before, await file.stat()) || !unchanged(before, await lstat(path))) throw new Error("native_crash_inventory_unproven");
    return { safe: !inventory || (valid && pending.length === 0 && inventory.finish()), sha256: hash.digest("hex") };
  } finally { await file.close(); }
}
