import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
vi.mock("../codex-subscription-fixture.js", () => ({ codexSubscriptionAgentConfig: (value: unknown) => value }));
import { teamInstallExternalCases } from "./external-team-install.js";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const start = 10_000, deadline = start + 450_000;
type Fault = "failed" | "cancelled" | "foreign actor" | "foreign company" | "foreign source" | "foreign native comment" | "foreign human" | "foreign reply" | "missing reply" | "late read" | "no native";
function fixture(fault?: Fault, budget: number | "missing" = deadline) {
  vi.useFakeTimers(); vi.setSystemTime(start); let readbackReached = false;
  const query = "Install that website team in this company.";
  const run = { id: "initial", companyId: fault === "foreign company" ? "other" : "company", agentId: fault === "foreign actor" ? "morgan" : "ceo", runtimeMode: "native",
    contextSnapshot: { issueId: fault === "foreign source" ? "other" : "source", commentId: fault === "foreign native comment" ? "other" : "human" } };
  const comments = [{ id: "human", companyId: "company", issueId: "source", authorUserId: fault === "foreign human" ? "riley" : "person", body: query },
    ...(fault === "missing reply" ? [] : [{ id: "reply", companyId: "company", issueId: "source", authorAgentId: fault === "foreign reply" ? "morgan" : "ceo", createdByRunId: "initial", body: "Installed the graph; a required skill remains blocked by the local conflict." }])];
  const ctx = { ...(budget === "missing" ? {} : { observationDeadlineAt: budget }), scenario: { id: "teams.install-team", query },
    input: { fixtures: { company: { id: "company" }, agent: { id: "ceo" } }, api: { get: async (url: string) => {
      if (url === "/api/issues/source/comments?order=asc") { if (fault === "late read") vi.setSystemTime(deadline + 1); return comments; }
      if (url === "/api/companies/company/agents") { readbackReached = true; throw Error("NEXT_INDEPENDENT_RUNTIME_READBACK"); }
      return [];
    } } }, issue: () => ({ id: "source", companyId: "company", conversationState: "waiting" }), refreshIssue: async () => {},
    allRuns: async () => fault === "no native" ? [] : [{ ...run, status: fault === "failed" || fault === "cancelled" ? fault : Date.now() < (fault ? start : start + 190_000) ? "running" : "succeeded" }],
  } as unknown as ChatCatalogContext;
  async function act(ms = 191_000) {
    const pending = teamInstallExternalCases[0]!.act!(ctx, { sourceIssueId: "source", humanId: "person" }).then(() => undefined, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(ms); return pending;
  }
  return { ctx, act, readbackReached: () => readbackReached };
}
it("actual installer act observes a canonical response after190s in its original budget before existing independent readback", async () => {
  const f = fixture(); expect((await f.act())?.message).toBe("NEXT_INDEPENDENT_RUNTIME_READBACK"); expect(f.readbackReached()).toBe(true);
  expect(f.ctx.observationDeadlineAt).toBe(deadline); expect(teamInstallExternalCases[0]!.attemptTimeoutMs).toBe(480_000);
});
it.each(["failed", "cancelled", "foreign actor", "foreign company", "foreign source", "foreign native comment", "foreign human", "foreign reply", "missing reply", "late read"] as const)("rejects %s before independent readback or repeat", async fault => {
  const f = fixture(fault); expect(await f.act()).toBeInstanceOf(Error); expect(f.readbackReached()).toBe(false);
});
it.each(["missing", NaN, Infinity, start, start - 1] as const)("rejects invalid original deadline%s", async budget => {
  const f = fixture(undefined, budget); expect(await f.act(1000)).toBeInstanceOf(Error); expect(f.readbackReached()).toBe(false);
});
it("does not invent a native response when no source work exists", async () => {
  const f = fixture("no native"); expect(await f.act(451_000)).toBeInstanceOf(Error); expect(f.readbackReached()).toBe(false);
});
