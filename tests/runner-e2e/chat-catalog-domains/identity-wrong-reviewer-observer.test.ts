import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { questionIdentityCases, gradeQuestions } from "./identity-questions-and-approvals.js";
vi.mock("./identity-auth.js", () => ({ createAuthenticatedPerson: vi.fn(), enrollPrerequisitePerson: vi.fn() }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const start = 50_000;
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(start);
  let completesAt = start + 160_000, status = "succeeded", noWork = false;
  const post = vi.fn(async () => ({ status: () => 403 }));
  const ctx = { observationDeadlineAt: start + 270_000, refreshIssue: async () => {},
    issue: () => ({ id: "source", conversationState: Date.now() >= completesAt ? "waiting" : "running" }),
    allRuns: async () => noWork ? [] : [{ status: Date.now() >= completesAt ? status : "running" }],
    input: { api: { baseURL: "http://fixture.test" }, page: { context: () => ({ request: { post } }) } },
  } as unknown as ChatCatalogContext;
  const state: Record<string, unknown> = { original: { id: "riley-card" } };
  const d = questionIdentityCases.find(row => row.scenarioId === "questions-and-approvals.wrong-reviewer")!;
  const act = () => Promise.resolve(d.act!(ctx, state));
  return { ctx, state, post, act, completesAt: (value: number) => { completesAt = value; },
    status: (value: string) => { status = value; }, noWork: () => { noWork = true; } };
}
it("the actual wrong-reviewer caller can reach its denied-human probe after160s within its original clock", async () => {
  const f = fixture(); const pending = f.act().then(() => null, error => error as Error);
  await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(160_000);
  expect(await pending).toBeNull(); expect(f.post).toHaveBeenCalledOnce(); expect(f.state.humanAcceptStatus).toBe(403);
  expect(f.ctx.observationDeadlineAt).toBe(start + 270_000);
});
it.each([undefined, NaN, Infinity, start, start - 1])("rejects missing/invalid/exhausted original deadline %s before the human probe", async deadline => {
  const f = fixture(); Object.assign(f.ctx, { observationDeadlineAt: deadline });
  await expect(f.act()).rejects.toThrow(/Original identity observation budget/); expect(f.post).not.toHaveBeenCalled();
});
it.each(["failed", "cancelled", "timed_out"])("rejects failed/stopped native work %s before the human probe", async status => {
  const f = fixture(); f.completesAt(start); f.status(status);
  await expect(f.act()).rejects.toThrow(/Initial response failed/); expect(f.post).not.toHaveBeenCalled();
});
it.each([false, true])("never accepts no completion or no work (noWork=%s) past the same original clock", async noWork => {
  const f = fixture(); Object.assign(f.ctx, { observationDeadlineAt: start + 1000 }); f.completesAt(start + 2000);
  if (noWork) { f.completesAt(start); f.noWork(); }
  const pending = f.act().then(() => null, error => error as Error);
  await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(3000);
  expect((await pending)?.message).toMatch(/Timed out waiting/); expect(f.post).not.toHaveBeenCalled();
});
it("checks after an awaited native observation before probing the human accept route", async () => {
  const f = fixture(); Object.assign(f.ctx, { observationDeadlineAt: start + 1000 }); f.completesAt(start);
  f.ctx.refreshIssue = async () => { vi.setSystemTime(start + 1001); };
  const pending = f.act().then(() => null, error => error as Error);
  await vi.dynamicImportSettled(); await vi.advanceTimersByTimeAsync(3000);
  expect((await pending)?.message).toMatch(/Timed out waiting/); expect(f.post).not.toHaveBeenCalled();
});
it("still requires actual audience denial, a pending unchanged request and no unapproved work", () => {
  const original = { id: "riley-card", payload: { prompt: "Riley's request" }, status: "pending", kind: "request_confirmation" };
  const valid = () => ({ scenarioId: "questions-and-approvals.wrong-reviewer", companyId: "acorn", leadId: "ceo", company: {}, companies: [], agents: [],
    interactions: [structuredClone(original)], tasks: [], projects: [], goals: [], activity: [], documents: [], links: [], runs: [],
    reply: "Only Riley, the addressed reviewer, can approve this request.",
    state: { original, alexId: "alex", rileyId: "riley", realHumanIdentities: true, visibleToAlex: true, humanAcceptStatus: 403 } });
  expect(gradeQuestions(valid()).passed).toBe(true);
  const accepted = valid(); accepted.interactions[0]!.status = "accepted"; expect(gradeQuestions(accepted).passed).toBe(false);
  const bypass = valid(); bypass.state.humanAcceptStatus = 200; expect(gradeQuestions(bypass).passed).toBe(false);
  const silent = valid(); silent.reply = "Done."; expect(gradeQuestions(silent).passed).toBe(false);
  const fake = valid(); fake.state.realHumanIdentities = false; expect(gradeQuestions(fake).passed).toBe(false);
});
