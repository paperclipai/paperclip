import { describe, expect, it } from "vitest";
import type { LiveRunForIssue } from "../api/heartbeats";
import { patchRunStatusInList, removeRunFromList } from "./live-runs-cache";

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
