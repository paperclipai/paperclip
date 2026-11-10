import { afterEach, describe, expect, it, vi } from "vitest";
const visibility = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@playwright/test", async importOriginal => ({ ...await importOriginal<object>(), expect: () => ({ toBeVisible: visibility }) }));
import { sendChatMessage } from "./chat-flow.js";
import { submitTaskReply } from "./user-actions.js";
import { verifyInternalResult } from "./chat-catalog-domains/internal-support.js";
const remaining = () => { const value = 390_000 - Date.now(); if (value <= 0) throw new Error("original budget exhausted"); return value; };
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe("optional original-clock callbacks reach the real shared UI helpers", () => {
  it("task continuation cannot send after slow composer work exhausts the original clock", async () => {
    vi.useFakeTimers(); vi.setSystemTime(389_000);
    const fill = vi.fn(async () => { vi.setSystemTime(391_000); }); const click = vi.fn();
    const node: any = { last: () => node, first: () => node, locator: () => node, fill, click };
    await expect(submitTaskReply({ getByTestId: () => node } as never, "Continue the same task.", remaining)).rejects.toThrow(/exhausted/);
    expect(fill).toHaveBeenCalledExactlyOnceWith("Continue the same task.", { timeout: 1000 }); expect(click).not.toHaveBeenCalled();
  });
  it.each([0, -1, NaN, Infinity])("task continuation rejects invalid remaining budget %s before UI work", async budget => {
    const node: any = { last: () => node }; const prior = visibility.mock.calls.length;
    await expect(submitTaskReply({ getByTestId: () => node } as never, "Continue.", () => budget)).rejects.toThrow(/exhausted/);
    expect(visibility.mock.calls.length).toBe(prior);
  });
  it("ordinary task reply callers retain existing UI defaults", async () => {
    const fill = vi.fn(); const click = vi.fn(); const node: any = { last: () => node, first: () => node, locator: () => node, fill, click };
    await submitTaskReply({ getByTestId: () => node } as never, "Continue.");
    expect(visibility).toHaveBeenCalledWith({ timeout: 30_000 }); expect(fill).toHaveBeenCalledExactlyOnceWith("Continue."); expect(click).toHaveBeenCalledExactlyOnceWith();
  });
  it("slow composer work cannot send a human message after the original deadline", async () => {
    vi.useFakeTimers(); vi.setSystemTime(389_000);
    const fill = vi.fn(async () => { vi.setSystemTime(391_000); }); const click = vi.fn();
    const node: any = { last: () => node, first: () => node, or: () => node, locator: () => node, isVisible: async () => false, fill, click };
    await expect(sendChatMessage({ getByTestId: () => node } as never, "Yes, go ahead with that.", remaining)).rejects.toThrow(/exhausted/);
    expect(fill).toHaveBeenCalledExactlyOnceWith("Yes, go ahead with that.", { timeout: 1000 });
    expect(click).not.toHaveBeenCalled();
  });
  it("unchanged chat callers keep default UI timeouts", async () => {
    const fill = vi.fn(); const click = vi.fn();
    const node: any = { last: () => node, first: () => node, or: () => node, locator: () => node, isVisible: async () => false, fill, click };
    await sendChatMessage({ getByTestId: () => node } as never, "Hello");
    expect(fill).toHaveBeenCalledExactlyOnceWith("Hello", {}); expect(click).toHaveBeenCalledExactlyOnceWith({});
  });
  it("slow result-link click cannot obtain a fresh verification/navigation budget", async () => {
    vi.useFakeTimers(); vi.setSystemTime(389_000);
    const click = vi.fn(async () => { vi.setSystemTime(391_000); }); const waitForURL = vi.fn();
    const node: any = { first: () => node, filter: () => node, locator: () => node, click };
    const ctx = { input: { page: { url: () => "https://fixture.test/RUN/chats/ceo", locator: () => node, getByTestId: () => node, waitForURL } } };
    const observation = { scenarioId: "questions-and-approvals.accept-one-proposal", origin: "https://fixture.test", companyId: "company", leadId: "lead", state: {}, renderedLinkEvidence: [{ href: "/RUN/issues/task", threadTestId: "task-chat-thread", source: "reply", conversationId: "chat", anchorCommentId: "reply", commentId: "reply" }], reply: "Created", links: ["/RUN/issues/task"], tasks: [{ id: "task", title: "Checklist" }], projects: [], goals: [], comments: [], activity: [], documents: [], revisions: [], runs: [], humanQueries: [] };
    await expect(verifyInternalResult(ctx as never, {}, observation, remaining)).rejects.toThrow(/exhausted/);
    expect(click).toHaveBeenCalledExactlyOnceWith({ timeout: 1000 }); expect(waitForURL).not.toHaveBeenCalled();
  });
});
