import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "./chat-catalog-contract.js";

const clock = vi.hoisted(() => ({ now: 30_000, deadlines: [] as number[] }));
vi.mock("./codex-subscription-fixture.js", () => ({ codexSubscriptionAgentConfig: (value: unknown) => value }));
vi.mock("./chat-flow.js", () => ({ sendChatMessage: vi.fn() }));
vi.mock("./api.js", () => ({ pollUntil: async (options: {
  deadlineAt: number; load(): Promise<unknown>; accept(value: unknown): boolean; reject?(value: unknown): string | undefined;
}) => {
  clock.deadlines.push(options.deadlineAt);
  while (Date.now() < options.deadlineAt) {
    const value = await options.load();
    const rejected = options.reject?.(value);
    if (rejected) throw Error(rejected);
    if (options.accept(value)) return value;
    clock.now += 10_000;
  }
  throw Error("Controlled initial observation expired");
} }));
import { questionIdentityCases } from "./chat-catalog-domains/identity-questions-and-approvals.js";
const owner = questionIdentityCases.find(row => row.scenarioId === "questions-and-approvals.multi-part-question")!;
afterEach(() => vi.restoreAllMocks());
type Options = { deadline?: number | "missing"; readyAt?: number; status?: string; noWork?: boolean; extraRun?: boolean;
  foreign?: "company" | "actor" | "source" | "comment" | "question"; duplicateComment?: boolean; missingComment?: boolean;
  lateLoad?: boolean; lateSourceRead?: boolean };
function fixture(options: Options = {}) {
  clock.now = 30_000; clock.deadlines.splice(0);
  vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  const deadline = options.deadline === undefined ? 300_000 : options.deadline;
  const readyAt = options.readyAt ?? 210_000;
  const query = "Help me choose the details for the launch page before you build it.";
  const click = vi.fn(async () => { throw Error("Reached human question form"); });
  const runs = () => options.noWork ? [] : [{ id: "native", companyId: options.foreign === "company" ? "foreign" : "company",
    agentId: options.foreign === "actor" ? "other" : "ceo", status: clock.now >= readyAt ? options.status ?? "succeeded" : "running",
    contextSnapshot: { issueId: options.foreign === "source" ? "unrelated" : "source", commentId: options.foreign === "comment" ? "other" : "human" } },
    ...(options.extraRun ? [{ id: "extra", status: "succeeded" }] : [])];
  const allRuns = vi.fn(async () => { if (options.lateLoad) clock.now = 300_001; return runs(); });
  const get = vi.fn(async (url: string) => {
    expect(url).toBe("/api/issues/source/comments?order=asc");
    if (options.lateSourceRead) clock.now = 300_001;
    const comment = { id: "human", issueId: "source", authorUserId: "person", body: query };
    return options.missingComment ? [] : [comment, ...(options.duplicateComment ? [{ ...comment, id: "duplicate" }] : [])];
  });
  const ctx = { ...(deadline === "missing" ? {} : { observationDeadlineAt: deadline }), scenario: { query },
    input: { fixtures: { company: { id: "company" }, agent: { id: "ceo" } }, api: { get }, page: { locator: () => ({ click }) } },
    issue: () => ({ id: "source", conversationState: clock.now >= readyAt ? "waiting" : "active" }),
    refreshIssue: vi.fn(async () => {}), allRuns,
  } as unknown as ChatCatalogContext;
  const state = { sourceId: "source", original: { id: "question", companyId: "company", issueId: options.foreign === "question" ? "unrelated" : "source", kind: "ask_user_questions", status: "pending" } };
  return { ctx, state, click, get, allRuns };
}
it("owning multipart act observes valid delayed source completion only inside its original300s before any human form action", async () => {
  const f = fixture();
  await expect(owner.act!(f.ctx, f.state)).rejects.toThrow("Reached human question form");
  expect(clock.deadlines).toEqual([300_000]);
  expect(clock.now).toBeGreaterThan(180_000); // previous150s from30s setup boundary
  expect(clock.now).toBeLessThan(300_000);
  expect(f.click).toHaveBeenCalledOnce();
});
it.each(["missing", NaN, Infinity, 29_999] as const)("rejects missing/invalid/expired original deadline before native or human work: %s", async deadline => {
  const f = fixture({ deadline });
  await expect(owner.act!(f.ctx, f.state)).rejects.toThrow();
  expect(f.allRuns).not.toHaveBeenCalled(); expect(f.get).not.toHaveBeenCalled(); expect(f.click).not.toHaveBeenCalled();
});
it.each(["company", "actor", "source", "comment", "question"] as const)("does not use a completed foreign %s as permission to answer the saved question", async foreign => {
  const f = fixture({ readyAt: 30_000, foreign });
  await expect(owner.act!(f.ctx, f.state)).rejects.toThrow(); expect(f.click).not.toHaveBeenCalled();
});
it.each([{ status: "running" }, { status: "failed" }, { status: "cancelled" }, { noWork: true }, { extraRun: true },
  { lateLoad: true }, { lateSourceRead: true }, { readyAt: 300_001 }, { missingComment: true }, { duplicateComment: true }])("keeps incomplete/invalid/late source work closed before human action %j", async options => {
  const f = fixture(options);
  await expect(owner.act!(f.ctx, f.state)).rejects.toThrow(); expect(f.click).not.toHaveBeenCalled();
  expect(clock.deadlines).toEqual([300_000]);
});
