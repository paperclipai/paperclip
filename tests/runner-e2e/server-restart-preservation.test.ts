import type { ChildProcess } from "node:child_process";
import { expect, it, vi } from "vitest";
import { createProcessTreeOwner, parseRestartRunnerIdentity, restartProcessStartMatches } from "./process-tree-owner.js";
import { createRunnerE2EServerStopper } from "./server-stop.js";
import { diagnosticProcessKind, type ProcessObservation } from "./process-tree.js";

const started = "2026-10-02T13:55:27.000Z";
const identity = { processPid: 200, processGroupId: 200, processStartedAt: started };
const row = (pid: number, parentPid: number, group = pid, kind = "node"): ProcessObservation =>
  ({ pid, parentPid, processGroupId: group, started, kind, state: "S" });
function fixture() {
  let table = [row(process.pid, 1, 10), row(100, process.pid), row(200, 100, 200, "paperclip-runnerd"),
    row(201, 200), row(300, 100), row(900, process.pid)];
  const signals: Array<[number, string]> = [];
  const roots: Array<ChildProcess> = [];
  const owners: Array<ReturnType<typeof createProcessTreeOwner>> = [];
  const root = (pid: number) => {
    const child = { pid, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null,
      kill: (signal: string) => {
        signals.push([pid, signal]); child.exitCode = 0;
        table = table.filter(row => row.pid !== pid).map(row => row.parentPid === pid ? { ...row, parentPid: 1 } : row);
        return true;
      } };
    const handle = child as unknown as ChildProcess;
    roots.push(handle); return handle;
  };
  const stop = createRunnerE2EServerStopper({ gracefulTimeoutMs: 100, forcedTimeoutMs: 100,
    hasSpawnError: () => false, markExpectedStop: () => {}, log: () => {},
    createOwner: child => {
      const owner = createProcessTreeOwner(child, { readTable: async () => table.map(row => ({ ...row })),
        signalGroup: (group, signal) => { signals.push([group, signal]); table = table.filter(row => row.processGroupId !== group); } });
      owners.push(owner); return owner;
    } });
  return { stop, child: root(100), root, signals, owners, table: () => table,
    replace: (next: ProcessObservation[]) => { table = next; }, close: () => owners.forEach(owner => owner.stopObserving()) };
}

it("matches Linux process birth receipts at ps precision without accepting another second", () => {
  expect(restartProcessStartMatches(started, "2026-10-02T13:55:27.731Z", "linux")).toBe(true);
  for (const expected of ["2026-10-02T13:55:26.999Z", "2026-10-02T13:55:28.000Z", "invalid"]) {
    expect(restartProcessStartMatches(started, expected, "linux")).toBe(false);
  }
  expect(restartProcessStartMatches("invalid", started, "linux")).toBe(false);
  expect(restartProcessStartMatches(started, "2026-10-02T13:55:27.731Z", "darwin")).toBe(false);
  expect(restartProcessStartMatches(started, started, "darwin")).toBe(true);
});

it.skipIf(process.platform === "win32")("preserves only the admitted daemon tree across restart and finally retires old and new owners", async () => {
  const f = fixture();
  try {
    await f.stop.watch(f.child);
    await f.stop.forRestart(f.child, identity);
    expect(f.signals).toEqual([[100, "SIGTERM"], [300, "SIGTERM"]]);
    expect(f.table().map(row => row.pid)).toContain(200);
    // The daemon forks a new private group after controller loss; it stays owned.
    f.replace([...f.table(), row(202, 201), row(400, process.pid), row(401, 400)]);
    const replacement = f.root(400); await f.stop.watch(replacement);
    await f.stop.stopAll();
    expect(f.table().map(row => row.pid).sort()).toEqual([process.pid, 900].sort());
    expect(f.signals.filter(([pid]) => pid === 200)).toEqual([[200, "SIGTERM"]]);
    expect(f.signals.findIndex(([pid]) => pid === 400)).toBeLessThan(f.signals.findIndex(([pid]) => pid === 200));
    expect(f.signals.some(([pid]) => pid === 202)).toBe(true);
    expect(f.signals.some(([pid]) => pid === 900)).toBe(false);
  } finally { f.close(); }
});

it.skipIf(process.platform === "win32").each([
  ["foreign controller", (rows: ProcessObservation[]) => { rows.find(row => row.pid === 200)!.parentPid = 900; }],
  ["reused PID", (rows: ProcessObservation[]) => { rows.find(row => row.pid === 200)!.started = "2026-10-02T13:55:28.000Z"; }],
  ["wrong role", (rows: ProcessObservation[]) => { rows.find(row => row.pid === 200)!.kind = "node"; }],
  ["mixed process group", (rows: ProcessObservation[]) => { rows.push(row(901, 900, 200)); }],
  ["same controller group", (rows: ProcessObservation[]) => { rows.find(row => row.pid === 200)!.processGroupId = 100; }],
  ["missing runner", (rows: ProcessObservation[]) => { rows.splice(rows.findIndex(row => row.pid === 200), 1); }],
] as const)("rejects %s without sending a restart signal", async (_name, mutate) => {
  const f = fixture();
  try {
    const rows = f.table(); mutate(rows); f.replace(rows);
    await expect(f.stop.forRestart(f.child, identity)).rejects.toThrow(/runner|daemon|process group/);
    expect(f.signals).toEqual([]);
  } finally { f.close(); }
});

