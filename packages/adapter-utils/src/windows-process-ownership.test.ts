import { describe, expect, it } from "vitest";
import {
  parseProcessCreatedAtMs,
  parseWindowsCreatedAtBatch,
  parseWindowsProcessSnapshot,
  resolveWindowsOwnedTree,
  terminateWindowsOwnedTree,
  type WindowsProcessSnapshot,
} from "./windows-process-ownership.js";

function snapshot(
  entries: Array<{ pid: number; parentPid: number; createdAtMs: number | null }>,
): WindowsProcessSnapshot {
  const byPid = new Map<number, (typeof entries)[number]>();
  for (const entry of entries) byPid.set(entry.pid, entry);
  return { entries, byPid };
}

function batchReader(
  creationByPid: Map<number, number | null>,
): (pids: number[]) => Promise<Map<number, number | null>> {
  return async (pids: number[]) => {
    const result = new Map<number, number | null>();
    for (const pid of pids) result.set(pid, creationByPid.get(pid) ?? null);
    return result;
  };
}

describe("parseWindowsProcessSnapshot", () => {
  it("parses pid, parent pid and dotnet ticks", () => {
    const parsed = parseWindowsProcessSnapshot(
      "100|50|639300348120824500\n204|100|639300348096098960\n",
    );
    expect(parsed.entries).toHaveLength(2);
    expect(parsed.byPid.get(100)).toEqual({
      pid: 100,
      parentPid: 50,
      createdAtMs:
        Number(639300348120824500n / 10000n - 62135596800000n) + Number(639300348120824500n % 10000n) / 10000,
    });
    expect(parsed.byPid.get(204)?.parentPid).toBe(100);
  });

  it("keeps sub-millisecond precision", () => {
    const parsed = parseWindowsProcessSnapshot("100|50|639300348120824500\n");
    expect(parsed.byPid.get(100)?.createdAtMs).not.toBe(
      Math.trunc(parsed.byPid.get(100)?.createdAtMs ?? 0),
    );
  });

  it("keeps entries without a readable creation time", () => {
    const parsed = parseWindowsProcessSnapshot("100|50|\n");
    expect(parsed.byPid.get(100)?.createdAtMs).toBeNull();
  });
});

describe("parseWindowsCreatedAtBatch", () => {
  it("parses pid and dotnet ticks", () => {
    const parsed = parseWindowsCreatedAtBatch(
      "100|639300348120824500\n204|639300348096098960\n",
    );
    expect(parsed.get(100)).toBe(
      Number(639300348120824500n / 10000n - 62135596800000n) + Number(639300348120824500n % 10000n) / 10000,
    );
    expect(parsed.get(204)).toBe(
      Number(639300348096098960n / 10000n - 62135596800000n) +
        Number(639300348096098960n % 10000n) / 10000,
    );
  });

  it("records an unreadable creation time as null", () => {
    const parsed = parseWindowsCreatedAtBatch("100|\n");
    expect(parsed.get(100)).toBeNull();
  });
});

describe("parseProcessCreatedAtMs", () => {
  it("reads epoch milliseconds from an iso timestamp", () => {
    expect(parseProcessCreatedAtMs("2026-11-15T16:37:34.694Z")).toBe(
      Date.parse("2026-11-15T16:37:34.694Z"),
    );
  });

  it("returns null for unusable values", () => {
    expect(parseProcessCreatedAtMs(null)).toBeNull();
    expect(parseProcessCreatedAtMs("not-a-date")).toBeNull();
  });
});

