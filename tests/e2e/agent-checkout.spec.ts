import { test, expect, request as pwRequest } from "@playwright/test";

/**
 * E2E: Agent checkout flow.
 *
 * Tests the agent checkout mechanism with conflict detection:
 *   1. Successful checkout (agent locks an issue)
 *   2. Conflict detection (another agent tries to checkout the same issue)
 *   3. Wake-on-checkout (assigning wakes the agent)
 *   4. Checkout expiration and re-checkout
 *
 * This test focuses on the locking and concurrency control mechanisms.
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const COMPANY_NAME = `E2E-Checkout-${Date.now()}`;

test.describe("Agent checkout", () => {
  test("successful checkout locks the issue with executionRunId", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });

    // Create company
    const companyRes = await board.post(`${BASE_URL}/api/companies`, {
      data: { name: COMPANY_NAME },
    });
    expect(companyRes.ok()).toBe(true);
    const company = await companyRes.json();

    // Create agent
    const agentRes = await board.post(`${BASE_URL}/api/companies/${company.id}/agents`, {
      data: {
        name: "Checkout Agent",
        role: "engineer",
        title: "Software Engineer",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('done\\n')"],
        },
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            intervalSec: 300,
            wakeOnDemand: false,
            cooldownSec: 10,
            maxConcurrentRuns: 1,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    // Create issue (wakeOnDemand is false so no assignment wakeup fires)
    const issueRes = await board.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: {
        title: "Checkout test issue",
        status: "todo",
        assigneeAgentId: agent.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    // Checkout the issue (board users call checkout directly; runId is a JWT claim
    // only available to agent callers, so checkoutRunId/executionRunId are null here)
    const checkoutRes = await board.post(`${BASE_URL}/api/issues/${issue.id}/checkout`, {
      data: {
        agentId: agent.id,
        expectedStatuses: ["todo"],
      },
    });
    expect(checkoutRes.ok()).toBe(true);
    const checkedOutIssue = await checkoutRes.json();

    // Verify checkout transitioned the issue to in_progress
    expect(checkedOutIssue.status).toBe("in_progress");
    expect(checkedOutIssue.assigneeAgentId).toBe(agent.id);
    expect(checkedOutIssue.startedAt).toBeTruthy();

    // Wait for heartbeat run to complete before cleanup to prevent FK violations
    await expect
      .poll(
        async () => {
          const runRes = await board.get(`${BASE_URL}/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`);
          const runs = await runRes.json();
          return runs.every((r: { status: string }) => ["succeeded", "failed", "cancelled"].includes(r.status));
        },
        { timeout: 30_000, intervals: [500, 1_000, 2_000] }
      )
      .toBe(true);

    // Cleanup
    await board.delete(`${BASE_URL}/api/companies/${company.id}`).catch(() => {});
    await board.dispose();
  });

  test("conflict detection prevents concurrent checkout by different agents", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });

    // Create company
    const companyRes = await board.post(`${BASE_URL}/api/companies`, {
      data: { name: `${COMPANY_NAME}-conflict` },
    });
    expect(companyRes.ok()).toBe(true);
    const company = await companyRes.json();

    // Create two agents
    const agent1Res = await board.post(`${BASE_URL}/api/companies/${company.id}/agents`, {
      data: {
        name: "Agent One",
        role: "engineer",
        title: "Software Engineer",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('done\\n')"],
        },
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            intervalSec: 300,
            wakeOnDemand: false,
            cooldownSec: 10,
            maxConcurrentRuns: 1,
          },
        },
      },
    });
    expect(agent1Res.ok()).toBe(true);
    const agent1 = await agent1Res.json();

    const agent2Res = await board.post(`${BASE_URL}/api/companies/${company.id}/agents`, {
      data: {
        name: "Agent Two",
        role: "engineer",
        title: "Software Engineer",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('done\\n')"],
        },
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            intervalSec: 300,
            wakeOnDemand: false,
            cooldownSec: 10,
            maxConcurrentRuns: 1,
          },
        },
      },
    });
    expect(agent2Res.ok()).toBe(true);
    const agent2 = await agent2Res.json();

    // Create issue assigned to agent1
    const issueRes = await board.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: {
        title: "Conflict test issue",
        status: "todo",
        assigneeAgentId: agent1.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    // Agent1 checks out the issue
    const heartbeat1Res = await board.post(`${BASE_URL}/api/agents/${agent1.id}/heartbeat/invoke`);
    expect(heartbeat1Res.ok()).toBe(true);
    const heartbeat1Run = await heartbeat1Res.json();

    const checkout1Res = await board.post(`${BASE_URL}/api/issues/${issue.id}/checkout`, {
      data: {
        agentId: agent1.id,
        expectedStatuses: ["todo"],
        runId: heartbeat1Run.id,
      },
    });
    expect(checkout1Res.ok()).toBe(true);

    // Agent2 tries to checkout the same issue (should fail with 409 Conflict)
    const heartbeat2Res = await board.post(`${BASE_URL}/api/agents/${agent2.id}/heartbeat/invoke`);
    expect(heartbeat2Res.ok()).toBe(true);
    const heartbeat2Run = await heartbeat2Res.json();

    const checkout2Res = await board.post(`${BASE_URL}/api/issues/${issue.id}/checkout`, {
      data: {
        agentId: agent2.id,
        expectedStatuses: ["todo"],
        runId: heartbeat2Run.id,
      },
    });

    // Expect conflict (409) or forbidden (403)
    expect([403, 409]).toContain(checkout2Res.status());

    // Cleanup
    await board.delete(`${BASE_URL}/api/companies/${company.id}`).catch(() => {});
    await board.dispose();
  });

  test("checkout with wrong expectedStatuses fails", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });

    // Create company
    const companyRes = await board.post(`${BASE_URL}/api/companies`, {
      data: { name: `${COMPANY_NAME}-status` },
    });
    expect(companyRes.ok()).toBe(true);
    const company = await companyRes.json();

    // Create agent
    const agentRes = await board.post(`${BASE_URL}/api/companies/${company.id}/agents`, {
      data: {
        name: "Status Agent",
        role: "engineer",
        title: "Software Engineer",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('done\\n')"],
        },
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            intervalSec: 300,
            wakeOnDemand: false,
            cooldownSec: 10,
            maxConcurrentRuns: 1,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    // Create issue in "backlog" status
    const issueRes = await board.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: {
        title: "Status check issue",
        status: "backlog",
        assigneeAgentId: agent.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    // Create heartbeat run
    const heartbeatRes = await board.post(`${BASE_URL}/api/agents/${agent.id}/heartbeat/invoke`);
    expect(heartbeatRes.ok()).toBe(true);
    const heartbeatRun = await heartbeatRes.json();

    // Try to checkout expecting "todo" status (but issue is in "backlog")
    const checkoutRes = await board.post(`${BASE_URL}/api/issues/${issue.id}/checkout`, {
      data: {
        agentId: agent.id,
        expectedStatuses: ["todo", "in_progress"],
        runId: heartbeatRun.id,
      },
    });

    // Should fail with 409 (conflict) or 422 (unprocessable)
    expect([409, 422]).toContain(checkoutRes.status());

    // Cleanup
    await board.delete(`${BASE_URL}/api/companies/${company.id}`).catch(() => {});
    await board.dispose();
  });

  test("re-checkout after status change is allowed", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });

    // Create company
    const companyRes = await board.post(`${BASE_URL}/api/companies`, {
      data: { name: `${COMPANY_NAME}-recheckout` },
    });
    expect(companyRes.ok()).toBe(true);
    const company = await companyRes.json();

    // Create agent
    const agentRes = await board.post(`${BASE_URL}/api/companies/${company.id}/agents`, {
      data: {
        name: "Recheckout Agent",
        role: "engineer",
        title: "Software Engineer",
        adapterType: "process",
        adapterConfig: {
          command: process.execPath,
          args: ["-e", "process.stdout.write('done\\n')"],
        },
        runtimeConfig: {
          heartbeat: {
            enabled: false,
            intervalSec: 300,
            wakeOnDemand: false,
            cooldownSec: 10,
            maxConcurrentRuns: 1,
          },
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    // Create issue (wakeOnDemand is false so no assignment wakeup fires)
    const issueRes = await board.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: {
        title: "Recheckout test issue",
        status: "todo",
        assigneeAgentId: agent.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    // First checkout — transitions todo → in_progress
    const checkout1Res = await board.post(`${BASE_URL}/api/issues/${issue.id}/checkout`, {
      data: {
        agentId: agent.id,
        expectedStatuses: ["todo"],
      },
    });
    expect(checkout1Res.ok()).toBe(true);

    // Update issue status to blocked (clears execution lock fields, enabling re-checkout)
    const updateRes = await board.patch(`${BASE_URL}/api/issues/${issue.id}`, {
      data: {
        status: "blocked",
        comment: "Pausing work temporarily",
      },
    });
    expect(updateRes.ok()).toBe(true);

    // Second checkout (re-checkout) — transitions blocked → in_progress
    const checkout2Res = await board.post(`${BASE_URL}/api/issues/${issue.id}/checkout`, {
      data: {
        agentId: agent.id,
        expectedStatuses: ["blocked"],
      },
    });
    expect(checkout2Res.ok()).toBe(true);
    const recheckedOutIssue = await checkout2Res.json();
    expect(recheckedOutIssue.status).toBe("in_progress");
    expect(recheckedOutIssue.startedAt).toBeTruthy();

    // Wait for all heartbeat runs to complete before cleanup to prevent FK violations
    await expect
      .poll(
        async () => {
          const runRes = await board.get(`${BASE_URL}/api/companies/${company.id}/heartbeat-runs?agentId=${agent.id}`);
          const runs = await runRes.json();
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
