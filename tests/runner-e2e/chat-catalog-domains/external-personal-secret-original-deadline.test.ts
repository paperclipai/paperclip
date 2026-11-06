import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const port = vi.hoisted(() => ({ observation: {} as Record<string, unknown> }));
vi.mock("../codex-subscription-fixture.js", () => ({ codexSubscriptionAgentConfig: (value: unknown) => value }));
vi.mock("./external-support.js", async original => ({ ...await original<typeof import("./external-support.js")>(), observeExternal: async () => port.observation }));
import { personalSecretExternalCases } from "./external-personal-secret.js";
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const start = 10_000, deadline = start + 630_000;
type Fault = "failed" | "cancelled" | "foreign actor" | "foreign company" | "foreign source" | "foreign task context" | "foreign comment" | "foreign person" | "foreign reply" | "no-secret-question" | "no work" | "late read";
function fixture(fault?: Fault, budget: number | "missing" = deadline) {
  vi.useFakeTimers(); vi.setSystemTime(start);
  let reachedHumanPhase = false;
  const query = "Set up my personal publishing credential for this task.";
  const body = fault === "no-secret-question" ? "Which project should I work on?" : "Open secure My secrets settings and set your own personal publishing value. Never paste your key here.";
  const run = { id: "initial", companyId: fault === "foreign company" ? "foreign" : "company", agentId: fault === "foreign actor" ? "morgan" : "ceo", runtimeMode: "native",
    status: "succeeded", contextSnapshot: { issueId: fault === "foreign source" ? "foreign" : "source", ...(fault === "foreign task context" ? { taskId: "foreign" } : {}), commentId: fault === "foreign comment" ? "foreign" : "human" } };
  const comments = [{ id: "human", companyId: "company", issueId: "source", authorUserId: fault === "foreign person" ? "riley" : "person", body: query },
    { id: "reply", companyId: "company", issueId: "source", authorAgentId: "ceo", createdByRunId: "initial", body }];
  const source = { id: "source", companyId: "company", conversationState: "waiting" };
  const allRuns = async () => fault === "no work" ? [] : [{ ...run, status: fault === "failed" || fault === "cancelled" ? fault : Date.now() < (fault ? start : start + 190_000) ? "running" : "succeeded" }];
  const ctx = { ...(budget === "missing" ? {} : { observationDeadlineAt: budget }), scenario: { id: "secrets.personal-secret", query },
    input: { fixtures: { company: { id: "company", issuePrefix: "ACORN" }, agent: { id: "ceo" } }, api: { get: async (path: string) => {
      if (path === "/api/issues/source/comments?order=asc") { if (fault === "late read") vi.setSystemTime(deadline + 1); return comments; }
      if (path === "/api/companies/company/me/user-secrets") { reachedHumanPhase = true; throw Error("NEXT_REAL_HUMAN_PHASE"); }
      throw Error("Unexpected read");
    } } }, issue: () => source, refreshIssue: async () => {}, allRuns,
  } as unknown as ChatCatalogContext;
  port.observation = { companyId: "company", interactions: [], phaseReplies: [{ runId: fault === "foreign reply" ? "foreign" : "initial", commentId: "reply", body }], links: [] };
  const state = { sourceIssueId: "source", currentPersonId: "person", definitionId: "definition" };
  async function act(ms = 191_000) {
    const pending = personalSecretExternalCases[0]!.act!(ctx, state).then(() => undefined, (error: Error) => error);
    await vi.advanceTimersByTimeAsync(ms); return pending;
  }
  return { ctx, act, reachedHumanPhase: () => reachedHumanPhase };
}
it("actual personal-secret act admits the canonical native response after190s within the original deadline, before any secure-entry work", async () => {
  const f = fixture(); const error = await f.act();
  expect(error?.message).toBe("NEXT_REAL_HUMAN_PHASE"); expect(f.reachedHumanPhase()).toBe(true);
  expect(f.ctx.observationDeadlineAt).toBe(deadline); expect(personalSecretExternalCases[0]!.attemptTimeoutMs).toBe(660_000);
});
it.each(["failed", "cancelled", "foreign actor", "foreign company", "foreign source", "foreign task context", "foreign comment", "foreign person", "foreign reply", "no-secret-question", "late read"] as const)("rejects %s before private human entry", async fault => {
  const f = fixture(fault); expect(await f.act()).toBeInstanceOf(Error); expect(f.reachedHumanPhase()).toBe(false);
});
it.each(["missing", NaN, Infinity, start, start - 1] as const)("rejects invalid or exhausted original deadline %s", async budget => {
  const f = fixture(undefined, budget); expect(await f.act(1000)).toBeInstanceOf(Error); expect(f.reachedHumanPhase()).toBe(false);
});
it("never invents work when the canonical native response is absent", async () => {
  const f = fixture("no work"); expect(await f.act(631_000)).toBeInstanceOf(Error); expect(f.reachedHumanPhase()).toBe(false);
});
