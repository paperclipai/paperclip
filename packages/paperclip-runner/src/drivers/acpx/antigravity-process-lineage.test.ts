import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  LineageState, parseProcStat, parsePsTable, readProcessTable, trackAntigravityProcessLineage,
  type LineageEntry, type ProcessTableRead,
} from "./antigravity-process-lineage.js";

const entry = (pid: number, ppid: number, pgid: number, started: number, extra: Partial<LineageEntry> = {}): LineageEntry =>
  ({ pid, ppid, pgid, sid: null, started, zombie: false, ...extra });
const pids = (observation: { live: LineageEntry[] }) => observation.live.map(item => item.pid).sort((a, b) => a - b);
const self = () => entry(process.pid, 1, process.pid, 1);
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** A tracker whose first read records `member` and whose later reads come from `later`. */
const trackWith = (member: LineageEntry, later: () => Promise<ProcessTableRead>) => {
  let reads = 0;
  return trackAntigravityProcessLineage(member.pid, { sampleIntervalMs: 60_000,
    readTable: async () => (++reads === 1 ? { entries: [self(), member], unreadable: [] } : later()) });
};

describe("Antigravity process lineage", () => {
  it("keeps a helper that leads its own group after the CLI dies and it is re-parented, with its children", () => {
    const state = new LineageState(100);
    // CLI 100 starts helper shell 200 as its own group leader; 200 starts 201.
    expect(pids(state.observe([entry(100, 50, 100, 10), entry(200, 100, 200, 11), entry(201, 200, 200, 12), entry(300, 1, 300, 5)]))).toEqual([100, 200, 201]);
    // CLI killed: 200 is re-parented to init; 201 forks 202 after its parent exited.
    expect(pids(state.observe([entry(200, 1, 200, 11), entry(202, 1, 200, 13), entry(300, 1, 300, 5)]))).toEqual([200, 202]);
  });

  it("keeps a process in a session a member leads after it left the member's group and its parent exited", () => {
    const state = new LineageState(100);
    // Helper 200 calls setsid (session and group 200); its wrapper 201 starts a job that moves to group 202.
    state.observe([entry(100, 50, 100, 10, { sid: 40 }), entry(200, 100, 200, 11, { sid: 200 }), entry(201, 200, 200, 12, { sid: 200 })]);
    // The wrapper exited before the job was ever seen; the job is re-parented to init.
    expect(pids(state.observe([entry(200, 100, 200, 11, { sid: 200 }), entry(202, 1, 202, 13, { sid: 200 }), entry(300, 1, 300, 14, { sid: 40 })]))).toEqual([200, 202]);
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
    expect(pids(state.observe([entry(100, 50, 100, 10), entry(200, 100, 200, 11, { zombie: true })]))).toEqual([100]);
    expect(pids(state.observe([entry(100, 50, 100, 77)]))).toEqual([]);
  });

  it("keeps a member whose details could not be read unresolved instead of treating it as gone", () => {
    const state = new LineageState(100);
    state.observe([entry(100, 50, 100, 10), entry(200, 100, 200, 11)]);
    expect(state.observe({ entries: [], unreadable: [200] })).toEqual({ live: [], unresolved: [200] });
    expect(state.observe({ entries: [], unreadable: [] })).toEqual({ live: [], unresolved: [] });
  });

  it("parses macOS ps output: live, zombie and unreadable rows; rejects output that is not a process table", () => {
    const read = parsePsTable([
      "  100     1   100 Ss   Tue Nov 24 10:00:00 2026",
      "  200   100   200 Z    Tue Nov 24 10:00:01 2026",
      "  300   100   200 S+   garbled",
      "",
    ].join("\n"));
    expect(read.entries).toEqual([
      { pid: 100, ppid: 1, pgid: 100, sid: null, started: Date.UTC(2026, 10, 24, 10, 0, 0), zombie: false },
      { pid: 200, ppid: 100, pgid: 200, sid: null, started: Date.UTC(2026, 10, 24, 10, 0, 1), zombie: true },
    ]);
    expect(read.unreadable).toEqual([300]);
    expect(parsePsTable("")).toEqual({ entries: [], unreadable: [] });
    expect(() => parsePsTable("PID PPID PGID STAT STARTED\n")).toThrow(/Unexpected/);
  });

  it("parses Linux /proc stat lines, including a command name with spaces and parentheses", () => {
    const fields = ["S", "100", "200", "300", ...Array.from({ length: 15 }, () => "0"), "123456", "0"];
    expect(parseProcStat(42, `42 (a (b) c) ${fields.join(" ")}`)).toEqual({ pid: 42, ppid: 100, pgid: 200, sid: 300, started: 123456, zombie: false });
    expect(parseProcStat(42, "42 (x) Z")).toBeNull();
  });

  it("reads this host's process table, including this process with its parent", async () => {
    const table = await readProcessTable();
    const current = table.entries.find(item => item.pid === process.pid);
    expect(current).toMatchObject({ ppid: process.ppid, zombie: false });
    expect(Number.isSafeInteger(current?.started)).toBe(true);
  });

  it.each<[string, () => Promise<ProcessTableRead>]>([
    ["a failed read", async () => { throw new Error("unavailable"); }],
    ["an empty read", async () => ({ entries: [], unreadable: [] })],
    ["a read that does not list this process", async () => ({ entries: [entry(4, 1, 4, 1)], unreadable: [] })],
    ["a read where the recorded member is unreadable", async () => ({ entries: [self()], unreadable: [999_999] })],
  ])("never proves the lineage gone from %s, and a later call tries again", async (_name, bad) => {
    let read = bad;
    const lineage = trackWith(entry(999_999, 1, 999_999, 2), () => read());
    await new Promise(resolve => setTimeout(resolve, 20));
    await expect(lineage.terminate()).rejects.toThrow(/could not be stopped/);
    read = async () => ({ entries: [self()], unreadable: [] });
    await expect(lineage.terminate()).resolves.toBeUndefined();
  }, 10_000);

  it("signals the members it found even when that read was slower than the whole deadline", async () => {
    const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    try {
      let reads = 0;
      const lineage = trackAntigravityProcessLineage(helper.pid, { sampleIntervalMs: 60_000, readTable: async () => {
        const table = await readProcessTable();
        if (++reads === 2) await new Promise(resolve => setTimeout(resolve, 1_700));
        return table;
      } });
      await new Promise(resolve => setTimeout(resolve, 200));
      await lineage.terminate();
      expect(alive(helper.pid!)).toBe(false);
    } finally { try { process.kill(helper.pid!, "SIGKILL"); } catch { /* gone */ } }
  }, 10_000);

  it("never signals a recorded PID whose start time no longer matches", async () => {
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      const real = (await readProcessTable()).entries.find(item => item.pid === unrelated.pid)!;
      // The tracker's reads say an older process held this PID; the re-read before the signal disagrees.
      let reads = 0;
      const older = { ...real, started: real.started - 5_000 };
      const lineage = trackAntigravityProcessLineage(unrelated.pid, { sampleIntervalMs: 60_000,
        readTable: async () => ({ entries: [self(), ...(++reads <= 2 ? [older] : [])], unreadable: [] }) });
      await new Promise(resolve => setTimeout(resolve, 20));
      await lineage.terminate();
      expect(alive(unrelated.pid!)).toBe(true);
    } finally { try { process.kill(unrelated.pid!, "SIGKILL"); } catch { /* gone */ } }
  });

  it("stops a detached grandchild of a dead root and leaves an unrelated process running", async () => {
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    // The root starts a detached grandchild (its own group) and exits soon after.
    const root = spawn(process.execPath, ["-e", `const c = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" }); console.log(c.pid); setTimeout(() => process.exit(0), 300);`], { stdio: ["ignore", "pipe", "ignore"] });
    const lineage = trackAntigravityProcessLineage(root.pid, { sampleIntervalMs: 20 });
    const grandchild = await new Promise<number>(resolve => root.stdout.once("data", chunk => resolve(Number(String(chunk).trim()))));
    await new Promise(resolve => root.once("exit", resolve));
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