describe("resolveWindowsOwnedTree", () => {
  const rootCreatedAt = 1_700_000_000_000;

  it("excludes a process that predates the root even when the parent pid matches", () => {
    const resolved = resolveWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: rootCreatedAt,
      snapshot: snapshot([
        { pid: 100, parentPid: 10, createdAtMs: rootCreatedAt },
        { pid: 101, parentPid: 100, createdAtMs: rootCreatedAt - 60_000 },
        { pid: 102, parentPid: 101, createdAtMs: rootCreatedAt - 30_000 },
        { pid: 103, parentPid: 100, createdAtMs: rootCreatedAt + 1_000 },
      ]),
    });

    expect(resolved.status).toBe("resolved");
    expect(resolved.killPids).toEqual([103, 100]);
    expect(resolved.excludedPids).toEqual([101]);
    expect(resolved.unresolvedPids).toEqual([]);
  });

  it("excludes descendants of an excluded process", () => {
    const resolved = resolveWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: rootCreatedAt,
      snapshot: snapshot([
        { pid: 100, parentPid: 10, createdAtMs: rootCreatedAt },
        { pid: 101, parentPid: 100, createdAtMs: rootCreatedAt - 60_000 },
        { pid: 102, parentPid: 101, createdAtMs: rootCreatedAt + 1_000 },
      ]),
    });

    expect(resolved.killPids).toEqual([100]);
    expect(resolved.excludedPids).toEqual([101]);
  });

  it("keeps descendants of a reused root pid inside the ownership window", () => {
    const resolved = resolveWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: rootCreatedAt,
      snapshot: snapshot([
        { pid: 100, parentPid: 10, createdAtMs: rootCreatedAt + 60_000 },
        { pid: 101, parentPid: 100, createdAtMs: rootCreatedAt + 1_000 },
        { pid: 102, parentPid: 100, createdAtMs: rootCreatedAt + 90_000 },
      ]),
    });

    expect(resolved.status).toBe("resolved");
    expect(resolved.rootState).toBe("foreign");
    expect(resolved.rootPidSignallable).toBe(false);
    expect(resolved.upperBoundMs).toBe(rootCreatedAt + 60_000);
    expect(resolved.killPids).toEqual([101]);
    expect(resolved.excludedPids).toEqual([102]);
  });

  it("orders kills deepest first and the root last", () => {
    const resolved = resolveWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: rootCreatedAt,
      snapshot: snapshot([
        { pid: 100, parentPid: 10, createdAtMs: rootCreatedAt },
        { pid: 101, parentPid: 100, createdAtMs: rootCreatedAt + 1_000 },
        { pid: 102, parentPid: 101, createdAtMs: rootCreatedAt + 2_000 },
        { pid: 103, parentPid: 101, createdAtMs: rootCreatedAt + 3_000 },
      ]),
    });

    expect(resolved.killPids).toEqual([102, 103, 101, 100]);
  });

  it("keeps the root out of the kill set when the root kill is disabled", () => {
    const resolved = resolveWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: rootCreatedAt,
      killRoot: false,
      snapshot: snapshot([
        { pid: 100, parentPid: 10, createdAtMs: rootCreatedAt },
        { pid: 101, parentPid: 100, createdAtMs: rootCreatedAt + 1_000 },
      ]),
    });

    expect(resolved.killPids).toEqual([101]);
  });

  it("reports unproven ownership when the recorded creation time is missing", () => {
    const resolved = resolveWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: null,
      snapshot: snapshot([
        { pid: 100, parentPid: 10, createdAtMs: rootCreatedAt },
        { pid: 101, parentPid: 100, createdAtMs: rootCreatedAt + 1_000 },
      ]),
    });

    expect(resolved.status).toBe("unproven");
    expect(resolved.reason).toBe("missing_creation_bound");
    expect(resolved.killPids).toEqual([]);
  });

  it("reports already gone when the root pid is free and nothing references it", () => {
    const resolved = resolveWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: null,
      snapshot: snapshot([{ pid: 101, parentPid: 10, createdAtMs: rootCreatedAt }]),
    });

    expect(resolved.status).toBe("already_gone");
  });

  it("refuses to prove ownership without a recorded creation time", () => {
    const resolved = resolveWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: null,
      snapshot: snapshot([
        { pid: 100, parentPid: 10, createdAtMs: rootCreatedAt },
        { pid: 101, parentPid: 100, createdAtMs: rootCreatedAt + 1_000 },
        { pid: 102, parentPid: 100, createdAtMs: rootCreatedAt - 60_000 },
      ]),
    });

    expect(resolved.status).toBe("unproven");
    expect(resolved.reason).toBe("missing_creation_bound");
    expect(resolved.rootState).toBe("unknown");
    expect(resolved.rootCreatedAtMs).toBeNull();
    expect(resolved.rootPidSignallable).toBe(false);
    expect(resolved.killPids).toEqual([]);
    expect(resolved.excludedPids).toEqual([]);
  });

  it("marks a descendant without a readable creation time as unresolved", () => {
    const resolved = resolveWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: rootCreatedAt,
      snapshot: snapshot([
        { pid: 100, parentPid: 10, createdAtMs: rootCreatedAt },
        { pid: 101, parentPid: 100, createdAtMs: null },
      ]),
    });

    expect(resolved.status).toBe("resolved");
    expect(resolved.killPids).toEqual([100]);
    expect(resolved.unresolvedPids).toEqual([101]);
  });
});

