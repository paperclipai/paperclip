import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const port = vi.hoisted(() => ({ provider: null as any, advance: () => {}, replies: [] as any[] }));
vi.mock("../chat-flow.js", () => ({ sendChatMessage: async () => port.advance() }));
vi.mock("@playwright/test", () => ({ expect: (node: any) => ({ toBeVisible: async () => { if (!node.visible()) throw Error("Review is absent"); }, toContainText: async (text: string) => { if (!node.text.includes(text)) throw Error("Wrong action"); } }) }));
vi.mock("./external-provider.js", () => ({ startNotesProvider: async () => port.provider, connectNotes: async () => ({ connectionId: "connection", write: ["write"] }) }));
vi.mock("./identity-support.js", () => ({ openStandingChat: async () => ({ id: "source" }), probeAgentPermission: async () => 403, cleanupIdentityProbes: vi.fn() }));
vi.mock("../chat-query-attachments.js", () => ({ uploadFactualQueryAttachment: async () => ({ issueId: "source" }), chatQueryWithAttachments: (query: string) => query, verifyChatQueryAttachments: async () => true }));
vi.mock("./external-support.js", async original => ({ ...await original<typeof import("./external-support.js")>(), observeExternal: async () => ({ phaseReplies: port.replies, connections: [{ id: "connection", name: "Synthetic Launch Notes" }] }) }));
vi.mock("./external-app-review-probe.js", () => ({ probeReviewApproval: vi.fn(async () => ({status: 403, code: "interaction_governed_action_denied", boundaryUnchanged: true, keyRevoked: true})) }));
import { appReviewExternalCases } from "./external-app-review.js";
afterEach(() => vi.restoreAllMocks());
function fixture(wrongDispatch = false) {
  let index = 0, opened = false, inspected = false, written: string | undefined;
  let runtimeConfig = { retained: true, heartbeat: { enabled: false, maxDailyRuns: 3, maxConcurrentRuns: 1, maxDailyCostCents: 500 } };
  const resolved = new Set<number>(), calls: any[] = [];
  const text = "Owned launch destination. ".repeat(7) + "The public launch is November 8, 2030.";
  const summary = JSON.stringify({ text }), hash = createHash("sha256").update(summary).digest("hex");
  const scope = "This agent may use this action with different arguments on this connection within this project.";
  port.replies = [];
  const kinds = ["rejected", "failed", "executed"];
  const action = () => ({ connectionId: "connection", actionRequestId: `action${index}`, invocationId: `inv${index}`, toolName: "launch_update", toolDisplayName: "Update launch page", appDisplayName: "Synthetic Launch Notes", risk: "write", rememberActionScope: scope, previewMarkdown: "Short launch preview…", argumentsSummaryJson: summary, argumentsHash: hash });
  const cards = () => Array.from({ length: index + 1 }, (_, n) => ({ id: `card${n}`, kind: "request_confirmation", status: !resolved.has(n) ? "pending" : n === 0 ? "rejected" : "accepted", sourceRunId: `ask${n}`, resolvedByUserId: resolved.has(n) ? "person" : null,
    payload: { toolAction: { ...action(), actionRequestId: `action${n}`, invocationId: `inv${n}` } } }));
  const runs = () => Array.from({ length: index + 1 }, (_, n) => [{ id: `ask${n}`, status: "succeeded", contextSnapshot: { issueId: "source" } }, ...(resolved.has(n) ? [{ id: `reply${n}`, status: "succeeded", contextSnapshot: { issueId: "source", source: "tool_action_review", toolActionRequestIds: [`action${n}`] } }] : [])]).flat();
  const decide = () => {
    if (!opened || !inspected) throw Error("Human cannot decide before inspecting the bound full proposal");
    if (index > 0) { const sent = wrongDispatch ? text + " Unreviewed addition." : text; calls.push({ method: "tools/call", name: "launch_update", authorized: true, arguments: { text: sent } }); if (index === 2) written = sent; }
    resolved.add(index); port.replies.push({ runId: `reply${index}`, body: ["You declined; no update was sent to Synthetic Launch Notes.", "Synthetic Launch Notes failed; no change was applied.", "The launch update was applied in Synthetic Launch Notes."][index] });
  };
  port.provider = { calls, failWrites: vi.fn(), allowWrites: vi.fn(), close: vi.fn(async () => {}), written: () => written };
  port.advance = () => { index++; opened = false; inspected = false; };
  const details = { visible: () => opened, filter() { return this; }, locator: (kind: string) => kind === "summary" ? { click: async () => { inspected = true; } } : kind === "pre" ? { visible: () => inspected, textContent: async () => summary } : { textContent: async () => hash },
    getByRole: () => ({ click: async () => {} }), getByLabel: () => ({ visible: () => inspected, textContent: async () => hash }) };
  const view = { visible: () => opened, text: "Update launch page", locator: () => details, getByRole: (role: string, options: { name: string }) => role === "img" ? { visible: () => opened } : { click: async () => { if (options.name !== "Approval options") decide(); } } };
  const get = vi.fn(async (path: string) => {
    if (path === "/api/agents/ceo") return { runtimeConfig };
    if (path === "/api/auth/get-session") return { user: { id: "person" } };
    if (path.endsWith("/tools/trust-rules")) return { trustRules: [] };
    if (path.endsWith("/interactions")) return cards();
    if (path.includes("/decisions")) {
      const n = Number(path.match(/ask(\d+)/)![1]);
      return { runId: `ask${n}`, decisions: [{ invocation: { id: `inv${n}`, companyId: "company", agentId: "ceo", issueId: "source", runId: `ask${n}`, connectionId: "connection", catalogEntryId: "write", argumentsHash: hash, status: resolved.has(n) ? ["denied", "failed", "succeeded"][n] : "awaiting_approval" }, actionRequest: { id: `action${n}`, canonicalArgumentsHash: hash, status: resolved.has(n) ? kinds[n] : "pending" } }] };
    }
    throw Error("Unexpected fixture API");
  });
  const ctx = { scenario: { query: "Add this launch update to our notes app." }, input: { fixtures: { company: { id: "company" }, agent: { id: "ceo" } }, evidence: vi.fn(async () => {}), api: { get, post: async () => ({ id: "project" }), patch: async (path: string, body: { runtimeConfig: typeof runtimeConfig }) => { if (path === "/api/agents/ceo") runtimeConfig = body.runtimeConfig; return {}; } },
    page: { evaluate: async () => {}, locator: () => ({ visible: () => true, getByRole: () => ({ click: async () => { opened = true; } }) }), getByTestId: () => view,
      getByRole: () => ({ getAttribute: async () => scope, click: async () => decide() }) } },
    refreshIssue: async () => {}, issue: () => ({ id: "source", conversationState: "waiting" }), allRuns: async () => runs() } as unknown as ChatCatalogContext;
  return { ctx, text, calls, runtimeConfig: () => runtimeConfig };
}
it("actual three-phase caller dispatches exactly the immutable text inspected in each approved review", async () => {
  const f = fixture(), definition = appReviewExternalCases[0]!, state = await definition.setup(f.ctx);
  expect(f.runtimeConfig()).toEqual({ retained: true, heartbeat: { enabled: false, maxDailyRuns: 6, maxConcurrentRuns: 1, maxDailyCostCents: 500 } });
  await definition.act!(f.ctx, state);
  expect((state.phases as any[]).map(p => [p.kind, p.beforeWrites, p.afterWrites, p.proposalVisible])).toEqual([["rejected", 0, 0, true], ["failed", 0, 1, true], ["executed", 1, 2, true]]);
  expect((state.phases as any[]).slice(1).every(p => p.providerWriteText === f.text && p.reviewedText === f.text && p.providerAuthorized)).toBe(true);
  expect(f.calls).toHaveLength(2);
  expect(state.agentApproveStatus).toBe(403);
});
it("actual caller rejects a provider body changed after valid inspection and approval", async () => {
  const f = fixture(true), definition = appReviewExternalCases[0]!, state = await definition.setup(f.ctx);
  await expect(definition.act!(f.ctx, state)).rejects.toThrow("provider dispatch differs");
  expect(f.calls).toHaveLength(1);
  expect((state.phases as any[]).map(p => p.kind)).toEqual(["rejected"]);
});
