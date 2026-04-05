import { test, expect, type Page } from "@playwright/test";

const HERMES_MODEL = process.env.PAPERCLIP_E2E_HERMES_MODEL ?? "gpt-4o";

async function createHermesCompanyAndCeo(
  page: Page,
  input: {
    companyName: string;
    ceoTaskTitle: string;
    ceoTaskBody: string;
  },
) {
  await page.goto("/");

  const wizardHeading = page.locator("h3", { hasText: "Name your company" });
  const newCompanyButton = page.getByRole("button", { name: "New Company" });
  const addCompanyButton = page.getByRole("button", { name: "Add company" });

  const isVisible = async (locator: ReturnType<Page["locator"]>) => {
    try {
      return await locator.isVisible();
    } catch {
      return false;
    }
  };

  if (
    !(await isVisible(wizardHeading)) &&
    !(await isVisible(newCompanyButton)) &&
    !(await isVisible(addCompanyButton))
  ) {
    await page.goto("/companies");
  }

  await expect
    .poll(
      async () =>
        (await isVisible(wizardHeading)) ||
        (await isVisible(newCompanyButton)) ||
        (await isVisible(addCompanyButton)),
      { timeout: 15_000 },
    )
    .toBe(true);

  if (!(await isVisible(wizardHeading))) {
    const createCompanyButton =
      (await isVisible(newCompanyButton)) ? newCompanyButton : addCompanyButton;
    await expect(createCompanyButton).toBeVisible({ timeout: 15_000 });
    await createCompanyButton.click();
  }

  await page.locator('input[placeholder="Acme Corp"]').fill(input.companyName);
  await page.getByRole("button", { name: "Next" }).click();

  await expect(
    page.locator("h3", { hasText: "Create your first agent" }),
  ).toBeVisible({ timeout: 10_000 });

  await page.getByRole("button", { name: "More Agent Adapter Types" }).click();
  await page.getByRole("button", { name: "Hermes Agent" }).click();

  const modelField = page.locator("label", { hasText: "Model" }).locator("..");
  const modelTrigger = modelField.getByRole("button").first();
  await modelTrigger.click();

  const modelOption = page
    .locator("[data-radix-popper-content-wrapper] button")
    .filter({ hasText: HERMES_MODEL })
    .first();
  await expect(modelOption).toBeVisible({ timeout: 20_000 });
  await modelOption.click();
  await expect(modelTrigger).toContainText(HERMES_MODEL);

  await page.getByRole("button", { name: "Next" }).click();
  await expect(
    page.locator("h3", { hasText: "Give it something to do" }),
  ).toBeVisible({ timeout: 10_000 });

  await page
    .locator('input[placeholder="e.g. Research competitor pricing"]')
    .fill(input.ceoTaskTitle);
  await page.locator("textarea").fill(input.ceoTaskBody);
  await page.getByRole("button", { name: "Next" }).click();

  await expect(
    page.locator("h3", { hasText: "Ready to launch" }),
  ).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Create & Open Issue" }).click();
  await expect(page).toHaveURL(/\/issues\//, { timeout: 20_000 });

  const baseUrl = page.url().split("/").slice(0, 3).join("/");
  const ceoIssueId = page.url().split("/").pop() ?? "";

  const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
  expect(companiesRes.ok()).toBe(true);
  const companies = await companiesRes.json();
  const company = companies.find((entry: { name: string }) => entry.name === input.companyName);
  expect(company).toBeTruthy();

  if (!company.requireBoardApprovalForNewAgents) {
    const updateRes = await page.request.patch(`${baseUrl}/api/companies/${company.id}`, {
      data: { requireBoardApprovalForNewAgents: true },
    });
    expect(updateRes.ok()).toBe(true);
  }

  const agentsRes = await page.request.get(`${baseUrl}/api/companies/${company.id}/agents`);
  expect(agentsRes.ok()).toBe(true);
  const agents = await agentsRes.json();
  const ceoAgent = agents.find((entry: { name: string }) => entry.name === "CEO");
  expect(ceoAgent).toBeTruthy();
  expect(ceoAgent.adapterType).toBe("hermes_local");
  expect(ceoAgent.adapterConfig.model).toBe(HERMES_MODEL);

  const ceoEnvRes = await page.request.post(
    `${baseUrl}/api/companies/${company.id}/adapters/hermes_local/test-environment`,
    {
      data: { adapterConfig: ceoAgent.adapterConfig },
    },
  );
  expect(ceoEnvRes.ok()).toBe(true);
  const ceoEnv = await ceoEnvRes.json();
  expect(ceoEnv.status).not.toBe("fail");

  return { baseUrl, company, ceoAgent, ceoIssueId };
}

async function waitForHireApproval(
  page: Page,
  input: {
    baseUrl: string;
    companyId: string;
    ceoAgentId: string;
    workerName: string;
  },
) {
  let approvalId = "";
  await expect
    .poll(
      async () => {
        const approvalsRes = await page.request.get(
          `${input.baseUrl}/api/companies/${input.companyId}/approvals?status=pending`,
        );
        if (!approvalsRes.ok()) return "";
        const approvals = await approvalsRes.json();
        const hireApproval = approvals.find(
          (entry: {
            id: string;
            type: string;
            requestedByAgentId: string | null;
            payload?: { name?: string; adapterType?: string };
          }) =>
            entry.type === "hire_agent" &&
            entry.requestedByAgentId === input.ceoAgentId &&
            entry.payload?.name === input.workerName &&
            entry.payload?.adapterType === "hermes_local",
        );
        approvalId = hireApproval?.id ?? "";
        return approvalId;
      },
      {
        timeout: 4 * 60 * 1000,
        intervals: [5_000, 10_000],
      },
    )
    .not.toBe("");

  return approvalId;
}

async function waitForApproval(
  page: Page,
  baseUrl: string,
  approvalId: string,
  predicate: (approval: Record<string, unknown>) => boolean,
  timeout = 4 * 60 * 1000,
) {
  let latestApproval: Record<string, unknown> | null = null;
  await expect
    .poll(
      async () => {
        const approvalRes = await page.request.get(`${baseUrl}/api/approvals/${approvalId}`);
        if (!approvalRes.ok()) return false;
        latestApproval = await approvalRes.json();
        return predicate(latestApproval);
      },
      {
        timeout,
        intervals: [5_000, 10_000],
      },
    )
    .toBe(true);

  expect(latestApproval).toBeTruthy();
  return latestApproval!;
}

async function waitForWorkerAgent(
  page: Page,
  input: {
    baseUrl: string;
    companyId: string;
    workerName: string;
  },
) {
  let workerAgentId = "";
  await expect
    .poll(
      async () => {
        const agentsRes = await page.request.get(
          `${input.baseUrl}/api/companies/${input.companyId}/agents`,
        );
        if (!agentsRes.ok()) return "";
        const agents = await agentsRes.json();
        const worker = agents.find(
          (entry: { id: string; name: string; status: string; adapterType: string }) =>
            entry.name === input.workerName &&
            entry.adapterType === "hermes_local" &&
            entry.status !== "pending_approval" &&
            entry.status !== "terminated",
        );
        workerAgentId = worker?.id ?? "";
        return workerAgentId;
      },
      {
        timeout: 2 * 60 * 1000,
        intervals: [2_000, 5_000],
      },
    )
    .not.toBe("");

  return workerAgentId;
}

async function postApprovalCommentViaUi(
  page: Page,
  input: {
    baseUrl: string;
    issuePrefix: string;
    approvalId: string;
    comment: string;
  },
) {
  await page.goto(`${input.baseUrl}/${input.issuePrefix}/approvals/${input.approvalId}`);
  const commentBox = page.locator('textarea[placeholder="Add a comment..."]');
  await expect(commentBox).toBeVisible({ timeout: 20_000 });
  await commentBox.fill(input.comment);
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(page.getByText(input.comment)).toBeVisible({ timeout: 20_000 });
}

test.describe("Hermes approval lifecycle flows", () => {
  test.setTimeout(10 * 60 * 1000);

  test("handles revision_requested by resubmitting the same hire request before approval", async ({
    page,
  }) => {
    const suffix = Date.now();
    const companyName = `Hermes Revision ${suffix}`;
    const workerName = `HermesRevisionWorker${suffix}`;
    const revisionToken = `REVISION_ACCEPTED_${suffix}`;

    const { baseUrl, company, ceoAgent } = await createHermesCompanyAndCeo(page, {
      companyName,
      ceoTaskTitle: `Hire ${workerName}`,
      ceoTaskBody: [
        `Create exactly one subordinate agent named ${workerName}.`,
        "Requirements:",
        "- Use the Paperclip hire flow so the board can review the request.",
        "- adapterType must be hermes_local.",
        `- model should be ${HERMES_MODEL} when possible.`,
        "- role should be engineer.",
        "- reportsTo should be yourself.",
        "- capabilities should start as \"Initial revision scope\".",
        "- Do not create extra agents or duplicate approvals.",
        `- If the board requests revision, update the same hire approval so capabilities contains exactly \"${revisionToken}\" and then resubmit it.`,
        "- After resubmitting, wait for the board decision.",
      ].join("\n"),
    });

    const approvalId = await waitForHireApproval(page, {
      baseUrl,
      companyId: company.id,
      ceoAgentId: ceoAgent.id,
      workerName,
    });

    const revisionComment = `Revision requested: keep the same worker, but change capabilities to exactly "${revisionToken}" before resubmitting.`;
    await postApprovalCommentViaUi(page, {
      baseUrl,
      issuePrefix: company.issuePrefix,
      approvalId,
      comment: revisionComment,
    });

    await page.getByRole("button", { name: "Request revision" }).click();
    await waitForApproval(page, baseUrl, approvalId, (approval) => approval.status === "revision_requested");

    const resubmittedApproval = await waitForApproval(
      page,
      baseUrl,
      approvalId,
      (approval) =>
        approval.status === "pending" &&
        typeof (approval.payload as { capabilities?: unknown })?.capabilities === "string" &&
        ((approval.payload as { capabilities?: string }).capabilities ?? "").includes(revisionToken),
    );

    expect((resubmittedApproval.payload as { capabilities?: string }).capabilities).toContain(
      revisionToken,
    );

    await page.goto(`${baseUrl}/${company.issuePrefix}/approvals/${approvalId}`);
    await expect(page.getByRole("button", { name: "Approve" })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole("button", { name: "Approve" }).click();
    await expect(page.getByText("Approval confirmed")).toBeVisible({ timeout: 20_000 });

    const workerAgentId = await waitForWorkerAgent(page, {
      baseUrl,
      companyId: company.id,
      workerName,
    });

    const workerAgentRes = await page.request.get(`${baseUrl}/api/agents/${workerAgentId}`);
    expect(workerAgentRes.ok()).toBe(true);
    const workerAgent = await workerAgentRes.json();
    expect(workerAgent.status).toBe("idle");
    expect(workerAgent.adapterType).toBe("hermes_local");
  });

  test("handles rejected hire requests without creating a working agent and prompts the requester to stop", async ({
    page,
  }) => {
    const suffix = Date.now();
    const companyName = `Hermes Reject ${suffix}`;
    const workerName = `HermesRejectWorker${suffix}`;
    const rejectToken = `REJECT_ACK_${suffix}`;

    const { baseUrl, company, ceoAgent, ceoIssueId } = await createHermesCompanyAndCeo(page, {
      companyName,
      ceoTaskTitle: `Hire ${workerName}`,
      ceoTaskBody: [
        `Create exactly one subordinate agent named ${workerName}.`,
        "Requirements:",
        "- Use the Paperclip hire flow so the board can review the request.",
        "- adapterType must be hermes_local.",
        `- model should be ${HERMES_MODEL} when possible.`,
        "- role should be engineer.",
        "- reportsTo should be yourself.",
        "- Do not create extra agents or duplicate approvals.",
        `- If the board rejects the hire, comment on the original issue with exactly "${rejectToken}" and stop without creating another hire request.`,
      ].join("\n"),
    });

    const approvalId = await waitForHireApproval(page, {
      baseUrl,
      companyId: company.id,
      ceoAgentId: ceoAgent.id,
      workerName,
    });

    const rejectComment = `Reject this hire for now. Reply on the original issue with exactly "${rejectToken}" and do not resubmit or create another hire request unless asked.`;
    await postApprovalCommentViaUi(page, {
      baseUrl,
      issuePrefix: company.issuePrefix,
      approvalId,
      comment: rejectComment,
    });

    await page.getByRole("button", { name: "Reject" }).click();
    await waitForApproval(page, baseUrl, approvalId, (approval) => approval.status === "rejected");

    await expect
      .poll(
        async () => {
          const commentsRes = await page.request.get(`${baseUrl}/api/issues/${ceoIssueId}/comments`);
          if (!commentsRes.ok()) return false;
          const comments = await commentsRes.json();
          return comments.some(
            (comment: { body?: string | null }) =>
              typeof comment.body === "string" && comment.body.includes(rejectToken),
          );
        },
        {
          timeout: 4 * 60 * 1000,
          intervals: [5_000, 10_000],
        },
      )
      .toBe(true);

    await expect
      .poll(
        async () => {
          const approvalsRes = await page.request.get(
            `${baseUrl}/api/companies/${company.id}/approvals?status=pending`,
          );
          if (!approvalsRes.ok()) return -1;
          const approvals = await approvalsRes.json();
          return approvals.filter(
            (entry: { payload?: { name?: string } }) => entry.payload?.name === workerName,
          ).length;
        },
        {
          timeout: 30_000,
          intervals: [2_000, 5_000],
        },
      )
      .toBe(0);

    const agentsRes = await page.request.get(`${baseUrl}/api/companies/${company.id}/agents`);
    expect(agentsRes.ok()).toBe(true);
    const agents = await agentsRes.json();
    const matchingAgents = agents.filter((entry: { name: string }) => entry.name === workerName);
    expect(
      matchingAgents.every(
        (entry: { status: string }) =>
          entry.status === "terminated" || entry.status === "pending_approval",
      ),
    ).toBe(true);
  });
});
