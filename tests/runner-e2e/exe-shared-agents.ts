import assert from "node:assert/strict";
import { expect, type Page } from "@playwright/test";
import { RunnerApi, pollUntil } from "./api.js";
import { runnerProfiles, runnerTasks } from "./catalog.js";
import type { LiveFixtureValues } from "./live-fixtures.js";

/** Real native/native and native/legacy overlap on the same durable VM. */
export async function verifyExeSharedAgents(input: { api: RunnerApi; page: Page; fixtures: LiveFixtureValues; nonce: string; workspacePath: string }) {
  const { api, fixtures } = input;
  const task = runnerTasks.find((entry) => entry.id === "message-marker")!;
  const agents = await Promise.all(["runner-codex", "runner-codex", "legacy-codex"].map(async (id, i) => {
    const profile = runnerProfiles.find((entry) => entry.id === id)!;
    const nonce = `${input.nonce}-shared-${i}`;
    const agent = await api.post<{ id: string }>(`/api/companies/${fixtures.company.id}/agents`, profile.buildAgent({
      environmentId: fixtures.environment.id, environmentFixtureId: "exe-dev", workspacePath: input.workspacePath,
      secretRefs: fixtures.secretRefs, executionId: nonce,
    }));
    return { id: agent.id, profile: id, nonce };
  }));
  type Run = { id: string; status: string; startedAt: string; finishedAt: string; error?: string; contextSnapshot?: { issueId?: string; taskId?: string } };
  const issueRuns = async (issueId: string, agentId: string) =>
    (await api.get<Run[]>(`/api/companies/${fixtures.company.id}/heartbeat-runs?agentId=${agentId}&limit=20`))
      .filter((run) => run.contextSnapshot?.issueId === issueId || run.contextSnapshot?.taskId === issueId);
  const issues = await Promise.all(agents.map(async (agent) => ({ agent, issue: await api.post<{ id: string; identifier: string }>(`/api/companies/${fixtures.company.id}/issues`, {
    title: task.buildTitle(agent.nonce), description: task.buildPrompt(agent.nonce), status: "todo", assigneeAgentId: agent.id,
  }) })));
  try {
    const results = await Promise.all(issues.map(async ({ agent, issue }) => {
      const result = await pollUntil({ label: `shared ${agent.profile} task`, deadlineAt: Date.now() + 10 * 60_000, intervalMs: 1000,
        load: async () => ({ issue: await api.get<{ status: string }>(`/api/issues/${issue.id}`), runs: await issueRuns(issue.id, agent.id) }),
        accept: (value) => value.issue.status === "done" && value.runs.some((run) => run.status === "succeeded") && value.runs.every((run) => ["succeeded", "failed", "cancelled", "timed_out"].includes(run.status)),
        reject: (value) => value.runs.some((run) => ["failed", "timed_out"].includes(run.status)) ? `Shared agent failed: ${value.runs.map((run) => run.error ?? run.status).join("; ")}` : undefined,
      });
      return { agentId: agent.id, profile: agent.profile, issueId: issue.id, runs: result.runs };
    }));
    const firstRuns = results.map((result) => result.runs.find((run) => run.status === "succeeded")!);
    assert.ok(Math.max(...firstRuns.map((run) => Date.parse(run.startedAt))) < Math.min(...firstRuns.map((run) => Date.parse(run.finishedAt))), "All three real agent executions overlapped");
    const leases = await api.get<{ issueId: string; metadata: Record<string, unknown> }[]>(`/api/environments/${fixtures.environment.id}/leases`);
    const shared = leases.filter((lease) => issues.some(({ issue }) => issue.id === lease.issueId));
    assert.equal(new Set(shared.map((lease) => lease.issueId)).size, 3);
    assert.equal(new Set(shared.map((lease) => lease.metadata.vmName)).size, 1);
    assert.equal(new Set(shared.map((lease) => lease.metadata.remoteHome)).size, 3);
    assert.equal(new Set(shared.map((lease) => lease.metadata.remoteCwd)).size, 3);
    for (const { agent, issue } of issues) {
      await input.page.goto(`${api.baseURL}/${fixtures.company.issuePrefix}/issues/${issue.identifier}`);
      await expect(input.page.getByText(task.buildVisibleMarker(agent.nonce), { exact: true }).first()).toBeVisible({ timeout: 30000 });
    }
    return { results, vmName: shared[0].metadata.vmName, independentHomes: 3, independentWorkspaces: 3 };
  } finally {
    for (const { issue, agent } of issues) {
      const runs = await issueRuns(issue.id, agent.id);
      for (const run of runs) if (["queued", "running"].includes(run.status)) await api.post(`/api/heartbeat-runs/${run.id}/cancel`);
    }
  }
}
