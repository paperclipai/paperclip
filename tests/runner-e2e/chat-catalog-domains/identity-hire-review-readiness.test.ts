import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const clock = vi.hoisted(() => ({ now: 30_000, deadlines: [] as number[] }));
const observations = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./identity-support.js", async importOriginal => ({ ...await importOriginal<typeof import("./identity-support.js")>(), observeIdentity: observations.read }));
vi.mock("../codex-subscription-fixture.js", () => ({ codexSubscriptionAgentConfig: (value: unknown) => value }));
vi.mock("@playwright/test", () => ({ expect: (node: { visible?: () => boolean; text?: () => string }) => ({
  toBeVisible: async () => { if (!node.visible?.()) throw Error("Actual pending proposal is not visible"); },
  toContainText: async (text: string) => { if (!node.text?.().includes(text)) throw Error("Actual revised model is missing"); },
}) }));
vi.mock("../api.js", () => ({ pollUntil: async (options: { deadlineAt: number; load(): Promise<unknown>; accept(value: unknown): boolean; reject?(value: unknown): string | undefined }) => {
  clock.deadlines.push(options.deadlineAt);
  while (Date.now() < options.deadlineAt) {
    const value = await options.load(), rejected = options.reject?.(value);
    if (rejected) throw Error(rejected);
    if (options.accept(value)) return value;
    clock.now += 10_000;
  }
  throw Error("Controlled original observation expired");
} }));
import { hireRevisionIdentityCases } from "./identity-hire-revision.js";
afterEach(() => { vi.restoreAllMocks(); observations.read.mockReset(); document.body.replaceChildren(); });
type Options = { deadline?: number | "missing"; readyAt?: number; href?: string; wrongComment?: boolean; foreignSource?: boolean; wrongActor?: boolean; wrongNativeComment?: boolean; wrongModel?: boolean; notPending?: boolean; lateDom?: boolean; progress?: boolean; genericReply?: boolean };
function fixture(options: Options = {}) {
  clock.now = 30_000; clock.deadlines.splice(0); vi.spyOn(Date, "now").mockImplementation(() => clock.now);
  vi.spyOn(Element.prototype, "getClientRects").mockImplementation(() => [{ width: 10, height: 10 }] as unknown as DOMRectList);
  let current = "https://fixture.test/ACORN/chats/ceo", clicks = 0;
  const source = "source", approval = "approval", query = "Switch this hiring proposal to a cheaper model and send it back for approval.";
  const readyAt = options.readyAt ?? 210_000, href = options.href ?? "/approvals/approval";
  const run = { id: "native", companyId: "company", agentId: options.wrongActor ? "other" : "ceo", runtimeMode: "native", status: "succeeded", contextSnapshot: { issueId: source, commentId: options.wrongNativeComment ? "other" : "human" } };
  const comments = [{ id: "human", companyId: "company", issueId: source, authorUserId: "person", body: query },
    ...(options.progress ? [{ id: "progress", companyId: "company", issueId: source, authorAgentId: "ceo", createdByRunId: "native", body: "I am checking this proposal before revising it." }] : []),
    { id: "reply", companyId: "company", issueId: source, authorAgentId: "ceo", createdByRunId: "native", body: options.genericReply ? "Revised and resubmitted for approval." : "Revised to requested-model, pending proposal." }];
  function sync() {
    document.body.innerHTML = '<section data-testid="task-chat-thread"><div id="comment-human"></div>' + (options.progress ? '<div id="comment-progress"></div>' : '') + '<div id="comment-' + (options.wrongComment ? "foreign" : "reply") + '"></div></section>';
    if (clock.now >= readyAt) { const a = document.createElement("a"); a.setAttribute("href", href); a.textContent = "pending approval"; document.querySelector('div:last-child')!.append(a); if (options.progress) document.getElementById("comment-progress")!.append(a.cloneNode(true)); }
  }
  type Nodes = { nodes: Element[]; locator(selector: string): Nodes; first(): Nodes; filter(options: { has: Nodes }): Nodes; evaluateAll<T>(read: (nodes: Element[]) => T): Promise<T>; click(): Promise<void>; text(): string };
  function nodes(list: Element[]): Nodes { return { nodes: list, locator: selector => nodes(list.flatMap(n => Array.from(n.querySelectorAll(selector)))), first: () => nodes(list.slice(0,1)),
    filter: ({has}) => nodes(list.filter(n => has.nodes.some(child => n.contains(child)))),
    evaluateAll: async read => read(list), click: async () => { const a = list[0]; if (!a || !a.hasAttribute("href")) throw Error("Real review link absent"); clicks++; current = new URL(a.getAttribute("href")!, current).href; },
    text: () => options.wrongModel ? "wrong-model" : "requested-model" }; }
  const page = { url: () => current, goto: async (url: string) => { current = new URL(url,current).href; },
    locator: (selector: string) => { if (selector === "pre") return nodes([]); if (selector.includes("[id^=")) sync(); return nodes(Array.from(document.querySelectorAll(selector))); },
    getByTestId: (id: string) => nodes(Array.from(document.querySelectorAll('[data-testid="'+id+'"]'))),
    getByText: () => ({ first: () => ({ visible: () => !options.notPending && current.endsWith("/approvals/approval") }) }),
    getByRole: () => ({ click: async () => {} }),
    evaluate: async <T, A>(read: (value: A) => T, value: A) => { if (options.lateDom) clock.now = 300_001; sync(); return read(value); },
  };
  const deadline = options.deadline === undefined ? 300_000 : options.deadline;
  const ctx = { ...(deadline === "missing" ? {} : { observationDeadlineAt: deadline }), scenario: { query },
    input: { page, fixtures: { company: { id: "company", issuePrefix: "ACORN" }, agent: { id: "ceo" } }, api: { baseURL: "https://fixture.test", get: async (url: string) => {
      if (url === "/api/issues/source/comments?order=asc") return comments;
      if (url === "/api/approvals/approval") return { id: approval, companyId: "company", status: options.notPending ? "approved" : "pending" };
      throw Error("Unexpected read");
    } } }, issue: () => ({ id: options.foreignSource ? "foreign" : source, conversationState: "waiting" }), refreshIssue: async () => {}, allRuns: async () => [run],
  } as unknown as ChatCatalogContext;
  return { ctx, state: { originalApproval: { id: approval, companyId: "company" }, humanId: "person", sourceIssueId: source, cheaperModel: "requested-model" }, clicks: () => clicks, url: () => current };
}
it("awaits the delayed genuine canonical-reply review link within original300s, clicks and inspects actual pending revised model", async () => {
  const f = fixture(); await hireRevisionIdentityCases[0]!.act!(f.ctx, f.state);
  expect(f.clicks()).toBe(1); expect(clock.now).toBe(210_000); expect(clock.deadlines.every(x => x === 300_000)).toBe(true);
  expect(f.state).toMatchObject({ pendingProposalVisible: true, revisedModelVisible: true,
    revisionHistoryComment: { id: "reply", authorAgentId: "ceo", createdByRunId: "native" },
    revisionHistoryLink: { source: "reply", conversationId: "source", commentId: "reply", href: "/approvals/approval" } }); expect(f.url()).toContain("/chats/ceo");
});
it.each([{ href: "https://foreign.test/approvals/approval" }, { href: "/OTHER/approvals/approval" }, { href: "/approvals/other" }, { wrongComment: true }, { foreignSource: true }, { wrongActor: true }, { wrongNativeComment: true }, { readyAt: 300_001 }, { lateDom: true }, { deadline: "missing" }, { deadline: NaN }, { deadline: 29_999 }])("rejects absent/foreign/late review readiness before any click %j", async options => {
  const f = fixture(options as Options); await expect(hireRevisionIdentityCases[0]!.act!(f.ctx, f.state)).rejects.toThrow(); expect(f.clicks()).toBe(0);
});
it("accepts the same owned company-prefixed ordinary approval route", async () => {
  const f = fixture({ readyAt:30_000, href:"/ACORN/approvals/approval" }); await hireRevisionIdentityCases[0]!.act!(f.ctx,f.state); expect(f.clicks()).toBe(1);
});
it.each([{ wrongModel: true }, { notPending: true }])("does not turn review visibility into a wrong model/approved proposal PASS %j", async options => {
  const f = fixture({ readyAt:30_000, ...options }); await expect(hireRevisionIdentityCases[0]!.act!(f.ctx,f.state)).rejects.toThrow();
});

