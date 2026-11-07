import { afterEach, expect, it, vi } from "vitest";
import * as chatFlow from "./chat-flow.js";
import type { ChatFlowInput, ChatIssue, ChatRun } from "./chat-flow.js";
import { runChatFeatureFlow } from "./chat-feature-flow.js";
import { chatFeatureScenarios } from "./chat-feature-cases.js";

const polling = vi.hoisted(() => ({ failScenario: true }));
vi.mock("@playwright/test", async importOriginal => ({
  ...await importOriginal<typeof import("@playwright/test")>(),
  expect: (actual: { isVisible?(): Promise<boolean> }, message?: string) => Object.assign(expect(actual, message), {
    toBeVisible: async () => expect(await actual.isVisible!()).toBe(true),
  }),
}));
vi.mock("./api.js", async importOriginal => ({
  ...await importOriginal<typeof import("./api.js")>(),
  pollUntil: async (input: { label: string; load(): Promise<unknown>; accept?(value: unknown): boolean; reject?(value: unknown): string | undefined }) => {
    const value = await input.load();
    if (input.accept?.(value)) return value;
    const rejection = input.reject?.(value);
    if (rejection) throw new Error(rejection);
    if (polling.failScenario && input.label.startsWith("chat scenario")) throw new Error("Original scenario failure");
    return value;
  },
}));

afterEach(() => { vi.restoreAllMocks(); polling.failScenario = true; });

