import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { createExternalReviewWaitReader, type ExternalReviewWait } from "./external-review-wait.js";

const db = {} as Db;
const wait = (issueId: string) => ({ issueId, companyId: "company" }) as ExternalReviewWait;

describe("createExternalReviewWaitReader", () => {
  it("reads each issue once for callers that share one request", async () => {
    const list = vi.fn(async (_db: Db, _companyId: string, issueIds: string[]) =>
      issueIds.filter(issueId => issueId !== "b").map(wait));
    const read = createExternalReviewWaitReader(db, "company", list);
    // The review and blocked-inbox maps start their reads concurrently.
    const [page, graph] = await Promise.all([read(["a", "b"]), read(["c", "a", "b", "c"])]);
    expect(page).toEqual([wait("a")]);
    expect(graph).toEqual([wait("c"), wait("a")]);
    expect(await read(["a"])).toEqual([wait("a")]);
    expect(await read([])).toEqual([]);
    expect(list.mock.calls.map(([, companyId, issueIds]) => [companyId, issueIds])).toEqual([
      ["company", ["a", "b"]], ["company", ["c"]],
    ]);
    expect(list.mock.calls.every(([database]) => database === db)).toBe(true);
  });

  it("rejects every caller that waits on a failed read", async () => {
    const failure = new Error("database unavailable");
    const list = vi.fn(async () => { throw failure; });
    const read = createExternalReviewWaitReader(db, "company", list);
    await expect(Promise.all([read(["a"]), read(["a", "b"])])).rejects.toBe(failure);
    expect(list).toHaveBeenCalledTimes(2);
  });
});
