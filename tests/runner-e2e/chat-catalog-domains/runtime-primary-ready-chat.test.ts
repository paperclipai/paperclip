import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
vi.mock("@playwright/test", () => ({ expect: (target: any) => ({
  toBeVisible: async () => { if (!await target.visible()) throw Error("Actual Chat is still loading or its conversation is absent"); },
  toBeEditable: async () => { if (!target.editable()) throw Error("Chat composer is not ready"); },
  toHaveURL: async (matches: (url: URL) => boolean) => { if (!matches(new URL(target.url()))) throw Error("Wrong selected Chat route"); },
}) }));
import { runtimePrimaryCases } from "./runtime-primary.js";
afterEach(() => { vi.restoreAllMocks(); });
function fixture(options: { loadingForever?: boolean; extraRun?: boolean; extraChat?: boolean; wrongPrimary?: boolean; wrongPerson?: boolean;
  wrongChat?: boolean; noReply?: boolean; wrongRequest?: boolean; missingRenderedReply?: boolean; readOnly?: boolean; expired?: boolean; lateReady?: boolean } = {}) {
  const deadline = Date.now() + (options.expired ? -1 : 30_000); let current = "https://fixture.test/RUN/chats/ceo", ready = false;
  const calls: string[] = [];
  const source = { id: "source", companyId: "company", conversationAgentId: "ceo", conversationUserId: "person" };
  const comments = [{ id: "human", authorUserId: "person", body: "Make Morgan my go-to agent." },
    ...(options.noReply ? [] : [{ id: "reply", authorAgentId: "ceo", createdByRunId: "native", body: "Use the human primary control." }])];
  const primary = { companyId: "company", userId: options.wrongPerson ? "foreign" : "person", primaryAgentId: options.wrongPrimary ? "ceo" : "morgan" };
  const locator = (kind: string) => ({ first() { return this; }, locator: () => locator("editor"),
    visible: async () => {
      calls.push(kind);
      if (kind === "composer") {
        if (options.loadingForever) return false; ready = true;
        if (options.lateReady) vi.spyOn(Date, "now").mockReturnValue(deadline + 1);
      }
      return kind === "heading" || ready && !(kind.includes("comment-reply") && options.missingRenderedReply);
    }, editable: () => ready && !options.readOnly });
  const page = { url: () => current, goto: async (url: string) => { current = new URL(url, "https://fixture.test").href; ready = false; },
    reload: async () => {}, getByRole: () => locator("heading"), getByTestId: () => locator("composer"), locator };
  const api = { baseURL: "https://fixture.test", get: async (path: string) => {
    calls.push(path); if (path.endsWith("/primary-agent/me")) return primary;
    if (path.endsWith("/chats/ceo")) return { ...source, ...(options.wrongChat ? { id: "different-source" } : {}) };
    if (path.includes("/comments?")) return comments.map(row => options.wrongRequest && row.id === "human" ? { ...row, body: "different query" } : row);
    if (path.endsWith("/chats")) return [source, ...(options.extraChat && ready ? [{ ...source, id: "extra" }] : [])];
    throw Error("Unexpected API read");
  } };
  const state = { worker: { id: "morgan", name: "Morgan", companyId: "company" }, primaryBefore: { companyId: "company", userId: "person", primaryAgentId: "ceo" },
    sourceBeforeNavigation: "source", nativeIdsBeforeNavigation: ["native"], chatCountBeforeNavigation: 1 };
  const evidence = vi.fn(async (_name: string, _value: unknown) => {});
  const ctx = { observationDeadlineAt: deadline, scenario: { id: "agents.choose-primary", query: "Make Morgan my go-to agent." },
    input: { api, page, evidence, fixtures: { company: { id: "company", issuePrefix: "RUN" }, agent: { id: "ceo" } } },
    issue: () => source, refreshIssue: async () => {}, allRuns: async () => [{ id: "native", agentId: "ceo", status: "succeeded" }, ...(options.extraRun && ready ? [{ id: "unexpected", agentId: "ceo", status: "running" }] : [])],
  } as unknown as ChatCatalogContext;
  const observation = { companyId: "company", leadId: "ceo", state, reply: "Use the human primary control.", agents: [{ id: "ceo", name: "CEO" }, state.worker], tasks: [], links: [], activity: [], runs: [], humanQueries: [] };
  return { ctx, state, observation, evidence, calls, ready: () => ready };
}
it("actual final verifier waits for meaningful selected Chat then rechecks preference and no extra work before capture", async () => {
  const f = fixture(); await runtimePrimaryCases[0]!.verifyResult(f.ctx, f.state, f.observation);
  expect(f.ready()).toBe(true); expect(f.evidence).toHaveBeenCalledWith("chat-primary-ready-conversation.json", expect.objectContaining({ sourceId: "source", agentId: "ceo", primaryAgentId: "morgan", noExtraWork: true }));
  expect(f.calls).toContain('[id="comment-human"]'); expect(f.calls).toContain('[id="comment-reply"]');
});
it.each([{ loadingForever: true }, { extraRun: true }, { extraChat: true }, { wrongPrimary: true }, { wrongPerson: true }, { wrongChat: true },
  { noReply: true }, { wrongRequest: true }, { missingRenderedReply: true }, { readOnly: true }, { expired: true }, { lateReady: true }])("actual final verifier rejects incomplete or changed settled state %j", async options => {
  const f = fixture(options); await expect(runtimePrimaryCases[0]!.verifyResult(f.ctx, f.state, f.observation)).rejects.toThrow();
  expect(f.evidence.mock.calls.some(row => row[0] === "chat-primary-ready-conversation.json")).toBe(false);
});
