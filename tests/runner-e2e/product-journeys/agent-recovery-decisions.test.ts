import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runAgentJourney } from "./agent-flows.js";
import { runnerTasks } from "../catalog.js";
import { createTaskThroughUi } from "../user-actions.js";
import { decideProtectedActionThroughUi } from "../protected-action-flow.js";
import type { JourneyContext, JourneyEvidence, TargetSession } from "./types.js";

vi.mock("../user-actions.js", async importOriginal => ({ ...await importOriginal<typeof import("../user-actions.js")>(), createTaskThroughUi: vi.fn() }));
vi.mock("../protected-action-flow.js", async importOriginal => ({ ...await importOriginal<typeof import("../protected-action-flow.js")>(), decideProtectedActionThroughUi: vi.fn() }));
vi.mock("@playwright/test", () => ({ expect: () => ({ toBeVisible: async () => {}, toHaveAttribute: async () => {} }) }));
type Row = Record<string, any>;
const directories: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

async function fixture(journey: "plan-revise-accept" | "protected-actions", neverRecovers = false) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "agent-recovery-decision-")); directories.push(directory);
  const campaign = "journey-fixture", deadlineAt = Date.now() + (neverRecovers ? 1_500 : 15_000);
  const markers = runnerTasks.find(row => row.id === "plan-revise-accept")!.buildPlanMarkers!(campaign.replaceAll("-", "_"));
  const now = Date.now();
  let stage = 1, rejects = 0;
  const reads = new Map<number, number>(), decisions: number[] = [];
  const stop = new Error("stop-after-proven-decision");
  const issue = { id: "task", identifier: "QA-1", companyId: "company", assigneeAgentId: "agent", status: "in_progress" };
  const recovering = () => neverRecovers || (reads.get(stage) ?? 0) < 3;
  const pending = () => ({ id: `card-${stage}`, status: "pending", kind: "request_confirmation",
    payload: { target: { type: "issue_document", key: "plan", revisionId: `revision-${stage}` } } });
  const run = (n: number) => ({ id: `run-${n}`, issueId: "task", nativeIssueId: "task", companyId: "company", agentId: "agent",
    runtimeMode: "native", status: n === stage && recovering() ? "failed" : "succeeded",
    nativePhase: n === stage && recovering() ? "retryable_failure" : "committed", errorCode: "native_session_interrupted",
    finishedAt: new Date(now - 1_000).toISOString(), contextSnapshot: { issueId: "task", paperclipEnvironment: { id: "environment" } },
    runnerProfileJson: { nativeExecutionInput: { provider: { kind: "opencode", model: "model" } } },
    execution: { phase: "retry_scheduled", cause: "native_session_interrupted", attempt: 1, maxAttempts: 3,
      recoveryOwner: "agent", retryAt: new Date(now + 1_000).toISOString() } });
  const api = { origin: "https://qa.example.test", get: vi.fn(async (route: string) => {
    if (route === "/api/issues/task") return { ...issue };
    if (route === "/api/issues/task/runs") return Array.from({ length: stage }, (_, i) => ({ runId: `run-${i + 1}` }));
    const match = /^\/api\/heartbeat-runs\/run-(\d+)$/.exec(route);
    if (match) {
      const n = Number(match[1]);
      if (n === stage) reads.set(stage, (reads.get(stage) ?? 0) + 1);
      return run(n);
    }
    if (route === "/api/issues/task/interactions") return [pending()];
    if (route === "/api/issues/task/comments?order=asc" || route === "/api/issues/task/attachments") return [];
    if (route === "/api/tool-connections/service") return { id: "service", enabled: true };
    if (route === "/api/issues/task/documents/plan") {
      expect(recovering(), "must not read the decision's Plan while its producing turn recovers").toBe(false);
      return { id: "plan", key: "plan", latestRevisionId: `revision-${stage}`, latestRevisionNumber: stage,
        body: stage === 1 ? `1. ${markers.draft}\n2. Check it` : `1. ${markers.revised}\n2. Check it\n3. Finish` };
    }
    throw new Error(`Unexpected read ${route}`);
  }) };
  const locator: Row = { last() { return this; }, first() { return this; }, getByTestId() { return this; }, locator() { return this; }, fill: async () => {} };
  const page = { goto: async () => {}, reload: async () => {}, locator: () => locator, getByTestId: () => locator,
    getByRole: (_role: string, options: { name: string }) => ({ last() { return this; }, click: async () => {
      expect(recovering(), "a human decision must wait for the producing native turn").toBe(false);
      if (options.name === "Reject") { if (++rejects === 2) stage = 2; }
      else { decisions.push(stage); throw stop; }
    } }) };
  vi.mocked(createTaskThroughUi).mockResolvedValue({ issueId: "task" } as any);
  vi.mocked(decideProtectedActionThroughUi).mockImplementation(async () => {
    expect(recovering(), "protected approval must wait for the producing turn").toBe(false);
    decisions.push(stage); throw stop;
  });
  const context = { api, page, company: { id: "company", issuePrefix: "QA" }, user: { id: "user" }, environmentId: "environment",
    agent: { id: "agent", name: "QA agent", provider: "opencode", model: "model", runtimeMode: "native" },
    fixtures: { reviewService: { id: "service", name: "Review", connectionId: "service", invocationCount: () => 0 } } } as unknown as JourneyContext;
  return { api, reads, decisions, stop, execute: () => runAgentJourney(journey, context, { own: async () => {} } as unknown as TargetSession,
    campaign, { checks: [] } as unknown as JourneyEvidence, { directory, deadlineAt, capture: async () => {} }) };
}

it("waits through both draft and revised Plan recovery before requesting changes or approving", async () => {
  const f = await fixture("plan-revise-accept");
  await expect(f.execute()).rejects.toBe(f.stop);
  expect([...f.reads.entries()]).toEqual([[1, 3], [2, 3]]);
  expect(f.decisions).toEqual([2]);
});
it("waits through pending protected-action recovery before making its first decision", async () => {
  const f = await fixture("protected-actions");
  await expect(f.execute()).rejects.toBe(f.stop);
  expect(f.reads.get(1)).toBe(3);
  expect(f.decisions).toEqual([1]);
});
it.each(["plan-revise-accept", "protected-actions"] as const)("does not decide %s when recovery outlives the original deadline", async journey => {
  const f = await fixture(journey, true);
  await expect(f.execute()).rejects.toMatchObject({ code: "agent_recovery_not_completed" });
  expect(f.decisions).toEqual([]);
  expect(f.api.get.mock.calls.some(([route]) => route.endsWith("/documents/plan"))).toBe(false);
  expect(decideProtectedActionThroughUi).not.toHaveBeenCalled();
});