it.skipIf(process.platform === "win32")("fails if the admitted daemon dies instead of pretending recovery preserved it", async () => {
  const f = fixture();
  try {
    const kill = f.child.kill.bind(f.child);
    f.child.kill = signal => { const result = kill(signal); f.replace(f.table().filter(row => row.pid !== 200)); return result; };
    await expect(f.stop.forRestart(f.child, identity)).rejects.toThrow("did not survive");
    await f.stop.stopAll();
    expect(f.table().map(row => row.pid).sort()).toEqual([process.pid, 900].sort());
  } finally { f.close(); }
});

it.skipIf(process.platform === "win32")("does not transfer ownership to a reused retained daemon group during final cleanup", async () => {
  const f = fixture();
  try {
    await f.stop.forRestart(f.child, identity);
    f.replace(f.table().map(row => row.pid === 200 ? { ...row, started: "2026-10-02T14:00:00.000Z" } : row));
    await expect(f.stop.stopAll()).rejects.toThrow("cleanup incomplete");
    expect(f.signals.some(([pid]) => pid === 200)).toBe(false);
  } finally { f.close(); }
});

it.each([null, {}, { ...identity, processPid: 0 }, { ...identity, processGroupId: 100 }, { ...identity, processStartedAt: "bad" }])(
  "rejects malformed restart identity %j", value => { expect(() => parseRestartRunnerIdentity(value)).toThrow(); });

it.skipIf(process.platform === "win32")("keeps the first final-cleanup deadline after an inspection failure and repeated stop", async () => {
  const f = fixture();
  const clock = vi.spyOn(Date, "now");
  try {
    await f.stop.forRestart(f.child, identity);
    clock.mockReturnValue(10_000);
    const owner = f.owners[0]!;
    const observe = owner.observe;
    let fail = true;
    owner.observe = async () => { if (fail) { fail = false; throw new Error("one inspection failure"); } await observe(); };
    await expect(f.stop(f.child)).rejects.toThrow("inspection failure");
    clock.mockReturnValue(20_000);
    await f.stop(f.child);
    expect(f.signals.filter(([pid]) => pid === 200)).toEqual([[200, "SIGKILL"]]);
  } finally { clock.mockRestore(); f.close(); }
});

it.skipIf(process.platform === "win32")("final cancellation interrupts restart and retires its preserved descendants", async () => {
  const f = fixture();
  let cleanup: Promise<void> | undefined;
  try {
    const kill = f.child.kill.bind(f.child);
    f.child.kill = signal => { const result = kill(signal); cleanup = f.stop.stopAll(); return result; };
    await expect(f.stop.forRestart(f.child, identity)).rejects.toThrow("Final shutdown interrupted");
    await cleanup;
    expect(f.table().map(row => row.pid).sort()).toEqual([process.pid, 900].sort());
  } finally { f.close(); }
});

it.skipIf(process.platform === "win32")("final cleanup still retires the old runner when replacement startup failed", async () => {
  const f = fixture();
  try {
    await f.stop.forRestart(f.child, identity);
    const replacement = f.root(400);
    Object.assign(replacement, { exitCode: 1 });
    await f.stop.watch(replacement);
    await f.stop.stopAll();
    expect(f.table().map(row => row.pid).sort()).toEqual([process.pid, 900].sort());
    expect(f.signals.filter(([pid]) => pid === 200)).toEqual([[200, "SIGTERM"]]);
  } finally { f.close(); }
});


it("normalizes only the exact Linux comm truncation, never a nearby role name", () => {
  expect(diagnosticProcessKind("/tmp/paperclip-runne", "linux")).toBe("paperclip-runnerd");
  expect(diagnosticProcessKind("/tmp/paperclip-runnerd", "darwin")).toBe("paperclip-runnerd");
  expect(diagnosticProcessKind("paperclip-runne", "darwin")).toBe("other");
  for (const name of ["paperclip-runn", "paperclip-runner", "paperclip-runneX", "paperclip-runnerd-other"]) {
    expect(diagnosticProcessKind(name, "linux")).toBe("other");
  }
});


it.skipIf(process.platform === "win32")("still drains the retained daemon after replacement cleanup reports failure", async () => {
  const f = fixture();
  try {
    await f.stop.forRestart(f.child, identity);
    f.replace([...f.table(), row(400, process.pid)]);
    const replacement = f.root(400); await f.stop.watch(replacement);
    const latestOwner = f.owners[1]!;
    latestOwner.observe = async () => { throw new Error("replacement inspection failed"); };
    await expect(f.stop.stopAll()).rejects.toThrow("cleanup incomplete");
    expect(f.signals.filter(([pid]) => pid === 200)).toEqual([[200, "SIGTERM"]]);
    expect(f.signals.findIndex(([pid]) => pid === 400)).toBeLessThan(f.signals.findIndex(([pid]) => pid === 200));
  } finally { f.close(); }
});


it.skipIf(process.platform === "win32")("does not reuse an already-retired ordinary restart controller's old cleanup deadline", async () => {
  const f = fixture();
  const clock = vi.spyOn(Date, "now").mockReturnValue(10_000);
  try {
    await f.stop(f.child);
    clock.mockReturnValue(20_000);
    f.replace([...f.table(), row(400, process.pid), row(401, 400)]);
    const replacement = f.root(400); await f.stop.watch(replacement);
    await f.stop.stopAll();
    expect(f.signals.filter(([pid]) => pid === 401)).toEqual([[401, "SIGTERM"]]);
  } finally { clock.mockRestore(); f.close(); }
});
