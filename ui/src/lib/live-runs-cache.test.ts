import { describe, expect, it } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import {
  markRunTerminalInList,
  patchRunStatusInList,
  removeRunFromList,
  scopedLiveRunsPadTarget,
  settleTerminalRunInScopedList,
} from "./live-runs-cache";

function run(id: string, status: string): LiveRunForIssue {
  return {
    id,
    status,
    invocationSource: "automation",
    triggerDetail: null,
    startedAt: null,
    finishedAt: null,
    createdAt: "2026-07-15T00:00:00.000Z",
    agentId: "agent-1",
    agentName: "Agent One",
    adapterType: "codex_local",
  };
}

describe("removeRunFromList", () => {
  it("removes the matching run", () => {
    const list = [run("a", "running"), run("b", "running")];
    expect(removeRunFromList(list, "a")).toEqual([run("b", "running")]);
  });

  it("returns the same reference when the run isn't present", () => {
    const list = [run("a", "running")];
    expect(removeRunFromList(list, "zzz")).toBe(list);
  });

  it("handles undefined", () => {
    expect(removeRunFromList(undefined, "a")).toBeUndefined();
  });
});

describe("patchRunStatusInList", () => {
  it("updates status in place and reports present", () => {
    const list = [run("a", "queued"), run("b", "running")];
    const { next, present } = patchRunStatusInList(list, "a", "running");
    expect(present).toBe(true);
    expect(next?.find((r) => r.id === "a")?.status).toBe("running");
    expect(next?.find((r) => r.id === "b")).toBe(list[1]); // untouched entry kept by ref
  });

  it("returns the same reference and present=false when the run isn't in the list", () => {
    const list = [run("a", "running")];
    const { next, present } = patchRunStatusInList(list, "new", "running");
    expect(present).toBe(false);
    expect(next).toBe(list);
  });

  it("returns the same reference (no re-render) when status is unchanged", () => {
    const list = [run("a", "running")];
    const { next, present } = patchRunStatusInList(list, "a", "running");
    expect(present).toBe(true);
    expect(next).toBe(list); // unchanged → original reference preserved
  });

  it("handles undefined", () => {
    const { next, present } = patchRunStatusInList(undefined, "a", "running");
    expect(present).toBe(false);
    expect(next).toBeUndefined();
  });
});

describe("markRunTerminalInList", () => {
  it("keeps the run and sets the terminal status and finishedAt", () => {
    const list = [run("a", "running"), run("b", "running")];
    const next = markRunTerminalInList(list, "a", "succeeded", "2026-07-24T10:00:00.000Z");
    expect(next).toHaveLength(2);
    expect(next?.[0]).toEqual({ ...run("a", "running"), status: "succeeded", finishedAt: "2026-07-24T10:00:00.000Z" });
    expect(next?.[1]).toBe(list[1]); // untouched entry kept by ref
  });

  it("keeps an existing finishedAt when the event carries none", () => {
    const list = [{ ...run("a", "running"), finishedAt: "2026-07-24T09:00:00.000Z" }];
    const next = markRunTerminalInList(list, "a", "failed", null);
    expect(next?.[0]).toEqual({ ...list[0], status: "failed" });
  });

  it("returns the same reference when the run isn't present or is already terminal", () => {
    const list = [{ ...run("a", "succeeded"), finishedAt: "2026-07-24T10:00:00.000Z" }];
    expect(markRunTerminalInList(list, "zzz", "succeeded", null)).toBe(list);
    expect(markRunTerminalInList(list, "a", "succeeded", "2026-07-24T10:00:00.000Z")).toBe(list);
  });

  it("handles undefined", () => {
    expect(markRunTerminalInList(undefined, "a", "succeeded", null)).toBeUndefined();
  });
});

describe("scopedLiveRunsPadTarget", () => {
  it("reads minRunCount from the key params, capped by fetchLimit", () => {
    expect(scopedLiveRunsPadTarget(["live-runs", "c1", "dashboard", { minRunCount: 4 }])).toBe(4);
    expect(scopedLiveRunsPadTarget(["live-runs", "c1", "dashboard", { minRunCount: 4, fetchLimit: 2 }])).toBe(2);
    expect(scopedLiveRunsPadTarget(["live-runs", "c1", "dashboard", { minRunCount: 80 }])).toBe(50);
  });

  it("is 0 when the key has no minRunCount", () => {
    expect(scopedLiveRunsPadTarget(["live-runs", "c1", "agents-page"])).toBe(0);
    expect(scopedLiveRunsPadTarget(["live-runs", "c1", "dashboard", { fetchLimit: 10 }])).toBe(0);
  });
});

describe("settleTerminalRunInScopedList", () => {
  const at = (r: LiveRunForIssue, createdAt: string) => ({ ...r, createdAt });
  const FINISHED = "2026-07-24T10:00:00.000Z";

  it("removes the run when the remaining live runs fill the pad target", () => {
    const list = [run("a", "running"), run("b", "running"), run("c", "queued")];
    expect(settleTerminalRunInScopedList(list, "a", "succeeded", FINISHED, 2)).toEqual([list[1], list[2]]);
  });

  it("removes the run when the list is not padded (target 0)", () => {
    const list = [run("a", "running"), run("b", "running")];
    expect(settleTerminalRunInScopedList(list, "a", "failed", null, 0)).toEqual([list[1]]);
  });

  it("keeps the run as terminal when it is needed to pad the list", () => {
    const list = [run("a", "running")];
    expect(settleTerminalRunInScopedList(list, "a", "succeeded", FINISHED, 4)).toEqual([
      { ...list[0], status: "succeeded", finishedAt: FINISHED },
    ]);
  });

  it("moves the kept run after the live runs, newest finished first", () => {
    const list = [
      at(run("a", "running"), "2026-07-24T09:00:00.000Z"),
      at(run("b", "running"), "2026-07-24T08:00:00.000Z"),
      at(run("old", "succeeded"), "2026-07-24T07:00:00.000Z"),
    ];
    const next = settleTerminalRunInScopedList(list, "a", "succeeded", FINISHED, 4);
    expect(next?.map((r) => [r.id, r.status])).toEqual([
      ["b", "running"],
      ["a", "succeeded"],
      ["old", "succeeded"],
    ]);
  });

  it("returns the same reference when the run is absent or already settled", () => {
    const list = [run("a", "running"), { ...run("b", "succeeded"), finishedAt: FINISHED }];
    expect(settleTerminalRunInScopedList(list, "zzz", "succeeded", null, 4)).toBe(list);
    expect(settleTerminalRunInScopedList(list, "b", "succeeded", FINISHED, 4)).toBe(list);
    expect(settleTerminalRunInScopedList(undefined, "a", "succeeded", null, 4)).toBeUndefined();
  });
});
