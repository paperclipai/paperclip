import { describe, expect, it, vi } from "vitest";
import { createRequestPromiseMemo } from "./request-promise-memo.js";

type TestRequest = {
  actor: {
    userId: string | null;
    companyIds: string[];
    memberships: Array<{ companyId: string; membershipRole: string; status: string }>;
    isInstanceAdmin: boolean;
    keyScope: string | null;
    responsibleUserId: string | null;
  };
};

describe("createRequestPromiseMemo", () => {
  it("deduplicates repeated loads only within the same request", async () => {
    const memoize = createRequestPromiseMemo<TestRequest, string>();
    const load = vi.fn(async () => "allowed");
    const request = requestFor();

    await Promise.all([
      memoize(request, "issue-1", load),
      memoize(request, "issue-1", load),
    ]);

    expect(load).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["actor", { userId: "user-2" }],
    ["company", { companyIds: ["company-2"] }],
    ["membership role", { memberships: [{ companyId: "company-1", membershipRole: "member", status: "active" }] }],
    ["membership status", { memberships: [{ companyId: "company-1", membershipRole: "owner", status: "suspended" }] }],
    ["instance admin", { isInstanceAdmin: true }],
    ["agent key scope", { keyScope: "read" }],
    ["responsible user", { responsibleUserId: "user-2" }],
  ])("never reuses a decision across requests after a %s change", async (_label, actorPatch) => {
    const memoize = createRequestPromiseMemo<TestRequest, string>();
    const load = vi.fn(async () => "allowed");
    const firstRequest = requestFor();
    const secondRequest = requestFor(actorPatch);

    await memoize(firstRequest, "issue-1", load);
    await memoize(secondRequest, "issue-1", load);

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("retries a rejected load within the same request", async () => {
    const memoize = createRequestPromiseMemo<TestRequest, string>();
    const load = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValueOnce("allowed");
    const request = requestFor();

    await expect(memoize(request, "issue-1", load)).rejects.toThrow("transient");
    await expect(memoize(request, "issue-1", load)).resolves.toBe("allowed");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache resolved values rejected by the cache policy", async () => {
    const memoize = createRequestPromiseMemo<TestRequest, string | null>({
      shouldCache: (value) => value !== null,
    });
    const load = vi.fn(async () => null);
    const request = requestFor();

    await expect(memoize(request, "missing-issue", load)).resolves.toBeNull();
    await expect(memoize(request, "missing-issue", load)).resolves.toBeNull();

    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not reuse loads across many unique requests and keys", async () => {
    const memoize = createRequestPromiseMemo<TestRequest, string | null>({
      shouldCache: (value) => value !== null,
    });
    const load = vi.fn(async () => null);
    const requestCount = 1_000;

    await Promise.all(Array.from({ length: requestCount }, (_, index) => (
      memoize(requestFor(), `missing-issue-${index}`, load)
    )));

    expect(load).toHaveBeenCalledTimes(requestCount);
  });
});

function requestFor(actorPatch: Partial<TestRequest["actor"]> = {}): TestRequest {
  return {
    actor: {
      userId: "user-1",
      companyIds: ["company-1"],
      memberships: [{ companyId: "company-1", membershipRole: "owner", status: "active" }],
      isInstanceAdmin: false,
      keyScope: null,
      responsibleUserId: "user-1",
      ...actorPatch,
    },
  };
}
