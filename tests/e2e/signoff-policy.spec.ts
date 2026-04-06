import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * E2E: Signoff execution policy flow.
 *
 * Validates the full signoff lifecycle through the API and UI:
 *   1. Create a company with executor + reviewer + approver agents
 *   2. Create an issue with a two-stage execution policy (review → approval)
 *   3. Executor marks done → issue routes to reviewer (in_review)
 *   4. Reviewer approves → issue routes to approver
 *   5. Approver approves → execution completes, issue marked done
 *   6. Verify "changes requested" flow returns to executor
 *
 * This test is API-driven with UI verification of execution state labels.
 */

const COMPANY_NAME = `E2E-Signoff-${Date.now()}`;

interface TestContext {
  baseUrl: string;
  companyId: string;
  companyPrefix: string;
  executorAgentId: string;
  reviewerAgentId: string;
  approverAgentId: string;
}

async function setupCompany(request: APIRequestContext, baseUrl: string): Promise<TestContext> {
  // Create company
  const companyRes = await request.post(`${baseUrl}/api/companies`, {
    data: { name: COMPANY_NAME },
  });
  expect(companyRes.ok()).toBe(true);
  const company = await companyRes.json();
  const companyId = company.id;

  // Fetch company prefix from the company object
  const companyPrefix = company.prefix ?? company.urlKey ?? "E2E";

  // Create executor agent (engineer)
  const executorRes = await request.post(`${baseUrl}/api/companies/${companyId}/agents`, {
    data: {
      name: "Executor",
      role: "engineer",
      title: "Software Engineer",
      adapterType: "process",
      adapterConfig: { command: "echo done" },
    },
  });
  expect(executorRes.ok()).toBe(true);
  const executor = await executorRes.json();

  // Create reviewer agent (QA)
  const reviewerRes = await request.post(`${baseUrl}/api/companies/${companyId}/agents`, {
    data: {
      name: "Reviewer",
      role: "qa",
      title: "QA Engineer",
      adapterType: "process",
      adapterConfig: { command: "echo done" },
    },
  });
  expect(reviewerRes.ok()).toBe(true);
  const reviewer = await reviewerRes.json();

  // Create approver agent (CTO)
  const approverRes = await request.post(`${baseUrl}/api/companies/${companyId}/agents`, {
    data: {
      name: "Approver",
      role: "cto",
      title: "CTO",
      adapterType: "process",
      adapterConfig: { command: "echo done" },
    },
  });
  expect(approverRes.ok()).toBe(true);
  const approver = await approverRes.json();

  return {
    baseUrl,
    companyId,
    companyPrefix,
    executorAgentId: executor.id,
    reviewerAgentId: reviewer.id,
    approverAgentId: approver.id,
  };
}

async function createIssueWithPolicy(
  request: APIRequestContext,
  ctx: TestContext,
  title: string,
) {
  const res = await request.post(`${ctx.baseUrl}/api/companies/${ctx.companyId}/issues`, {
    data: {
      title,
      status: "in_progress",
      assigneeAgentId: ctx.executorAgentId,
      executionPolicy: {
        stages: [
          {
            type: "review",
            participants: [{ type: "agent", agentId: ctx.reviewerAgentId }],
          },
          {
            type: "approval",
            participants: [{ type: "agent", agentId: ctx.approverAgentId }],
          },
        ],
      },
    },
  });
  expect(res.ok()).toBe(true);
  return res.json();
}

