import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import { LineageState, readProcessTable, trackAntigravityProcessLineage, type LineageEntry } from "./antigravity-process-lineage.js";

const entry = (pid: number, ppid: number, pgid: number, started: number, zombie = false): LineageEntry => ({ pid, ppid, pgid, started, zombie });
const pids = (entries: LineageEntry[]) => entries.map(item => item.pid).sort((a, b) => a - b);

describe("Antigravity process lineage", () => {
  it("keeps a helper that leads its own group after the CLI dies and it is re-parented, with its children", () => {
    const state = new LineageState(100);
    // CLI 100 starts helper shell 200 as its own group leader; 200 starts 201.
    expect(pids(state.observe([entry(100, 50, 100, 10), entry(200, 100, 200, 11), entry(201, 200, 200, 12), entry(300, 1, 300, 5)]))).toEqual([100, 200, 201]);
    // CLI killed: 200 is re-parented to init; 201 forks 202 after its parent exited.
    expect(pids(state.observe([entry(200, 1, 200, 11), entry(202, 1, 200, 13), entry(300, 1, 300, 5)]))).toEqual([200, 202]);
  });

  it("never claims an unrelated process: same user, earlier start, a reused PID or a reused group id", () => {
    const state = new LineageState(100);
    state.observe([entry(100, 50, 100, 10), entry(200, 100, 200, 11)]);
    // 200 exits; an unrelated process later reuses PID 200 and leads group 200.
    expect(pids(state.observe([entry(100, 50, 100, 10), entry(200, 1, 200, 99), entry(201, 200, 200, 100), entry(400, 50, 400, 9)]))).toEqual([100]);
    // A process that started before the CLI is never its child.
    expect(pids(state.observe([entry(100, 50, 100, 10), entry(500, 100, 500, 3)]))).toEqual([100]);
  });

  it("drops zombies and a root whose PID now names another process", () => {
    const state = new LineageState(100);
    state.observe([entry(100, 50, 100, 10), entry(200, 100, 200, 11)]);
    expect(pids(state.observe([entry(100, 50, 100, 10), entry(200, 100, 200, 11, true)]))).toEqual([100]);
    expect(pids(state.observe([entry(100, 50, 100, 77)]))).toEqual([]);
  });

  it("does not keep a failed termination: a later call reads again and proves the lineage gone", async () => {
    let readable = false;
    const lineage = trackAntigravityProcessLineage(999_999, { sampleIntervalMs: 1_000, readTable: async () => {
      if (!readable) throw new Error("unavailable");
      return [];
    } });
    await expect(lineage.terminate()).rejects.toThrow(/could not be stopped/);
    readable = true;
    await expect(lineage.terminate()).resolves.toBeUndefined();
  });

  it("reads this host's process table, including this process with its parent and group", async () => {
    const table = await readProcessTable();
    const self = table.find(item => item.pid === process.pid);
    expect(self).toMatchObject({ ppid: process.ppid, zombie: false });
    expect(Number.isSafeInteger(self?.started)).toBe(true);
  });

  it("stops a detached grandchild of a dead root and leaves an unrelated process running", async () => {
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    // The root starts a detached grandchild (its own group) and exits at once.
    const root = spawn(process.execPath, ["-e", `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); console.log(c.pid); setTimeout(() => process.exit(0), 300);`], { stdio: ["ignore", "pipe", "ignore"] });
    const lineage = trackAntigravityProcessLineage(root.pid, { sampleIntervalMs: 20 });
    const grandchild = await new Promise<number>(resolve => root.stdout.once("data", chunk => resolve(Number(String(chunk).trim()))));
    await new Promise(resolve => root.once("exit", resolve));
    const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    try {
      expect(alive(grandchild)).toBe(true);
      await lineage.terminate();
      expect(alive(grandchild)).toBe(false);
      expect(alive(unrelated.pid!)).toBe(true);
    } finally {
      for (const pid of [grandchild, unrelated.pid!]) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
    }
  });
});