it("captures the model-specific bound revision note when progress also renders the same proposal link", async () => {
  const f = fixture({ readyAt: 30_000, progress: true });
  await hireRevisionIdentityCases[0]!.act!(f.ctx, f.state);
  expect(f.state).toMatchObject({ revisionHistoryComment: { id: "reply", body: "Revised to requested-model, pending proposal." },
    revisionHistoryLink: { commentId: "reply", href: "/approvals/approval" } });
});

it("rereads the actual source comment independently of the captured history receipt", async () => {
  const captured = { id: "reply", issueId: "source", companyId: "company", createdByRunId: "native", authorAgentId: "ceo", body: "Revised model, pending approval." };
  const observed = structuredClone(captured), child = { id: "child-comment", issueId: "child", body: "Child history." };
  const state = { sourceIssueId: "source", originalApproval: { id: "approval", payload: { adapterConfig: { model: "old" } } }, revisionHistoryComment: captured };
  observations.read.mockResolvedValue({ comments: [child], state });
  const get = vi.fn(async (url: string) => {
    if (url === "/api/approvals/approval") return { id: "approval", payload: { adapterConfig: { model: "new" } } };
    if (url === "/api/approvals/approval/comments") return [];
    if (url === "/api/issues/source/comments?order=asc") return [observed];
    throw Error("Unexpected observation read");
  });
  const ctx = { input: { api: { get } } } as unknown as ChatCatalogContext;
  const result = await hireRevisionIdentityCases[0]!.observe!(ctx, state) as { comments: typeof captured[] };
  expect(get).toHaveBeenCalledWith("/api/issues/source/comments?order=asc");
  expect(result.comments).toEqual([child, captured]);
  expect(result.comments[1]).not.toBe(captured);
  observed.body = "Changed independent observation";
  expect(captured.body).toBe("Revised model, pending approval.");
});

it("navigates a generic owned approval link without requiring the chat message to repeat the model", async () => {
  const f = fixture({ readyAt: 30_000, genericReply: true });
  await hireRevisionIdentityCases[0]!.act!(f.ctx, f.state);
  expect(f.clicks()).toBe(1);
  expect(f.state).toMatchObject({ pendingProposalVisible: true, revisedModelVisible: true,
    revisionHistoryComment: { id: "reply", body: "Revised and resubmitted for approval." } });
});
