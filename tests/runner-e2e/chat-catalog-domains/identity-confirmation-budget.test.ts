import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const repeated = vi.hoisted(() => vi.fn());
vi.mock("../chat-flow.js", async importOriginal => ({ ...await importOriginal<object>(), sendChatMessage: repeated }));
import { confirmationWorkflowIdentityCases } from "./identity-confirmation-workflows.js";
const definition = confirmationWorkflowIdentityCases.find(row => row.scenarioId === "questions-and-approvals.accept-one-proposal")!;
function context(settlesAt = 180_000): ChatCatalogContext {
  return { observationDeadlineAt: 390_000, scenario: { query: "Yes, go ahead with that." }, refreshIssue: async () => {},
    issue: () => ({ id: "chat", conversationState: Date.now() >= settlesAt ? "waiting" : "active" }),
    allRuns: async () => [{ status: Date.now() >= settlesAt ? "succeeded" : "running" }],
  } as unknown as ChatCatalogContext;
}
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe("confirmation first reply and declared repeat share the original420s outer", () => {
  it("actual act can reach real product readback after150s without changing its original deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0); const ctx = context();
    const get = vi.fn(async () => { throw new Error("independent saved-task boundary"); });
    ctx.input = { api: { get }, fixtures: { company: { id: "acorn" } } } as never;
    const pending = definition.act!(ctx, {}).catch(String);
    await vi.advanceTimersByTimeAsync(151_000); expect(get).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(29_000); expect(await pending).toContain("independent saved-task boundary");
    expect(get).toHaveBeenCalledExactlyOnceWith("/api/companies/acorn/issues?includeAgentCreatedTasks=true", { timeout: 210_000 });
    expect(ctx.observationDeadlineAt).toBe(390_000); expect(repeated).not.toHaveBeenCalled();
  });
  it("slow reload cannot start a fresh read or send the declared repeat after expiry", async () => {
    vi.useFakeTimers(); vi.setSystemTime(389_000); const ctx = context(0);
    const get = vi.fn().mockResolvedValueOnce([{ id: "task", title: "Acorn checklist" }]).mockResolvedValueOnce([{ id: "canonical", authorUserId: "person", body: ctx.scenario.query }]);
    const reload = vi.fn(async () => { vi.setSystemTime(391_000); });
    ctx.input = { api: { get }, fixtures: { company: { id: "acorn" } }, page: { reload } } as never;
    await expect(definition.act!(ctx, { taskTitle: "Acorn checklist" })).rejects.toThrow(/exhausted/);
    expect(get).toHaveBeenCalledTimes(2); expect(reload).toHaveBeenCalledExactlyOnceWith({ waitUntil: "domcontentloaded", timeout: 1000 });
    expect(repeated).not.toHaveBeenCalled();
  });
  it("the existing one-run settlement gate does not waive an extra queued task run", async () => {
    vi.useFakeTimers(); vi.setSystemTime(389_000); const ctx = context(0);
    ctx.allRuns = async () => [{ status: "succeeded" }, { status: "queued" }] as never;
    const get = vi.fn(); ctx.input = { api: { get } } as never;
    const pending = definition.act!(ctx, {}).then(() => "accepted", () => "timeout");
    await vi.advanceTimersByTimeAsync(1500); expect(await pending).toBe("timeout");
    expect(get).not.toHaveBeenCalled(); expect(repeated).not.toHaveBeenCalled();
  });
  it("passes the same remaining clock to the one declared repeat", async () => {
    vi.useFakeTimers(); vi.setSystemTime(380_000); const ctx = context(0);
    const get = vi.fn().mockResolvedValueOnce([{ id: "task", title: "Acorn checklist" }]).mockResolvedValueOnce([{ id: "canonical", authorUserId: "person", body: ctx.scenario.query }]).mockResolvedValueOnce({ id: "task" });
    ctx.input = { api: { get }, fixtures: { company: { id: "acorn" } }, page: { reload: async () => {} }, evidence: async () => {} } as never;
    repeated.mockImplementation(async (_page, _query, remaining) => { expect(remaining()).toBe(10_000); vi.setSystemTime(391_000); expect(() => remaining()).toThrow(/exhausted/); });
    await expect(definition.act!(ctx, { taskTitle: "Acorn checklist", original: { id: "proposal" } })).rejects.toThrow(/exhausted/);
    expect(repeated).toHaveBeenCalledOnce(); expect(repeated.mock.calls[0]![1]).toBe(ctx.scenario.query);
  });
});
