import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runChildProcess } from "../../adapters/utils.js";
import { hasStoppedLocalProcessTree, legacyAdapterNeedsLocalProcessSettlement } from "./process-settlement.js";

describe("local heartbeat process-tree settlement", () => {
  it("requires host process evidence for process, CLI and unknown local adapters, while preserving nonprocess HTTP and remote contracts", () => {
    for (const adapterType of ["process", "codex_local", "unknown-plugin"]) {
      expect(legacyAdapterNeedsLocalProcessSettlement({ adapterType })).toBe(true);
      expect(legacyAdapterNeedsLocalProcessSettlement({ adapterType, executionTargetKind: "local" })).toBe(true);
      expect(legacyAdapterNeedsLocalProcessSettlement({ adapterType, executionTargetKind: "remote" })).toBe(false);
    }
    expect(legacyAdapterNeedsLocalProcessSettlement({ adapterType: "http" })).toBe(false);
    expect(legacyAdapterNeedsLocalProcessSettlement({ adapterType: "http", executionTargetKind: "local" })).toBe(false);
    expect(legacyAdapterNeedsLocalProcessSettlement({ adapterType: "http", executionTargetKind: "remote" })).toBe(false);
    expect(hasStoppedLocalProcessTree({ processPid: null, processGroupId: null, processStartedAt: null })).toBe(false);
  });

  it.skipIf(process.platform === "win32")("holds a closed-stdio background writer after its real adapter parent returns, without scratch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "paperclip-process-settlement-"));
    const output = path.join(dir, "background-writes.txt");
    let identity: Parameters<typeof hasStoppedLocalProcessTree>[0] | null = null;
    const writer = "const fs=require('node:fs');setInterval(()=>fs.appendFileSync(process.argv[1],'write\\n'),20)";
    const parent = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'ignore'});child.unref();console.log(child.pid);";
    try {
      const result = await runChildProcess(randomUUID(), process.execPath, ["-e", parent, writer, output], {
        cwd: dir, env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {},
        onSpawn: async meta => { identity = { processPid: meta.pid, processGroupId: meta.processGroupId,
          processStartedAt: new Date(meta.startedAt) }; },
      });
      expect(result.exitCode).toBe(0);
      expect(identity).not.toBeNull();
      const owned = identity! as Parameters<typeof hasStoppedLocalProcessTree>[0];
      await expect.poll(async () => (await readFile(output, "utf8").catch(() => "")).length).toBeGreaterThan(0);
      const before = (await readFile(output, "utf8")).length;
      expect(hasStoppedLocalProcessTree(owned)).toBe(false);
      await expect.poll(async () => (await readFile(output, "utf8")).length).toBeGreaterThan(before);
      process.kill(-owned.processGroupId!, "SIGKILL");
      await expect.poll(() => hasStoppedLocalProcessTree(owned)).toBe(true);
    } finally {
      const owned = identity as Parameters<typeof hasStoppedLocalProcessTree>[0] | null;
      if (owned?.processGroupId) {
        try { process.kill(-owned.processGroupId, "SIGKILL"); } catch { /* already stopped */ }
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === "win32")("requires both recorded identities to be absent and holds permission or unknown probe errors", () => {
    const identity = { processPid: 12345, processGroupId: 12345, processStartedAt: new Date() };
    const absent = vi.fn((_pid: number) => { throw Object.assign(new Error("absent"), { code: "ESRCH" }); });
    expect(hasStoppedLocalProcessTree(identity, absent)).toBe(true);
    expect(absent.mock.calls.map(call => call[0])).toEqual([12345, -12345]);
    for (const error of [Object.assign(new Error("denied"), { code: "EPERM" }), new Error("unknown"), null]) {
      expect(hasStoppedLocalProcessTree(identity, () => { throw error; })).toBe(false);
    }
    expect(hasStoppedLocalProcessTree(identity, pid => { if (pid > 0) throw Object.assign(new Error("main exited"), { code: "ESRCH" }); })).toBe(false);
    expect(hasStoppedLocalProcessTree(identity, () => undefined)).toBe(false);
    for (const incomplete of [
      { ...identity, processPid: null }, { ...identity, processGroupId: null },
      { ...identity, processPid: 1 }, { ...identity, processGroupId: 1 },
      { ...identity, processStartedAt: null }, { ...identity, processStartedAt: new Date(Number.NaN) },
    ]) expect(hasStoppedLocalProcessTree(incomplete, absent)).toBe(false);
  });
});