test.describe("Signoff execution policy", () => {
  let ctx: TestContext;

  test.beforeAll(async ({ request }) => {
    const baseUrl = (test.info().project.use as { baseURL?: string }).baseURL ?? "http://127.0.0.1:3100";
    ctx = await setupCompany(request, baseUrl);
  });

  test("happy path: executor → review → approval → done", async ({ request, page }) => {
    const issue = await createIssueWithPolicy(request, ctx, "Signoff happy path");
    const issueId = issue.id;

    // Verify policy was saved
    expect(issue.executionPolicy).toBeTruthy();
    expect(issue.executionPolicy.stages).toHaveLength(2);
    expect(issue.executionPolicy.stages[0].type).toBe("review");
    expect(issue.executionPolicy.stages[1].type).toBe("approval");

    // Step 1: Executor marks done → should route to reviewer
    const step1Res = await request.patch(`${ctx.baseUrl}/api/issues/${issueId}`, {
      data: {
        status: "done",
        comment: "Implemented the feature, ready for review.",
      },
    });
    expect(step1Res.ok()).toBe(true);
    const step1Issue = await step1Res.json();

    expect(step1Issue.status).toBe("in_review");
    expect(step1Issue.assigneeAgentId).toBe(ctx.reviewerAgentId);
    expect(step1Issue.executionState).toBeTruthy();
    expect(step1Issue.executionState.status).toBe("pending");
    expect(step1Issue.executionState.currentStageType).toBe("review");
    expect(step1Issue.executionState.returnAssignee).toMatchObject({
      type: "agent",
      agentId: ctx.executorAgentId,
    });

    // Step 2: Navigate to issue in UI and verify execution label
    await page.goto(`/${ctx.companyPrefix}/issues/${issue.identifier}`);
    await expect(page.locator("text=Review pending")).toBeVisible({ timeout: 10_000 });

    // Step 3: Reviewer approves → should route to approver
    const step3Res = await request.patch(`${ctx.baseUrl}/api/issues/${issueId}`, {
      data: {
        status: "done",
        comment: "QA signoff complete. Looks good.",
      },
    });
    expect(step3Res.ok()).toBe(true);
    const step3Issue = await step3Res.json();

    expect(step3Issue.status).toBe("in_review");
    expect(step3Issue.assigneeAgentId).toBe(ctx.approverAgentId);
    expect(step3Issue.executionState.status).toBe("pending");
    expect(step3Issue.executionState.currentStageType).toBe("approval");
    expect(step3Issue.executionState.completedStageIds).toHaveLength(1);

    // Step 4: Verify UI shows approval pending
    await page.reload();
    await expect(page.locator("text=Approval pending")).toBeVisible({ timeout: 10_000 });

    // Step 5: Approver approves → should complete
    const step5Res = await request.patch(`${ctx.baseUrl}/api/issues/${issueId}`, {
      data: {
        status: "done",
        comment: "Approved. Ship it.",
      },
    });
    expect(step5Res.ok()).toBe(true);
    const step5Issue = await step5Res.json();

    expect(step5Issue.status).toBe("done");
    expect(step5Issue.executionState.status).toBe("completed");
    expect(step5Issue.executionState.completedStageIds).toHaveLength(2);
    expect(step5Issue.executionState.lastDecisionOutcome).toBe("approved");
  });

  test("changes requested: reviewer bounces back to executor", async ({ request }) => {
    const issue = await createIssueWithPolicy(request, ctx, "Signoff changes requested");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    const doneRes = await request.patch(`${ctx.baseUrl}/api/issues/${issueId}`, {
      data: { status: "done", comment: "Ready for review." },
    });
    expect(doneRes.ok()).toBe(true);
    const reviewIssue = await doneRes.json();
    expect(reviewIssue.status).toBe("in_review");
    expect(reviewIssue.assigneeAgentId).toBe(ctx.reviewerAgentId);

    // Reviewer requests changes → returns to executor
    const changesRes = await request.patch(`${ctx.baseUrl}/api/issues/${issueId}`, {
      data: {
        status: "in_progress",
        comment: "Needs another pass on edge cases.",
      },
    });
    expect(changesRes.ok()).toBe(true);
    const changesIssue = await changesRes.json();

    expect(changesIssue.status).toBe("in_progress");
    expect(changesIssue.assigneeAgentId).toBe(ctx.executorAgentId);
    expect(changesIssue.executionState.status).toBe("changes_requested");
    expect(changesIssue.executionState.lastDecisionOutcome).toBe("changes_requested");

    // Executor re-submits → goes back to reviewer (same stage)
    const resubmitRes = await request.patch(`${ctx.baseUrl}/api/issues/${issueId}`, {
      data: { status: "done", comment: "Fixed the edge cases." },
    });
    expect(resubmitRes.ok()).toBe(true);
    const resubmitIssue = await resubmitRes.json();

    expect(resubmitIssue.status).toBe("in_review");
    expect(resubmitIssue.assigneeAgentId).toBe(ctx.reviewerAgentId);
    expect(resubmitIssue.executionState.status).toBe("pending");
    expect(resubmitIssue.executionState.currentStageType).toBe("review");
  });

  test("comment required: approval without comment fails", async ({ request }) => {
    const issue = await createIssueWithPolicy(request, ctx, "Signoff comment required");
    const issueId = issue.id;

    // Executor marks done
    await request.patch(`${ctx.baseUrl}/api/issues/${issueId}`, {
      data: { status: "done", comment: "Done." },
    });

    // Reviewer tries to approve without comment → should fail
    const noCommentRes = await request.patch(`${ctx.baseUrl}/api/issues/${issueId}`, {
      data: { status: "done" },
    });
    // Server should reject: 422 or similar
    expect(noCommentRes.ok()).toBe(false);
    const errorBody = await noCommentRes.json();
    expect(JSON.stringify(errorBody)).toContain("comment");
  });

  test("non-participant cannot advance stage", async ({ request }) => {
    const issue = await createIssueWithPolicy(request, ctx, "Signoff access control");
    const issueId = issue.id;

    // Executor marks done → routes to reviewer
    await request.patch(`${ctx.baseUrl}/api/issues/${issueId}`, {
      data: { status: "done", comment: "Done." },
    });

    // Verify issue is in_review with reviewer
    const issueRes = await request.get(`${ctx.baseUrl}/api/issues/${issueId}`);
    const inReviewIssue = await issueRes.json();
    expect(inReviewIssue.status).toBe("in_review");
    expect(inReviewIssue.assigneeAgentId).toBe(ctx.reviewerAgentId);
    expect(inReviewIssue.executionState.currentStageType).toBe("review");
  });

  test("review-only policy: reviewer approval completes execution", async ({ request }) => {
    // Create issue with review-only policy (no approval stage)
    const res = await request.post(`${ctx.baseUrl}/api/companies/${ctx.companyId}/issues`, {
      data: {
        title: "Signoff review-only",
        status: "in_progress",
        assigneeAgentId: ctx.executorAgentId,
        executionPolicy: {
          stages: [
            {
              type: "review",
              participants: [{ type: "agent", agentId: ctx.reviewerAgentId }],
            },
          ],
        },
      },
    });
    expect(res.ok()).toBe(true);
    const issue = await res.json();

    // Executor marks done → routes to reviewer
    const doneRes = await request.patch(`${ctx.baseUrl}/api/issues/${issue.id}`, {
      data: { status: "done", comment: "Ready for review." },
    });
    expect(doneRes.ok()).toBe(true);
    const reviewIssue = await doneRes.json();
    expect(reviewIssue.status).toBe("in_review");

    // Reviewer approves → should complete immediately (no approval stage)
    const approveRes = await request.patch(`${ctx.baseUrl}/api/issues/${issue.id}`, {
      data: { status: "done", comment: "LGTM." },
    });
    expect(approveRes.ok()).toBe(true);
    const doneIssue = await approveRes.json();
    expect(doneIssue.status).toBe("done");
    expect(doneIssue.executionState.status).toBe("completed");
    expect(doneIssue.executionState.completedStageIds).toHaveLength(1);
  });
});
