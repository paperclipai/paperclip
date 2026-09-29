import { describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import {
  observeDescendantProcessTree,
  OwnedProcessTree,
  readProcessTable,
  refreshContinuouslyLiveProcessGroups,
  revalidateObservedProcessGroups,
  safeProcessGroupTerminationOrder,
  type ProcessObservation,
} from "./process-tree.js";

function process(
  pid: number,
  parentPid: number,
  processGroupId: number,
  started = `start-${pid}`,
): ProcessObservation {
  return { pid, parentPid, processGroupId, started, kind: "node" };
}

describe("runner E2E process-tree cleanup", () => {
  it.skipIf(globalThis.process.platform === "win32")("revalidates and stops a real detached child after its wrapper exits", async () => {
    const wrapper = spawn(globalThis.process.execPath, ["-e", `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
        detached: true, stdio: 'ignore'
      });
      child.unref();
      process.on('message', () => process.exit(0));
      process.send(child.pid);
    `], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] });
    const owned = new OwnedProcessTree(wrapper.pid!);
    try {
      const [pid] = await once(wrapper, "message");
      expect(typeof pid).toBe("number");
      const initial = await readProcessTable();
      expect(initial).not.toBeNull();
      owned.observe(initial!, true);
      expect(owned.groups.some((group) => group.processGroupId === pid)).toBe(true);
      const exited = once(wrapper, "exit");
      wrapper.send("exit");
      await exited;
      const orphaned = await readProcessTable();
      expect(orphaned?.find((candidate) => candidate.pid === pid)?.parentPid).not.toBe(wrapper.pid);
      const groups = owned.observe(orphaned!, false);
      expect(groups.map((group) => group.processGroupId)).toEqual([pid]);
      const launcherGroup = orphaned!.find((candidate) => candidate.pid === globalThis.process.pid)!.processGroupId;
      const order = safeProcessGroupTerminationOrder({ rootProcessGroupId: wrapper.pid!, currentProcessGroupId: launcherGroup, groups });
      expect(order).toEqual([pid]);
      for (const group of order) globalThis.process.kill(-group, "SIGTERM");
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        const table = await readProcessTable();
        if (table && owned.observe(table, false).length === 0) break;
        await delay(25);
      }
      expect(owned.groups).toEqual([]);
    } finally {
      wrapper.kill("SIGKILL");
      const table = await readProcessTable();
      if (table) {
        const groups = owned.observe(table, false);
        const launcherGroup = table.find((candidate) => candidate.pid === globalThis.process.pid)?.processGroupId ?? null;
        for (const pid of safeProcessGroupTerminationOrder({ rootProcessGroupId: wrapper.pid!, currentProcessGroupId: launcherGroup, groups })) {
          try { globalThis.process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
        }
      }
    }
  });

  it("retains detached runner/provider identities after both parent and wrapper exit", () => {
    const owned = new OwnedProcessTree(100);
    owned.observe([
      process(100, 10, 100), process(101, 100, 100),
      process(200, 101, 200), process(300, 200, 300),
    ], true);
    const groups = owned.observe([
      process(200, 1, 200), process(300, 1, 300), process(500, 1, 500),
    ], false);
    expect(safeProcessGroupTerminationOrder({
      rootProcessGroupId: 100, currentProcessGroupId: 10, groups,
    })).toEqual([300, 200]);
    expect(owned.observe([], false)).toEqual([]);
  });

  it("does not adopt a reused wrapper pid or detached process group", () => {
    const owned = new OwnedProcessTree(100);
    owned.observe([process(100, 10, 100), process(200, 100, 200)], true);
    expect(owned.observe([
      process(100, 10, 100, "new-wrapper"),
      process(201, 100, 201), process(200, 1, 200, "new-runner"),
    ], true)).toEqual([]);
  });

  it("tracks new descendants of a verified orphan with stable ownership depths", () => {
    const owned = new OwnedProcessTree(100);
    const table = [process(100, 10, 100), process(200, 100, 200), process(201, 200, 200)];
    const first = structuredClone(owned.observe(table, true));
    for (let i = 0; i < 20; i += 1) expect(owned.observe(table, true)).toEqual(first);
    const orphanTable = [process(200, 1, 200), process(201, 200, 200), process(300, 201, 300)];
    const groups = owned.observe(orphanTable, false);
    expect(safeProcessGroupTerminationOrder({ rootProcessGroupId: 100, currentProcessGroupId: 10, groups })).toEqual([300, 200]);
  });

  it("orders verified nested groups before the outer group and excludes unsafe groups", () => {
    const table = [
      process(100, 10, 100),
      process(101, 100, 100),
      process(200, 101, 200),
      process(300, 200, 300),
      process(301, 300, 300),
      process(400, 101, 10),
      process(500, 999, 500),
    ];
    const observed = observeDescendantProcessTree(table, 100);
    expect(
      safeProcessGroupTerminationOrder({
        rootProcessGroupId: 100,
        currentProcessGroupId: 10,
        groups: observed.groups,
      }),
    ).toEqual([300, 200, 100]);
  });

  it("rejects a reused pid whose start identity no longer matches", () => {
    const observed = observeDescendantProcessTree(
      [process(100, 10, 100), process(200, 100, 200)],
      100,
    );
    expect(
      revalidateObservedProcessGroups(observed.groups, [
        process(100, 10, 100),
        process(200, 1, 200, "reused-process"),
      ]).map((group) => group.processGroupId),
    ).toEqual([100]);
  });

  it("refuses every group when launcher identity is unavailable", () => {
    const observed = observeDescendantProcessTree(
      [process(100, 10, 100), process(200, 100, 200)],
      100,
    );
    expect(
      safeProcessGroupTerminationOrder({
        rootProcessGroupId: 100,
        currentProcessGroupId: null,
        groups: observed.groups,
      }),
    ).toEqual([]);
  });

  it("does not add an unobserved root process group after revalidation", () => {
    expect(
      safeProcessGroupTerminationOrder({
        rootProcessGroupId: 100,
        currentProcessGroupId: 10,
        groups: [
          {
            processGroupId: 200,
            depth: 1,
            members: [{ pid: 200, started: "start-200" }],
          },
        ],
      }),
    ).toEqual([200]);
  });

  it("retains a continuously live group when a cleanup helper replaces its original member", () => {
    const observed = observeDescendantProcessTree(
      [process(100, 10, 100), process(200, 100, 200)],
      100,
    );
    const verified = revalidateObservedProcessGroups(observed.groups, [
      process(100, 10, 100),
      process(200, 100, 200),
    ]);
    const refreshed = refreshContinuouslyLiveProcessGroups(verified, [
      process(100, 10, 100),
      process(201, 1, 200),
    ]);

    expect(
      refreshed.find((group) => group.processGroupId === 200)?.members,
    ).toEqual([{ pid: 201, started: "start-201" }]);
    expect(
      refreshContinuouslyLiveProcessGroups(refreshed, [
        process(100, 10, 100),
      ]).map((group) => group.processGroupId),
    ).toEqual([100]);
  });
});
