import { test, expect, request as pwRequest } from "@playwright/test";

/**
 * E2E: Heartbeat cycle flow.
 *
 * Tests the core heartbeat cycle:
 *   1. Agent wakes (heartbeat invoked)
 *   2. Checks inbox (queries assigned issues)
 *   3. Checks out a task
 *   4. Does work (adapter execution)
 *   5. Updates status
 *
 * Runs in skip_llm mode by default (no actual LLM calls).
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const COMPANY_NAME = `E2E-Heartbeat-${Date.now()}`;

test.describe("Heartbeat cycle", () => {
  test("agent wakes, checks inbox, checks out task, executes, updates status", async ({ page }) => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });

    // Create company
    const companyRes = await board.post(`${BASE_URL}/api/companies`, {
      data: { name: COMPANY_NAME },
    });
    expect(companyRes.ok()).toBe(true);
    const company = await companyRes.json();

    // Create agent with heartbeat ENABLED for this test
    const agentRes = await board.post(`${BASE_URL}/api/companies/${company.id}/agents`, {
      data: {
        name: "Test Agent",
        role: "engineer",
        title: "Software Engineer",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('Task completed\\n')"],
        },
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 300,
            wakeOnDemand: true,
            cooldownSec: 10,
            maxConcurrentRuns: 1,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    // Create an issue assigned to the agent
    const issueRes = await board.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: {
        title: "Heartbeat test task",
        description: "Test task for heartbeat cycle",
        status: "todo",
        assigneeAgentId: agent.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    // Invoke heartbeat (wake the agent)
    const heartbeatRes = await board.post(`${BASE_URL}/api/agents/${agent.id}/heartbeat/invoke`);
    expect(heartbeatRes.ok()).toBe(true);
    const heartbeatRun = await heartbeatRes.json();
    expect(heartbeatRun.id).toBeTruthy();

    // Wait for heartbeat run to complete
    await expect
      .poll(
        async () => {
          const runRes = await board.get(`${BASE_URL}/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`);
          const runs = await runRes.json();
          const thisRun = runs.find((r: { id: string }) => r.id === heartbeatRun.id);
          return thisRun?.status;
        },
        { timeout: 30_000, intervals: [500, 1_000, 2_000] }
      )
      .toBe("succeeded");

    // Verify the issue was processed (should be checked out during heartbeat)
    const updatedIssueRes = await board.get(`${BASE_URL}/api/issues/${issue.id}`);
    expect(updatedIssueRes.ok()).toBe(true);
    const updatedIssue = await updatedIssueRes.json();

    // The issue should have been checked out by the assignment-triggered heartbeat run.
    // executionRunId is cleared by releaseIssueExecutionAndPromote after the run completes,
    // but the status remains in_progress.
    expect(updatedIssue.status).toBe("in_progress");
    expect(updatedIssue.assigneeAgentId).toBe(agent.id);

    // Cleanup
    await board.delete(`${BASE_URL}/api/companies/${company.id}`).catch(() => {});
    await board.dispose();
  });

  test("heartbeat respects cooldown period", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });

    // Create company
    const companyRes = await board.post(`${BASE_URL}/api/companies`, {
      data: { name: `${COMPANY_NAME}-cooldown` },
    });
    expect(companyRes.ok()).toBe(true);
    const company = await companyRes.json();

    // Create agent with short cooldown
    const agentRes = await board.post(`${BASE_URL}/api/companies/${company.id}/agents`, {
      data: {
        name: "Cooldown Agent",
        role: "engineer",
        title: "Software Engineer",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('done\\n')"],
        },
        runtimeConfig: {
          heartbeat: {
            enabled: true,
            intervalSec: 300,
            wakeOnDemand: true,
            cooldownSec: 5,
            maxConcurrentRuns: 1,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    // First heartbeat invocation
    const firstHeartbeatRes = await board.post(`${BASE_URL}/api/agents/${agent.id}/heartbeat/invoke`);
    expect(firstHeartbeatRes.ok()).toBe(true);

    // Immediate second invocation should be rejected or queued (due to cooldown/maxConcurrentRuns)
    const secondHeartbeatRes = await board.post(`${BASE_URL}/api/agents/${agent.id}/heartbeat/invoke`);
    // Either 202 (queued/accepted), 200, or 429 (rate limited) is acceptable
    expect([200, 202, 429]).toContain(secondHeartbeatRes.status());

    // Wait for all heartbeat runs to complete before cleanup to prevent FK violations
    await expect
      .poll(
        async () => {
          const runRes = await board.get(`${BASE_URL}/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`);
          const runs = await runRes.json();
          // Check that all runs are in terminal state
          return runs.every((r: { status: string }) => ["succeeded", "failed", "cancelled"].includes(r.status));
        },
        { timeout: 30_000, intervals: [500, 1_000, 2_000] }
      )
      .toBe(true);

    // Cleanup
    await board.delete(`${BASE_URL}/api/companies/${company.id}`).catch(() => {});
    await board.dispose();
  });
});
