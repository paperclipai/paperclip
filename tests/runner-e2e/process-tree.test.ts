import { describe, expect, it } from "vitest";
import {
  observeDescendantProcessTree,
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
