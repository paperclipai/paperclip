import { spawn, type ChildProcess } from "node:child_process";
import { expect, it } from "vitest";
import { createProcessTreeOwner } from "./process-tree-owner.js";
import { readProcessTable, type ProcessObservation } from "./process-tree.js";

function row(pid: number, parentPid: number, processGroupId: number, started = `start-${pid}`, state = "S"): ProcessObservation {
  return { pid, parentPid, processGroupId, started, state, kind: "node" };
}
function fixture(initial: ProcessObservation[]) {
  let table = [row(process.pid, 1, 10), ...initial];
  const root = { pid: 100, exitCode: null as number | null, signalCode: null as NodeJS.Signals | null };
  const signals: Array<[number, NodeJS.Signals]> = [];
  const owner = createProcessTreeOwner(root as ChildProcess, {
    readTable: async () => table,
    signalGroup: (pid, signal) => { signals.push([pid, signal]); },
  });
  return { root, owner, signals, replace: (rows: ProcessObservation[]) => { table = [row(process.pid, 1, 10), ...rows]; } };
}

it.skipIf(process.platform === "win32")("revalidates PID/start before signaling and refuses a recycled group", async () => {
  const f = fixture([row(100, process.pid, 100), row(200, 100, 200)]);
  try {
    await f.owner.observe();
    f.replace([row(100, process.pid, 100), row(200, 1, 200, "new-start")]);
    await expect(f.owner.signal("SIGKILL")).rejects.toThrow("identity became uncertain");
    expect(f.signals).toEqual([]);
  } finally { f.owner.stopObserving(); }
});

it.skipIf(process.platform === "win32")("retains observed descendants when the root exits and excludes the caller group", async () => {
  const f = fixture([row(100, process.pid, 100), row(200, 100, 200), row(300, 100, 10), row(999, process.pid, 999)]);
  try {
    await f.owner.observe();
    f.root.exitCode = 1;
    f.replace([row(200, 1, 200), row(300, 1, 10), row(999, process.pid, 999)]);
    await f.owner.signal("SIGTERM");
    expect(f.signals).toEqual([[200, "SIGTERM"]]);
  } finally { f.owner.stopObserving(); }
});

it.skipIf(process.platform === "win32")("treats an unreaped zombie as stopped without signaling a replacement", async () => {
  const f = fixture([row(100, process.pid, 100), row(200, 100, 200)]);
  try {
    await f.owner.observe();
    f.root.exitCode = 1;
    f.replace([row(200, 1, 200, "start-200", "Z")]);
    await f.owner.signal("SIGKILL");
    expect(f.owner.liveGroups()).toEqual([]);
    expect(f.signals).toEqual([]);
  } finally { f.owner.stopObserving(); }
});

it.skipIf(process.platform === "win32")("sends launcher grace only to the root while retaining nested groups for escalation", async () => {
  const f = fixture([row(100, process.pid, 100), row(200, 100, 200), row(300, 200, 300)]);
  try {
    await f.owner.observe();
    await f.owner.signal("SIGTERM", f.owner.gracefulRoots());
    expect(f.signals).toEqual([[100, "SIGTERM"]]);
    f.root.exitCode = 1;
    f.replace([row(200, 1, 200), row(300, 200, 300)]);
    await f.owner.observe();
    expect([...f.owner.gracefulRoots()]).toEqual([200]);
    await f.owner.signal("SIGKILL");
    expect(f.signals.slice(1).map(([pid]) => pid).sort()).toEqual([200, 300]);
  } finally { f.owner.stopObserving(); }
});

it.skipIf(process.platform === 'win32')('reselects a vanished owner only when no graceful signal was delivered', async () => {
  let table = [row(process.pid, 1, 10), row(100, process.pid, 100), row(200, 100, 200)];
  const child = { pid: 100, exitCode: null as number | null, signalCode: null };
  const delivered: number[] = [];
  let reads = 0;
  let stopping = false;
  const owner = createProcessTreeOwner(child as ChildProcess, {
    readTable: async () => {
      if (stopping && ++reads === 2) { child.exitCode = 0; table = [row(process.pid, 1, 10), row(200, 1, 200)]; }
      return table;
    },
    signalGroup: (pid, signal) => {
      expect(signal).toBe('SIGTERM');
      if (pid === 100) {
        child.exitCode = 0; table = [row(process.pid, 1, 10), row(200, 1, 200)];
        throw Object.assign(new Error('vanished'), { code: 'ESRCH' });
      }
      delivered.push(pid); table = [row(process.pid, 1, 10)];
    },
  });
  try {
    await owner.observe(); stopping = true;
    const { stopOwnedProcessTree } = await import('./process-tree-owner.js');
    await stopOwnedProcessTree(child as ChildProcess, owner, 150, 100);
    expect(delivered).toEqual([200]);
  } finally { owner.stopObserving(); }
});


it.skipIf(process.platform === "win32")("rejects an overflowing inspector instead of returning a partial identity table", async () => {
  const inspector = spawn(process.execPath, ["-e", "process.stdout.write('x'.repeat(2 * 1024 * 1024)); setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  const exited = new Promise<void>(resolve => inspector.once("exit", () => resolve()));
  try {
    expect(await readProcessTable(() => inspector)).toBeNull();
    await exited;
    expect(inspector.signalCode).toBe("SIGKILL");
  } finally { if (inspector.exitCode === null && inspector.signalCode === null) inspector.kill("SIGKILL"); }
});

it.skipIf(process.platform === 'win32')('bounds fallback even when the known direct child cannot be killed', async () => {
  const signals: NodeJS.Signals[] = [];
  const child = { pid: 100, exitCode: null, signalCode: null,
    kill: (signal: NodeJS.Signals) => { signals.push(signal); return false; } } as ChildProcess;
  const owner = createProcessTreeOwner(child, { readTable: async () => null,
    signalGroup: () => { throw new Error('must not signal an unobserved group'); } });
  try {
    const { stopOwnedProcessTree } = await import('./process-tree-owner.js');
    await expect(stopOwnedProcessTree(child, owner, 10, 10)).rejects.toThrow('Known direct child remained');
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
  } finally { owner.stopObserving(); }
});
