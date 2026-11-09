import { describe, expect, it, vi } from "vitest";
import { readInboxMine } from "./inbox-mine-read.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
type Row = { id: string; parentId?: string; interruption?: string };
const sourceError = (_error: unknown, source: string) => ({ status: 503, message: `${source} unavailable` });

describe("Mine read composition", () => {
  it("loads failure state before the primary list finishes and reveals one complete snapshot", async () => {
    const primary = deferred<Row[]>(), rich = deferred<Row[]>();
    const loadContext = vi.fn((ids: string[], projection: string) => projection === "rows"
      ? rich.promise : Promise.resolve(ids.map((id) => ({ id }))));
    const result = readInboxMine({
      loadIssues: () => primary.promise,
      loadFailures: async () => [{ id: "run", issueId: "failure" }],
      loadContext, sourceError,
    });
    await vi.waitFor(() => expect(loadContext).toHaveBeenCalledWith(["failure"], "rows"));
    primary.resolve([{ id: "child", parentId: "parent" }]);
    await vi.waitFor(() => expect(loadContext).toHaveBeenCalledWith(["parent"], "index"));
    const settled = vi.fn();
    void result.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    rich.resolve([{ id: "failure", interruption: "current" }]);
    expect(await result).toMatchObject({
      issues: [{ id: "child", parentId: "parent" }],
      contextIssues: [{ id: "parent" }, { id: "failure", interruption: "current" }],
      failureIssueIds: ["failure"],
    });
  });

  it("reuses indexed parents, preserves rich overlap, and records known missing failures", async () => {
    const loadContext = vi.fn(async (ids: string[], projection: string) => ids.filter((id) => id !== "missing")
      .map((id) => ({ id, ...(projection === "rows" ? { interruption: "resolved" } : {}) })));
    const result = await readInboxMine({
      loadIssues: async () => [{ id: "indexed" }, { id: "a", parentId: "indexed" }, { id: "b", parentId: "overlap" }],
      loadFailures: async () => [{ id: "run-a", issueId: "overlap" }, { id: "run-b", contextSnapshot: { taskId: "missing" } }],
      loadContext, sourceError,
    });
    expect(loadContext.mock.calls.every(([ids]) => !ids.includes("indexed"))).toBe(true);
    expect(result.contextIssues).toEqual([{ id: "overlap", interruption: "resolved" }]);
    expect(result.failureIssueIds).toEqual(["missing", "overlap"]);
  });

  it("keeps tasks and captions when the optional run read fails", async () => {
    const result = await readInboxMine({
      loadIssues: async () => [{ id: "child", parentId: "parent" }],
      loadFailures: async (): Promise<{ id: string }[]> => { throw new Error("private database detail"); },
      loadContext: async (ids) => ids.map((id) => ({ id })), sourceError,
    });
    expect(result.contextIssues).toEqual([{ id: "parent" }]);
    expect(result.failureRuns).toEqual([]);
    expect(result.failureError).toEqual({ status: 503, message: "failures unavailable" });
  });

  it("keeps parent captions when rich context fails without claiming verified failure state", async () => {
    const result = await readInboxMine({
      loadIssues: async () => [{ id: "child", parentId: "parent" }],
      loadFailures: async () => [{ id: "run", issueId: "failure" }],
      loadContext: async (ids, projection) => {
        if (projection === "rows") throw new Error("read failed");
        return ids.map((id) => ({ id }));
      }, sourceError,
    });
    expect(result.contextIssues).toEqual([{ id: "parent" }]);
    expect(result.failureIssueIds).toEqual([]);
    expect(result.contextError).toEqual({ status: 503, message: "context unavailable" });
  });

  it("bounds context batches even with a full failed-run window", async () => {
    const loadContext = vi.fn(async (ids: string[]) => ids.map((id) => ({ id })));
    const result = await readInboxMine({
      loadIssues: async (): Promise<Row[]> => [],
      loadFailures: async () => Array.from({ length: 200 }, (_, i) => ({ id: `run-${i}`, issueId: `issue-${i}` })),
      loadContext, sourceError,
    });
    expect(loadContext.mock.calls.map(([ids]) => ids.length)).toEqual([100, 100]);
    expect(result.failureIssueIds).toHaveLength(200);
  });

  it("does not release the read while another started branch still runs after a primary error", async () => {
    const rich = deferred<Row[]>();
    const loadContext = vi.fn(() => rich.promise);
    const result = readInboxMine({
      loadIssues: async (): Promise<Row[]> => { throw new Error("primary unavailable"); },
      loadFailures: async () => [{ id: "run", issueId: "failure" }],
      loadContext, sourceError,
    });
    const rejected = vi.fn();
    const observed = result.catch(rejected);
    await vi.waitFor(() => expect(loadContext).toHaveBeenCalled());
    expect(rejected).not.toHaveBeenCalled();
    rich.resolve([]);
    await observed;
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ message: "primary unavailable" }));
  });
});