function fixture(boundary?: string) {
  vi.spyOn(chatFlow, "sendChatMessage").mockResolvedValue();
  const caseId = boundary ? "delegate-announcement" : "create-backlog";
  const query = chatFeatureScenarios.find(scenario => scenario.id === `tasks.${caseId}`)!.query;
  const source: ChatIssue = { id: "chat", companyId: "company", title: "CEO", status: "in_review",
    assigneeAgentId: "ceo", conversationState: "waiting" };
  const task = { id: "task", identifier: "EVA-2", companyId: "company", title: "Launch announcement",
    assigneeAgentId: "morgan", projectId: "launch", status: boundary ? "todo" : "backlog", parentId: null };
  const runs = [{ id: "handoff", companyId: "company", agentId: "ceo", status: "succeeded",
    runtimeMode: "native", contextSnapshot: { issueId: "chat" } }];
  const comments = [
    { id: "human", issueId: "chat", body: query, authorUserId: "person", createdAt: "2026-10-30T10:00:00Z" },
    { id: "reply", issueId: "chat", body: "Assigned Morgan: EVA-2, saved in backlog.", authorAgentId: "ceo", createdByRunId: "handoff", createdAt: "2026-10-30T10:00:10Z" },
  ];
  const scopes = [{ scopeType: "company", scopeId: "company" }, ...["ceo", "morgan"].map(scopeId => ({ scopeType: "agent", scopeId }))];
  const api = {
    baseURL: "http://fixture.invalid",
    get: vi.fn(async (path: string) => {
      if (path.endsWith("issues?includeAgentCreatedTasks=true")) return [];
      if (path.includes("issues?includeAgentCreatedTasks=true&limit=100")) return [task];
      if (path.endsWith("/comments?order=asc")) return comments;
      if (path.endsWith("/documents")) return [];
      if (path.endsWith("/activity")) return [{ action: "issue.created", agentId: "ceo", details: { status: task.status } }];
      if (path === "/api/issues/EVA-2") return task;
      if (path.includes("/events?")) return [];
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
  const locator = {
    isVisible: async () => true,
    locator: () => locator, getByRole: () => locator, nth: () => locator, click: vi.fn(),
    evaluateAll: async (_callback: unknown, target?: unknown) => target ? 0 : ["/EVA/issues/EVA-2"],
  };
  const capture = vi.fn();
  const input = {
    api, nonce: "fixture", workspacePath: "/fixture",
    page: { locator: () => locator, getByTestId: () => locator, reload: vi.fn(), goto: vi.fn(), url: () => "http://fixture.invalid/chat" },
    fixtures: { company: { id: "company" }, agent: { id: "ceo" }, environment: { id: "local" }, secretRefs: {} },
    execution: { environment: { id: "local" }, task: { id: caseId, expectedRunCount: boundary ? 3 : 1,
      buildVisibleMarker: () => "ACORN123", turnTimeoutMs: 120_000 },
      profile: { credential: "OPENROUTER_API_KEY", buildAgent: () => ({ adapterConfig: {} }) } },
    evidence, capture, check: (id: string, passed: boolean) => checks.push({ id, passed }),
  } as unknown as ChatFlowInput;
  let refreshes = 0;
  const context: Parameters<typeof runChatFeatureFlow>[0] = { input, issue: () => source, allRuns: async () => runs,
    refreshIssue: async () => {
      if (++refreshes > 1 && boundary === "refresh") throw new Error("Final observation read failed");
    },
  };
  return { context, checks, evidence, capture };
}

function oldAssignment(startedAt: string | null = null): ChatRun {
  return { id: "old-assignment", companyId: "company", agentId: "ceo", status: "cancelled", runtimeMode: "legacy",
    startedAt, nativeIssueId: null, errorCode: "issue_assignee_changed", contextSnapshot: { issueId: "task" },
    resultJson: { stopReason: "issue_assignee_changed", timeoutSource: "stale_queued_run_gate", timeoutFired: false } };
}

it.each(["refresh", "save"])("keeps the last observed checks when final %s fails", async boundary => {
  const { context, checks, evidence } = fixture(boundary);
  await expect(runChatFeatureFlow(context)).rejects.toThrow("Original scenario failure");
  expect(evidence).toHaveBeenCalledWith("chat-feature-evidence-error.json", expect.objectContaining({ incomplete: true }));
  expect(checks).toEqual(expect.arrayContaining([
    { id: "one-assigned-task", passed: true }, { id: "agent-created-task", passed: true },
    { id: "chat-task-link", passed: true }, { id: "worker-executed", passed: false },
    { id: "completion-result-access", passed: false },
  ]));
  expect(checks).toHaveLength(14);
});

it.each([1, 3])("continues observation past a superseded wake with %s actual work runs", async count => {
  const { context, evidence } = fixture("superseded");
  const runs: ChatRun[] = await context.allRuns();
  if (count === 3) runs.push(
    { id: "writing", companyId: "company", agentId: "morgan", status: "queued", runtimeMode: "native", contextSnapshot: { issueId: "task" } },
    { id: "delivery", companyId: "company", agentId: "ceo", status: "queued", runtimeMode: "native", contextSnapshot: { issueId: "chat" } },
  );
  runs.push(oldAssignment());
  context.allRuns = async () => runs;
  await expect(runChatFeatureFlow(context)).rejects.toThrow("Original scenario failure");
  expect(evidence).toHaveBeenCalledWith("chat-feature.json", expect.objectContaining({
    observation: expect.objectContaining({ runs }), grade: expect.objectContaining({ passed: false }),
  }));
});

it("still rejects a cancelled assignment that actually started", async () => {
  const { context } = fixture("started");
  const runs = [...await context.allRuns(), oldAssignment("2026-10-30T10:00:01Z")];
  context.allRuns = async () => runs;
  await expect(runChatFeatureFlow(context)).rejects.toThrow("An observed provider run failed");
});

it("retains required final evidence after the feature flow verifies browser readback", async () => {
  polling.failScenario = false;
  const { context, checks, evidence, capture } = fixture();
  await expect(runChatFeatureFlow(context)).resolves.toMatchObject({ issue: { id: "chat" }, runs: [{ id: "handoff" }] });
  expect(checks.every(check => check.passed)).toBe(true);
  expect(checks).toContainEqual({ id: "browser-result-access", passed: true });
  expect(capture).toHaveBeenCalledWith("final-state", expect.any(String), "final-state.png");
  expect(evidence).toHaveBeenCalledWith("api-state.json", expect.objectContaining({ issue: expect.objectContaining({ id: "chat" }) }));
});
