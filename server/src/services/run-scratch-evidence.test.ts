import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RUN_SCRATCH_QUARANTINE_RECEIPT,
  prepareHeartbeatRunScratch, cleanupHeartbeatRunScratch, sweepOrphanedRunScratch,
  createDefaultRunScratchWalkerOps,
} from "./run-scratch.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function root() {
  const p = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-evidence-"));
  roots.push(p);
  return p;
}

describe.skipIf(process.platform === "win32")("sandbox-writable scratch evidence", () => {
  it.each(["symlink", "oversized", "fifo"])("refuses a %s marker without destroying the tree", async kind => {
    const dir = await root();
    const scratch = await prepareHeartbeatRunScratch({ companyId: "fixture", agentId: "fixture", runId: "791e0000", root: dir });
    const data = await fs.readFile(scratch.markerPath, "utf8");
    await fs.unlink(scratch.markerPath);
    const outside = path.join(dir, "outside.json");
    await fs.writeFile(outside, data);
    if (kind === "symlink") await fs.symlink(outside, scratch.markerPath);
    if (kind === "oversized") await fs.writeFile(scratch.markerPath, data + " ".repeat(16385));
    if (kind === "fifo") execFileSync("mkfifo", [scratch.markerPath]);
    await fs.writeFile(path.join(scratch.dir, "sentinel"), "preserve");
    expect((await cleanupHeartbeatRunScratch({ scratch, runTempRootOverride: dir })).removed).toBe(false);
    expect(await fs.readFile(path.join(scratch.dir, "sentinel"), "utf8")).toBe("preserve");
    expect(await fs.readFile(outside, "utf8")).toBe(data);
  });

  it.each(["symlink", "oversized", "fifo"])("refuses a %s remnant receipt during sweeping", async kind => {
    const dir = await root();
    const runs = await root();
    const remnant = path.join(dir, "paperclip-ai-fixture-rm-1234567890abcdef");
    await fs.mkdir(remnant);
    const receipt = path.join(remnant, RUN_SCRATCH_QUARANTINE_RECEIPT);
    const data = JSON.stringify({ version: 1, kind: "home", companyId: null, agentId: null, runId: null,
      originalName: "paperclip-ai-fixture", createdAt: new Date().toISOString() });
    const outside = path.join(dir, "outside.json");
    await fs.writeFile(outside, data);
    if (kind === "symlink") await fs.symlink(outside, receipt);
    if (kind === "oversized") await fs.writeFile(receipt, data + " ".repeat(16385));
    if (kind === "fifo") execFileSync("mkfifo", [receipt]);
    await fs.writeFile(path.join(remnant, "sentinel"), "preserve");
    const result = await sweepOrphanedRunScratch({ tmpRoot: dir, runTempRootOverride: runs, resolveRunStates: async () => new Map() });
    expect(result.removed).toEqual([]);
    expect(await fs.readFile(path.join(remnant, "sentinel"), "utf8")).toBe("preserve");
  });

  it.each(["paths", ...(process.platform === "linux" ? ["procfd" as const] : [])] as const)("checks the opened regular file and bounds reads in %s mode", async mode => {
    const dir = await root();
    const file = path.join(dir, "receipt");
    await fs.writeFile(file, "fixture");
    const ops = createDefaultRunScratchWalkerOps(mode);
    const fd = await ops.openDir(dir);
    try {
      const expected = await ops.lstatEntry(fd, "receipt");
      expect(await ops.readEntryRegular(fd, "receipt", expected)).toBe("fixture");
      await fs.rename(file, file + "-saved");
      await fs.writeFile(file, "replacement");
      await expect(ops.readEntryRegular(fd, "receipt", expected)).rejects.toBeDefined();
      await fs.writeFile(file, "x".repeat(16385));
      await expect(ops.readEntryRegular(fd, "receipt", await ops.lstatEntry(fd, "receipt"))).rejects.toBeDefined();
      await fs.unlink(file);
      execFileSync("mkfifo", [file]);
      await expect(ops.readEntryRegular(fd, "receipt", await ops.lstatEntry(fd, "receipt"))).rejects.toBeDefined();
    } finally { await ops.closeDir(fd); }
  });
});
