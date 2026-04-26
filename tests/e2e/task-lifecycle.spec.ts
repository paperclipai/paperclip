import { test, expect, request as pwRequest } from "@playwright/test";

/**
 * E2E: Task (issue) lifecycle flow.
 *
 * Tests the full lifecycle of a task/issue:
 *   1. Create issue (backlog/todo)
 *   2. Assign to agent
 *   3. Checkout (locks the issue)
 *   4. Move to in_progress
 *   5. Complete (done) or block
 *   6. Verify state transitions and validations
 *
 * This test focuses on the issue state machine and transitions.
 */

const PORT = Number(process.env.PAPERCLIP_E2E_PORT ?? 3199);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const COMPANY_NAME = `E2E-Task-Lifecycle-${Date.now()}`;

test.describe("Task lifecycle", () => {
  test("full lifecycle: create → assign → checkout → in_progress → done", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });

    // Create company
    const companyRes = await board.post(`${BASE_URL}/api/companies`, {
      data: { name: COMPANY_NAME },
    });
    expect(companyRes.ok()).toBe(true);
    const company = await companyRes.json();

    // Create agent (with heartbeats disabled)
    const agentRes = await board.post(`${BASE_URL}/api/companies/${company.id}/agents`, {
      data: {
        name: "Task Agent",
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

    // Step 1: Create issue in backlog
    const createRes = await board.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: {
        title: "Task lifecycle test",
        description: "Testing the full task lifecycle",
        status: "backlog",
      },
    });
    expect(createRes.ok()).toBe(true);
    const issue = await createRes.json();
    expect(issue.status).toBe("backlog");
    expect(issue.assigneeAgentId).toBeNull();

    // Step 2: Assign to agent (moves to todo)
    const assignRes = await board.patch(`${BASE_URL}/api/issues/${issue.id}`, {
      data: {
        assigneeAgentId: agent.id,
        status: "todo",
      },
    });
    expect(assignRes.ok()).toBe(true);
    const assignedIssue = await assignRes.json();
    expect(assignedIssue.status).toBe("todo");
    expect(assignedIssue.assigneeAgentId).toBe(agent.id);

    // Step 3: Checkout the issue (board callers don't pass runId; checkout transitions to in_progress)
    const checkoutRes = await board.post(`${BASE_URL}/api/issues/${issue.id}/checkout`, {
      data: {
        agentId: agent.id,
        expectedStatuses: ["todo"],
      },
    });
    expect(checkoutRes.ok()).toBe(true);
    const checkedOutIssue = await checkoutRes.json();
    expect(checkedOutIssue.status).toBe("in_progress");
    expect(checkedOutIssue.assigneeAgentId).toBe(agent.id);
    expect(checkedOutIssue.startedAt).toBeTruthy();

    // Step 4: Complete the task
    const doneRes = await board.patch(`${BASE_URL}/api/issues/${issue.id}`, {
      data: {
        status: "done",
        comment: "Task completed successfully",
      },
    });
    expect(doneRes.ok()).toBe(true);
    const doneIssue = await doneRes.json();
    expect(doneIssue.status).toBe("done");
    expect(doneIssue.completedAt).toBeTruthy();

    // Cleanup
    await board.delete(`${BASE_URL}/api/companies/${company.id}`).catch(() => {});
    await board.dispose();
  });

  test("blocked transition: in_progress → blocked → in_progress", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });

    // Create company
    const companyRes = await board.post(`${BASE_URL}/api/companies`, {
      data: { name: `${COMPANY_NAME}-blocked` },
    });
    expect(companyRes.ok()).toBe(true);
    const company = await companyRes.json();

    // Create agent
    const agentRes = await board.post(`${BASE_URL}/api/companies/${company.id}/agents`, {
      data: {
        name: "Blocked Agent",
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

    // Create and start an issue
    const issueRes = await board.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: {
        title: "Blocked task test",
        status: "in_progress",
        assigneeAgentId: agent.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    // Block the task
    const blockedRes = await board.patch(`${BASE_URL}/api/issues/${issue.id}`, {
      data: {
        status: "blocked",
        comment: "Waiting for dependency",
      },
    });
    expect(blockedRes.ok()).toBe(true);
    const blockedIssue = await blockedRes.json();
    expect(blockedIssue.status).toBe("blocked");

    // Unblock and resume
    const resumeRes = await board.patch(`${BASE_URL}/api/issues/${issue.id}`, {
      data: {
        status: "in_progress",
        comment: "Dependency resolved, resuming",
      },
    });
    expect(resumeRes.ok()).toBe(true);
    const resumedIssue = await resumeRes.json();
    expect(resumedIssue.status).toBe("in_progress");

    // Cleanup
    await board.delete(`${BASE_URL}/api/companies/${company.id}`).catch(() => {});
    await board.dispose();
  });

  test("cancelled transition: any status → cancelled", async () => {
    const board = await pwRequest.newContext({ baseURL: BASE_URL });

    // Create company
    const companyRes = await board.post(`${BASE_URL}/api/companies`, {
      data: { name: `${COMPANY_NAME}-cancelled` },
    });
    expect(companyRes.ok()).toBe(true);
    const company = await companyRes.json();

    // Create issue
    const issueRes = await board.post(`${BASE_URL}/api/companies/${company.id}/issues`, {
      data: {
        title: "Task to be cancelled",
        status: "todo",
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    // Cancel the task
    const cancelRes = await board.patch(`${BASE_URL}/api/issues/${issue.id}`, {
      data: {
        status: "cancelled",
        comment: "No longer needed",
      },
    });
    expect(cancelRes.ok()).toBe(true);
    const cancelledIssue = await cancelRes.json();
    expect(cancelledIssue.status).toBe("cancelled");
    expect(cancelledIssue.cancelledAt).toBeTruthy();

    // Cleanup
    await board.delete(`${BASE_URL}/api/companies/${company.id}`).catch(() => {});
    await board.dispose();
  });
});
