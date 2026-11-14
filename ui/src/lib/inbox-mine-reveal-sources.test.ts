import { describe, expect, it } from "vitest";
import type { Approval, InboxDismissal, JoinRequest } from "@paperclipai/shared";
import {
  buildMineRevealSources, MINE_REVEAL_SOURCES_MAX_BYTES, mineRevealSourcesQueryKey, readMineRevealSources,
} from "./inbox-mine-reveal-sources";
import { persistedQueryScope } from "./persisted-query-cache";

const approval = (id: string, overrides: Partial<Approval> = {}) => ({
  id, companyId: "company-1", type: "hire_agent", status: "pending", requestedByUserId: null, requestedByAgentId: "agent-1",
  decidedByUserId: null, payload: { name: id }, createdAt: new Date(0), updatedAt: new Date(0), ...overrides,
}) as unknown as Approval;
const joinRequest = (id: string) => ({ id, companyId: "company-1", status: "pending_approval" }) as unknown as JoinRequest;
const dismissal = (itemKey: string) => ({ id: itemKey, companyId: "company-1", userId: "user-1", itemKey, dismissedAt: new Date(0) }) as unknown as InboxDismissal;

describe("Mine reveal sources", () => {
  it("keeps only what Mine renders and the dismissals of those items", () => {
    const sources = buildMineRevealSources({
      userId: "user-1", companyId: "company-1",
      approvals: [
        approval("pending"),
        approval("mine-resolved", { status: "approved", requestedByUserId: "user-1" }),
        approval("other-resolved", { status: "approved", requestedByUserId: "user-2" }),
      ],
      joinRequests: [joinRequest("join-1")],
      dismissals: [dismissal("approval:pending"), dismissal("join:join-1"), dismissal("run:run-1"), dismissal("approval:other-resolved"), dismissal("run:other")],
      failedRunIds: ["run-1"],
    });
    expect(sources.approvals.map((entry) => entry.id)).toEqual(["pending", "mine-resolved"]);
    expect(sources.joinRequests.map((entry) => entry.id)).toEqual(["join-1"]);
    expect(sources.dismissals.map((entry) => entry.itemKey)).toEqual(["approval:pending", "join:join-1", "run:run-1"]);
    expect(readMineRevealSources(sources, "user-1", "company-1")).toBe(sources);
  });

  it("replaces an oversized record with an empty incomplete one that never answers the reveal", () => {
    const big = "x".repeat(MINE_REVEAL_SOURCES_MAX_BYTES);
    const sources = buildMineRevealSources({
      userId: "user-1", companyId: "company-1", approvals: [approval("big", { payload: { summary: big } })],
      joinRequests: [], dismissals: [], failedRunIds: [],
    });
    expect(sources).toEqual({ userId: "user-1", companyId: "company-1", approvals: [], joinRequests: [], dismissals: [], incomplete: true });
    expect(readMineRevealSources(sources, "user-1", "company-1")).toBeNull();
  });

  it("answers only for the same user and company", () => {
    const sources = buildMineRevealSources({ userId: "user-1", companyId: "company-1", approvals: [], joinRequests: [], dismissals: [], failedRunIds: [] });
    expect(readMineRevealSources(sources, "user-2", "company-1")).toBeNull();
    expect(readMineRevealSources(sources, "user-1", "company-2")).toBeNull();
    expect(readMineRevealSources(sources, null, "company-1")).toBeNull();
    expect(readMineRevealSources({ userId: "user-1", companyId: "company-1" }, "user-1", "company-1")).toBeNull();
    expect(readMineRevealSources(undefined, "user-1", "company-1")).toBeNull();
  });

  it("is saved per user and company by the persisted query cache, and only when its data matches its key", () => {
    const sources = buildMineRevealSources({ userId: "user-1", companyId: "company-1", approvals: [], joinRequests: [], dismissals: [], failedRunIds: [] });
    const key = mineRevealSourcesQueryKey("company-1", "user-1");
    expect(persistedQueryScope(key, sources, "user-1", ["company-1"])).toBe("company-1");
    expect(persistedQueryScope(key, sources, "user-2", ["company-1"])).toBeUndefined();
    expect(persistedQueryScope(key, sources, "user-1", ["company-2"])).toBeUndefined();
    expect(persistedQueryScope(key, { ...sources, userId: "user-2" }, "user-1", ["company-1"])).toBeUndefined();
    expect(persistedQueryScope(key, { ...sources, companyId: "company-2" }, "user-1", ["company-1"])).toBeUndefined();
    expect(persistedQueryScope([...key, "extra"], sources, "user-1", ["company-1"])).toBeUndefined();
  });
});