describe("terminateWindowsOwnedTree", () => {
  it("kills only the owned descendants and the root", async () => {
    const killed: number[] = [];
    const alive = new Set([100, 101, 102, 103]);
    const result = await terminateWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: 1_700_000_000_000,
      readSnapshot: async () =>
        snapshot([
          { pid: 100, parentPid: 10, createdAtMs: 1_700_000_000_000 },
          { pid: 101, parentPid: 100, createdAtMs: 1_700_000_001_000 },
          { pid: 102, parentPid: 100, createdAtMs: 1_699_999_000_000 },
          { pid: 103, parentPid: 100, createdAtMs: 1_700_000_002_000 },
        ]),
      readCreatedAtMsBatch: batchReader(
        new Map([
          [100, 1_700_000_000_000],
          [101, 1_700_000_001_000],
          [103, 1_700_000_002_000],
        ]),
      ),
      isPidAlive: (pid) => alive.has(pid),
      killPid: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      verifyMs: 50,
    });

    expect(result.status).toBe("terminated");
    expect(killed).toEqual([101, 103, 100]);
    expect(alive.has(102)).toBe(true);
  });

  it("reports failure without killing when ownership cannot be proved", async () => {
    const killed: number[] = [];
    const result = await terminateWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: null,
      readSnapshot: async () =>
        snapshot([
          { pid: 100, parentPid: 10, createdAtMs: 1_700_000_000_000 },
          { pid: 101, parentPid: 100, createdAtMs: 1_700_000_001_000 },
        ]),
      isPidAlive: () => true,
      killPid: (pid) => killed.push(pid),
    });

    expect(result.status).toBe("unproven");
    expect(result.reason).toBe("missing_creation_bound");
    expect(killed).toEqual([]);
  });

  it("reports failure when the process snapshot is unavailable", async () => {
    const result = await terminateWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: 1_700_000_000_000,
      readSnapshot: async () => null,
      isPidAlive: () => true,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("process_snapshot_unavailable");
  });

  it("does not kill a pid whose creation time changed after the snapshot", async () => {
    const killed: number[] = [];
    const alive = new Set([100, 101]);
    const result = await terminateWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: 1_700_000_000_000,
      readSnapshot: async () =>
        snapshot([
          { pid: 100, parentPid: 10, createdAtMs: 1_700_000_000_000 },
          { pid: 101, parentPid: 100, createdAtMs: 1_700_000_001_000 },
        ]),
      readCreatedAtMsBatch: batchReader(
        new Map([
          [100, 1_700_000_000_000],
          [101, 1_700_000_900_000],
        ]),
      ),
      isPidAlive: (pid) => alive.has(pid),
      killPid: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      verifyMs: 50,
    });

    expect(result.status).toBe("terminated");
    expect(killed).toEqual([100]);
    expect(alive.has(101)).toBe(true);
  });

  it("does not signal the root pid when it was reused", async () => {
    const killed: number[] = [];
    const alive = new Set([100, 101]);
    const result = await terminateWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: 1_700_000_000_000,
      readSnapshot: async () =>
        snapshot([
          { pid: 100, parentPid: 10, createdAtMs: 1_700_000_000_000 },
          { pid: 101, parentPid: 100, createdAtMs: 1_700_000_001_000 },
        ]),
      readCreatedAtMsBatch: batchReader(
        new Map([
          [100, 1_700_000_500_000],
          [101, 1_700_000_001_000],
        ]),
      ),
      isPidAlive: (pid) => alive.has(pid),
      killPid: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      verifyMs: 50,
    });

    expect(result.status).toBe("terminated");
    expect(killed).toEqual([101]);
    expect(alive.has(100)).toBe(true);
  });

  it("reports failure when a live target has no readable creation time", async () => {
    const killed: number[] = [];
    const result = await terminateWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: 1_700_000_000_000,
      readSnapshot: async () =>
        snapshot([
          { pid: 100, parentPid: 10, createdAtMs: 1_700_000_000_000 },
          { pid: 101, parentPid: 100, createdAtMs: 1_700_000_001_000 },
        ]),
      readCreatedAtMsBatch: batchReader(
        new Map([
          [100, 1_700_000_000_000],
          [101, null],
        ]),
      ),
      isPidAlive: () => true,
      killPid: (pid) => killed.push(pid),
      verifyMs: 50,
    });

    expect(result.status).toBe("failed");
    expect(result.reason).toBe("unverified_descendants");
    expect(result.remainingPids).toEqual([101]);
    expect(killed).toEqual([]);
  });

  it("kills the root through the live handle instead of the pid", async () => {
    const killed: number[] = [];
    const alive = new Set([100, 101]);
    let handleKilled = false;
    const result = await terminateWindowsOwnedTree({
      rootPid: 100,
      rootCreatedAtMs: 1_700_000_000_000,
      killRootByHandle: () => {
        handleKilled = true;
        alive.delete(100);
      },
      readSnapshot: async () =>
        snapshot([
          { pid: 100, parentPid: 10, createdAtMs: 1_700_000_000_000 },
          { pid: 101, parentPid: 100, createdAtMs: 1_700_000_001_000 },
        ]),
      readCreatedAtMsBatch: batchReader(
        new Map([
          [101, 1_700_000_001_000],
        ]),
      ),
      isPidAlive: (pid) => alive.has(pid),
      killPid: (pid) => {
        killed.push(pid);
        alive.delete(pid);
      },
      verifyMs: 50,
    });

    expect(result.status).toBe("terminated");
    expect(handleKilled).toBe(true);
    expect(killed).toEqual([101]);
    expect(alive.size).toBe(0);
  });
});
