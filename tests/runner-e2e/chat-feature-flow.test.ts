import { afterEach, expect, it, vi } from "vitest";
import * as chatFlow from "./chat-flow.js";
import type { ChatFlowInput, ChatIssue } from "./chat-flow.js";
import { runChatFeatureFlow } from "./chat-feature-flow.js";
import { chatFeatureScenarios } from "./chat-feature-cases.js";

vi.mock("./api.js", async importOriginal => ({
  ...await importOriginal<typeof import("./api.js")>(),
  pollUntil: async (input: { label: string; load(): Promise<unknown> }) => {
    const value = await input.load();
    if (input.label.startsWith("chat scenario")) throw new Error("Original scenario failure");
    return value;
  },
}));

afterEach(() => vi.restoreAllMocks());

it.each(["refresh", "save"])("keeps the last observed checks when final %s fails", async boundary => {
  vi.spyOn(chatFlow, "sendChatMessage").mockResolvedValue();
  const query = chatFeatureScenarios.find(scenario => scenario.id === "tasks.delegate-announcement")!.query;
  const source: ChatIssue = { id: "chat", companyId: "company", title: "CEO", status: "in_review",
    assigneeAgentId: "ceo", conversationState: "waiting" };
  const task = { id: "task", identifier: "EVA-2", companyId: "company", title: "Launch announcement",
    assigneeAgentId: "morgan", projectId: "launch", status: "todo", parentId: null };
  const runs = [{ id: "handoff", companyId: "company", agentId: "ceo", status: "succeeded",
    runtimeMode: "native", contextSnapshot: { issueId: "chat" } }];
  const comments = [
    { id: "human", issueId: "chat", body: query, authorUserId: "person", createdAt: "2026-10-30T10:00:00Z" },
    { id: "reply", issueId: "chat", body: "Assigned Morgan: EVA-2.", authorAgentId: "ceo", createdByRunId: "handoff", createdAt: "2026-10-30T10:00:10Z" },
  ];
  const scopes = [{ scopeType: "company", scopeId: "company" }, ...["ceo", "morgan"].map(scopeId => ({ scopeType: "agent", scopeId }))];
  const api = {
    baseURL: "http://fixture.invalid",
    get: vi.fn(async (path: string) => {
      if (path.endsWith("issues?includeAgentCreatedTasks=true")) return [];
      if (path.includes("issues?includeAgentCreatedTasks=true&limit=100")) return [task];
      if (path.endsWith("/comments?order=asc")) return comments;
      if (path.endsWith("/documents")) return [];
      if (path.endsWith("/activity")) return [{ action: "issue.created", agentId: "ceo", details: { status: "todo" } }];
      if (path.endsWith("/budgets/overview")) return { policies: scopes.map(scope => ({ ...scope,
        amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" })) };
      return { budgetMonthlyCents: 500, lifecycleState: "ready", status: "idle" };
    }),
    post: vi.fn(async (path: string) => ({ id: path.endsWith("/projects") ? "launch" : "morgan" })),
  };
  const checks: Array<{ id: string; passed: boolean }> = [];
  const evidence = vi.fn(async (name: string) => {
    if (boundary === "save" && name === "chat-feature.json") throw new Error("Final evidence write failed");
  });
  const input = {
    api, nonce: "fixture", workspacePath: "/fixture",
    page: { locator: () => ({ locator: () => ({ evaluateAll: async () => ["/EVA/issues/EVA-2"] }) }) },
    fixtures: { company: { id: "company" }, agent: { id: "ceo" }, environment: { id: "local" }, secretRefs: {} },
    execution: { environment: { id: "local" }, task: { id: "delegate-announcement", expectedRunCount: 3,
      buildVisibleMarker: () => "ACORN123", turnTimeoutMs: 120_000 },
      profile: { credential: "OPENROUTER_API_KEY", buildAgent: () => ({ adapterConfig: {} }) } },
    evidence, check: (id: string, passed: boolean) => checks.push({ id, passed }),
  } as unknown as ChatFlowInput;
  let refreshes = 0;
  await expect(runChatFeatureFlow({ input, issue: () => source, allRuns: async () => runs,
    refreshIssue: async () => {
      if (++refreshes > 1 && boundary === "refresh") throw new Error("Final observation read failed");
    },
  })).rejects.toThrow("Original scenario failure");
  expect(evidence).toHaveBeenCalledWith("chat-feature-evidence-error.json", expect.objectContaining({ incomplete: true }));
  expect(checks).toEqual(expect.arrayContaining([
    { id: "one-assigned-task", passed: true }, { id: "agent-created-task", passed: true },
    { id: "chat-task-link", passed: true }, { id: "worker-executed", passed: false },
    { id: "completion-result-access", passed: false },
  ]));
  expect(checks).toHaveLength(14);
});
