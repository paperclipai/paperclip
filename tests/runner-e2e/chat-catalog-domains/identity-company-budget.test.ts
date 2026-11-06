import { afterEach, describe, expect, it, vi } from "vitest";
import { remainingIdentityObservationBudget, waitForReply } from "./identity-support.js";
import { companyLifecycleIdentityCases } from "./identity-company-lifecycle.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
function context(replyAt = 180_000, deadline = 270_000): ChatCatalogContext {
  return { observationDeadlineAt: deadline, refreshIssue: async () => {},
    issue: () => ({ conversationState: Date.now() >= replyAt ? "waiting" : "active" }),
    allRuns: async () => [{ id: "source", status: Date.now() >= replyAt ? "succeeded" : "running" }],
  } as unknown as ChatCatalogContext;
}
afterEach(() => vi.useRealTimers());
describe("two company acts share the original observation clock", () => {
  it("accepts a genuinely settled reply past150s within the unchanged original deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const ctx = context(); let done = false;
    const pending = waitForReply(ctx, ctx.observationDeadlineAt).then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(151_000); expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(29_000); await pending; expect(done).toBe(true);
    expect(remainingIdentityObservationBudget(ctx)).toBe(90_000);
  });
  it("preserves the default150s behavior for unchanged callers", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const ctx = context();
    const pending = waitForReply(ctx).then(() => "accepted", () => "timed out");
    await vi.advanceTimersByTimeAsync(150_500); expect(await pending).toBe("timed out");
  });
  it("elapsed setup is consumed, not replaced with a new300s clock", async () => {
    vi.useFakeTimers(); vi.setSystemTime(200_000); const ctx = context(280_000);
    expect(remainingIdentityObservationBudget(ctx)).toBe(70_000);
    const pending = waitForReply(ctx, ctx.observationDeadlineAt).then(() => "accepted", () => "timed out");
    await vi.advanceTimersByTimeAsync(70_500); expect(await pending).toBe("timed out");
    expect(() => remainingIdentityObservationBudget(ctx)).toThrow(/exhausted/);
  });
  it("cannot accept a still-running native or a late successful read crossing the deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(269_000); const ctx = context(0);
    ctx.refreshIssue = async () => { vi.setSystemTime(271_000); };
    const pending = waitForReply(ctx, ctx.observationDeadlineAt).then(() => "accepted", () => "timed out");
    await vi.advanceTimersByTimeAsync(500); expect(await pending).toBe("timed out");
    vi.setSystemTime(269_000); const running = context(999_000);
    const another = waitForReply(running, running.observationDeadlineAt).then(() => "accepted", () => "timed out");
    await vi.advanceTimersByTimeAsync(1_500); expect(await another).toBe("timed out");
  });
  it("rejects actual terminal failure immediately and missing/expired budgets fail closed", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const ctx = context();
    ctx.allRuns = async () => [{ id: "source", status: "failed" }] as never;
    await expect(waitForReply(ctx, ctx.observationDeadlineAt)).rejects.toThrow(/Initial response failed/);
    for (const deadline of [undefined, NaN, Infinity, 0, -1]) expect(() => remainingIdentityObservationBudget({ observationDeadlineAt: deadline } as never)).toThrow();
  });
  it.each(["companies.switch-company", "companies.archive-company"])("%s followup cannot receive a fresh budget after a slow action", async id => {
    vi.useFakeTimers(); vi.setSystemTime(260_000); const ctx = context(0);
    const first = vi.fn(async () => { vi.setSystemTime(271_000); return { status: "active" }; });
    const forbidden = vi.fn(() => { throw new Error("must not start another followup"); });
    const control = { click: first, filter: () => ({ click: forbidden }) };
    ctx.input = { page: { url: () => "https://fixture.test/RUN/chats/ceo", getByRole: () => control },
      fixtures: { company: { id: "company" } }, api: { get: first, post: forbidden } } as never;
    const act = companyLifecycleIdentityCases.find(row => row.scenarioId === id)!.act!;
    await expect(act(ctx, {})).rejects.toThrow(/exhausted/);
    expect(first).toHaveBeenCalledOnce(); expect(forbidden).not.toHaveBeenCalled();
  });
  it.each(["companies.switch-company", "companies.archive-company"])("actual %s act opts in and does not start followup after expiry", async id => {
    vi.useFakeTimers(); vi.setSystemTime(0); const ctx = context(); const followup = vi.fn(() => { throw new Error("real followup boundary"); });
    ctx.input = { page: { url: () => "https://fixture.test/RUN/chats/ceo", getByRole: () => ({ click: followup }) },
      fixtures: { company: { id: "company" } }, api: { get: followup } } as never;
    const act = companyLifecycleIdentityCases.find(row => row.scenarioId === id)!.act!;
    const pending = act(ctx, {}).then(() => "accepted", error => String(error));
    await vi.advanceTimersByTimeAsync(151_000); expect(followup).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_000); expect(await pending).toContain("real followup boundary");
    expect(followup).toHaveBeenCalledOnce();
    expect(followup.mock.calls[0]).toEqual(id === "companies.switch-company" ? [{ timeout: 90_000 }] : ["/api/companies/company", { timeout: 90_000 }]);
    followup.mockClear(); vi.setSystemTime(270_000); await expect(act(ctx, {})).rejects.toThrow(/exhausted/); expect(followup).not.toHaveBeenCalled();
  });
});
