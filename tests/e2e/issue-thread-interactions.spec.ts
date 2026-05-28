import { test, expect, request as pwRequest, type APIRequestContext } from "@playwright/test";

const BASE_URL = process.env.BIZBOX_E2E_BASE_URL ?? "http://127.0.0.1:3199";

type TestContext = {
  boardRequest: APIRequestContext;
  companyId: string;
  companyPrefix: string;
  issueId: string;
  issueIdentifier: string;
  interactionId: string;
};

async function createCompany(boardRequest: APIRequestContext, name: string) {
  const companyRes = await boardRequest.post(`${BASE_URL}/api/companies`, {
    data: { name },
  });
  expect(companyRes.ok()).toBe(true);
  return companyRes.json() as Promise<{ id: string; issuePrefix: string }>;
}

async function createIssue(boardRequest: APIRequestContext, companyId: string) {
  const issueRes = await boardRequest.post(`${BASE_URL}/api/companies/${companyId}/issues`, {
    data: {
      title: "Decline freeze repro",
      status: "in_progress",
      assigneeUserId: "local-board",
    },
  });
  expect(issueRes.ok()).toBe(true);
  return issueRes.json() as Promise<{ id: string; identifier: string }>;
}

async function createRequestConfirmation(
  boardRequest: APIRequestContext,
  issueId: string,
) {
  const interactionRes = await boardRequest.post(`${BASE_URL}/api/issues/${issueId}/interactions`, {
    data: {
      kind: "request_confirmation",
      continuationPolicy: "wake_assignee",
      payload: {
        version: 1,
        prompt: "Approve the plan?",
        acceptLabel: "Approve plan",
        rejectLabel: "Decline",
        rejectRequiresReason: true,
        allowDeclineReason: true,
        declineReasonPlaceholder: "Explain what needs to change.",
      },
    },
  });
  expect(interactionRes.ok()).toBe(true);
  return interactionRes.json() as Promise<{ id: string }>;
}

test.describe("issue thread interactions", () => {
  let ctx: TestContext;

  test.beforeAll(async () => {
    ctx = {} as TestContext;
    ctx.boardRequest = await pwRequest.newContext({ baseURL: BASE_URL });
    const company = await createCompany(ctx.boardRequest, `Decline-Repro-${Date.now()}`);
    ctx.companyId = company.id;
    ctx.companyPrefix = company.issuePrefix;
    const issue = await createIssue(ctx.boardRequest, ctx.companyId);
    ctx.issueId = issue.id;
    ctx.issueIdentifier = issue.identifier;
    const interaction = await createRequestConfirmation(ctx.boardRequest, ctx.issueId);
    ctx.interactionId = interaction.id;
  });

  test.afterAll(async () => {
    if (!ctx) return;
    await ctx.boardRequest.patch(`${BASE_URL}/api/issues/${ctx.issueId}`, {
      data: { status: "cancelled", comment: "Cleanup for decline repro test." },
    }).catch(() => undefined);
    await ctx.boardRequest.delete(`${BASE_URL}/api/companies/${ctx.companyId}`).catch(() => undefined);
    await ctx.boardRequest.dispose();
  });

  test("decline flow completes without freezing", async ({ page }) => {
    await page.goto(`/${ctx.companyPrefix}/issues/${ctx.issueIdentifier}`);
    await expect(page.getByText("Approve the plan?")).toBeVisible({ timeout: 15_000 });

    const declineButtons = page.getByRole("button", { name: "Decline" });
    await expect(declineButtons.first()).toBeVisible();
    await declineButtons.first().click({ force: true });

    const textarea = page.locator("textarea");
    await expect(textarea).toBeVisible({ timeout: 10_000 });
    await textarea.fill("Needs a smaller phase split.");

    const rejectResponse = page.waitForResponse((response) =>
      response.request().method() === "POST"
      && response.url().includes(`/api/issues/${ctx.issueId}/interactions/${ctx.interactionId}/reject`)
      && response.status() === 200,
    );

    await declineButtons.last().click({ force: true });
    await rejectResponse;

    await expect(textarea).toHaveCount(0);
    await expect(page.getByText("Request declined")).toBeVisible({ timeout: 15_000 });
  });
});
