import { expect, test } from "@playwright/test";

const SKIP_LLM = process.env.PAPERCLIP_E2E_SKIP_LLM !== "false";

const AGENT_NAME = "CEO";
const TASK_TITLE = "PAP-3413 planning mode evidence";

test("captures planning mode UI for desktop and mobile", async ({ page }) => {
  const timestamp = Date.now();
  const companyName = `PAP-3413-${timestamp}`;
  const screenshotDir = "test-results/planning-mode";

  await page.goto("/onboarding");

  const wizardHeading = page.locator("h3", { hasText: "Set up your company" });
  const newCompanyBtn = page.getByRole("button", { name: "New Company" });
  await expect(wizardHeading.or(newCompanyBtn)).toBeVisible({ timeout: 15_000 });
  if (await newCompanyBtn.isVisible()) {
    await newCompanyBtn.click();
  }
  await expect(wizardHeading).toBeVisible({ timeout: 5_000 });

  await page.locator('input[placeholder="Acme Corp"]').fill(companyName);
  await page.getByRole("button", { name: "Next" }).click();

  // After company creation, a Linear connect prompt may appear — skip it
  const skipLinear = page.getByRole("button", { name: /Skip for now|Skip import/ });
  const agentHeading = page.locator("h3", { hasText: "Create your first agent" });
  await expect(skipLinear.or(agentHeading)).toBeVisible({ timeout: 10_000 });
  if (await skipLinear.isVisible()) {
    await skipLinear.click();
  }

  await expect(agentHeading).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('input[placeholder="CEO"]')).toHaveValue(AGENT_NAME);
  await page.getByRole("button", { name: "Next" }).click();

  // Step 3: Workspace — skip it
  await expect(page.locator("h3", { hasText: "Link a workspace" })).toBeVisible({ timeout: 10_000 });
  const baseUrl = page.url().split("/").slice(0, 3).join("/");

  if (SKIP_LLM) {
    const companiesAfterAgentRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesAfterAgentRes.ok()).toBe(true);
    const companiesAfterAgent = await companiesAfterAgentRes.json();
    const companyAfterAgent = companiesAfterAgent.find((c: { name: string }) => c.name === companyName);
    expect(companyAfterAgent).toBeTruthy();

    const agentsAfterCreateRes = await page.request.get(`${baseUrl}/api/companies/${companyAfterAgent.id}/agents`);
    expect(agentsAfterCreateRes.ok()).toBe(true);
    const agentsAfterCreate = await agentsAfterCreateRes.json();
    const ceoAgentAfterCreate = agentsAfterCreate.find((a: { name: string }) => a.name === AGENT_NAME);
    expect(ceoAgentAfterCreate).toBeTruthy();

    const disableWakeRes = await page.request.patch(
      `${baseUrl}/api/agents/${ceoAgentAfterCreate.id}?companyId=${encodeURIComponent(companyAfterAgent.id)}`,
      {
        data: {
          runtimeConfig: {
            heartbeat: {
              enabled: false,
              intervalSec: 300,
              wakeOnDemand: false,
              cooldownSec: 10,
              maxConcurrentRuns: 5,
            },
          },
        },
      },
    );
    expect(disableWakeRes.ok()).toBe(true);
  }

  // Skip workspace, advance through Review your team
  await page.getByRole("button", { name: "Skip" }).click();
  await expect(page.locator("h3", { hasText: "Review your team" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Next" }).click();

  await expect(page.locator("h3", { hasText: "Launch with a task" })).toBeVisible({ timeout: 30_000 });
  const taskTitleInput = page.locator('input[placeholder="e.g. Review the codebase and create a roadmap"]');
  await taskTitleInput.clear();
  await taskTitleInput.fill(TASK_TITLE);
  await page.locator('button[data-slot="button"]', { hasText: "Launch" }).click();
  await expect(page).toHaveURL(/\/issues\//, { timeout: 30_000 });

  const openedIssueUrl = page.url();
  const openedIssueIdentifier = openedIssueUrl.split("/").filter(Boolean).pop();
  const baseOrigin = new URL(openedIssueUrl).origin;
  const companyRes = await page.request.get(`${baseOrigin}/api/companies`);
  expect(companyRes.ok()).toBe(true);
  const companies = await companyRes.json();
  const company = companies.find((c: { name: string }) => c.name === companyName);
  expect(company).toBeTruthy();
  const issueRes = await page.request.get(`${baseOrigin}/api/companies/${company.id}/issues`);
  expect(issueRes.ok()).toBe(true);
  const issues = await issueRes.json();
  const planningSeedIssue = issues.find(
    (candidate: { id: string; identifier?: string; title: string }) =>
      candidate.identifier === openedIssueIdentifier || candidate.id === openedIssueIdentifier || candidate.title === TASK_TITLE,
  );
  expect(planningSeedIssue).toBeTruthy();

  const issue = planningSeedIssue;
  const issueIdentifier = issue.identifier ?? issue.id;
  const issuePath = `/${company.issuePrefix ?? company.id}/issues/${issueIdentifier}`;
  const companyPrefix = company.issuePrefix ?? company.id;
  const issueLinkSelector = `a[href$="/issues/${issueIdentifier}"]`;

  const setMode = async (mode: "standard" | "planning") => {
    const patchRes = await page.request.patch(`${baseOrigin}/api/issues/${issue.id}`, {
      data: { workMode: mode },
    });
    expect(patchRes.ok()).toBe(true);
    await expect
      .poll(async () => {
        const currentRes = await page.request.get(`${baseOrigin}/api/issues/${issue.id}`);
        expect(currentRes.ok()).toBe(true);
        const current = await currentRes.json();
        return current.workMode;
      }, { timeout: 10_000 })
      .toBe(mode);
  };

  await setMode("planning");

  await page.goto(issuePath);
  await expect(page.getByText("Planning").first()).toBeVisible();
  await expect(page.getByTestId("issue-chat-composer")).toHaveAttribute("data-pending-work-mode", "planning");
  const desktopPlanningToggle = page.getByTestId("issue-chat-composer-work-mode-toggle");
  await expect(desktopPlanningToggle).toBeVisible();
  await expect(desktopPlanningToggle).toHaveAttribute("data-pending-work-mode", "planning");
  await expect(desktopPlanningToggle).toHaveAttribute("aria-pressed", "true");

  await page.screenshot({
    path: `${screenshotDir}/desktop-planning-detail-${timestamp}.png`,
    fullPage: true,
  });

  await page.goto(`/${companyPrefix}/issues`);
  await expect(page.locator(issueLinkSelector)).toBeVisible();
  await expect(page.locator(issueLinkSelector)).not.toContainText("Planning");
  await page.screenshot({
    path: `${screenshotDir}/desktop-planning-row-${timestamp}.png`,
    fullPage: true,
  });

  await page.goto(issuePath);
  await page.getByTestId("issue-chat-composer-work-mode-toggle").click();
  await expect(page.getByTestId("issue-chat-composer")).toHaveAttribute("data-pending-work-mode", "standard");
  await expect(page.getByTestId("issue-chat-composer-work-mode-toggle")).toBeHidden();
  await page.screenshot({
    path: `${screenshotDir}/desktop-standard-toggle-${timestamp}.png`,
    fullPage: true,
  });

  await setMode("planning");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(issuePath);
  await expect(page.getByText("Planning").first()).toBeVisible();
  const mobilePlanningToggle = page.getByTestId("issue-chat-composer-work-mode-toggle");
  await expect(mobilePlanningToggle).toBeVisible();
  await expect(mobilePlanningToggle).toHaveAttribute("data-pending-work-mode", "planning");
  await expect(mobilePlanningToggle).toHaveAttribute("aria-pressed", "true");
  await page.screenshot({
    path: `${screenshotDir}/mobile-planning-detail-${timestamp}.png`,
    fullPage: true,
  });

  await page.goto(`/${companyPrefix}/issues`);
  await expect(page.locator(issueLinkSelector)).toBeVisible();
  await expect(page.locator(issueLinkSelector)).not.toContainText("Planning");
  await page.screenshot({
    path: `${screenshotDir}/mobile-planning-row-${timestamp}.png`,
    fullPage: true,
  });
});
