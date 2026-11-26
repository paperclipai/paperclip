import { expect, it, vi } from "vitest";
import type { RunnerApi } from "./api.js";
import { captureFollowupStopFailureApiState, followupStopApiState } from "./followup-stop-evidence.js";

it("uses the same closed selection for outer failure capture without reading conversations or logs", async () => {
  const issue = { id: "task", companyId: "company", status: "in_progress", executionRunId: "run", executionWorkspaceId: "workspace",
    description: "PRIVATE PROMPT", title: "PRIVATE TITLE" };
  const run = { id: "run", companyId: "company", agentId: "agent", issueId: "task", nativeIssueId: "task", status: "cancelled", nativePhase: "terminal_failure",
    runtimeMode: "native", startedAt: "2026-10-21T12:00:00Z", finishedAt: "2026-10-21T12:00:01Z",
    contextSnapshot: { issueId: "task", prompt: "PRIVATE PROMPT" }, resultJson: { summary: "PRIVATE PROVIDER TEXT" }, runnerProfileJson: { token: "PRIVATE CONFIG" } };
  const get = vi.fn(async (route: string) => {
    if (route === "/api/issues/task") return issue;
    if (route === "/api/companies/company/heartbeat-runs?agentId=agent&limit=20") return [run];
    if (route === "/api/heartbeat-runs/run") return run;
    throw new Error("Unexpected evidence read");
  });
  const evidence = vi.fn(async (_name: string, _value: unknown) => undefined);
  const captured = await captureFollowupStopFailureApiState({ api: { get } as unknown as RunnerApi,
    companyId: "company", agentId: "agent", issueId: "task", evidence });
  expect(captured).toEqual({ issue, runs: [run] });
  expect(get).toHaveBeenCalledTimes(3);
  expect(evidence).toHaveBeenCalledExactlyOnceWith("api-state.json", followupStopApiState("failure", issue, [run]));
  expect(JSON.stringify(evidence.mock.calls)).not.toContain("PRIVATE");
  expect(evidence.mock.calls[0]![1]).toEqual({ capturePhase: "failure",
    issue: { id: "task", companyId: "company", status: "in_progress", executionRunId: "run", executionWorkspaceId: "workspace" },
    runs: [{ id: "run", companyId: "company", agentId: "agent", issueId: "task", nativeIssueId: "task", contextIssueId: "task", status: "cancelled", nativePhase: "terminal_failure",
      runtimeMode: "native", startedAt: "2026-10-21T12:00:00Z", finishedAt: "2026-10-21T12:00:01Z" }] });
});

it("does not fetch broad company state before task creation", async () => {
  const get = vi.fn(), evidence = vi.fn();
  expect(await captureFollowupStopFailureApiState({ api: { get } as unknown as RunnerApi, companyId: "company", agentId: "agent",
    issueId: undefined, evidence })).toBeNull();
  expect(get).not.toHaveBeenCalled();
  expect(evidence).not.toHaveBeenCalled();
});
