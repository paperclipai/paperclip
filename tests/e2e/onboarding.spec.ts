import { test, expect } from "@playwright/test";

/**
 * E2E: Onboarding wizard flow (skip_llm mode).
 *
 * Walks through the 4-step OnboardingWizard:
 *   Step 1 — Name your company
 *   Step 2 — Create your first agent (adapter selection + config)
 *   Step 3 — Give it something to do (task creation)
 *   Step 4 — Ready to launch (summary + open issue)
 *
 * By default this runs in skip_llm mode: we do NOT assert that an LLM
 * heartbeat fires. Set PAPERCLIP_E2E_SKIP_LLM=false to enable LLM-dependent
 * assertions (requires a valid ANTHROPIC_API_KEY).
 */

const SKIP_LLM = process.env.PAPERCLIP_E2E_SKIP_LLM !== "false";

const COMPANY_NAME = `E2E-Test-${Date.now()}`;
const AGENT_NAME = "CEO";
const TASK_TITLE = "E2E test task";

test.describe("Onboarding wizard", () => {
  test("completes full wizard flow", async ({ page }) => {
    await page.goto("/");

    const wizardHeading = page.locator("h3", { hasText: "Name your company" });
    const newCompanyBtn = page.getByRole("button", { name: "New Company" });

    await expect(
      wizardHeading.or(newCompanyBtn)
    ).toBeVisible({ timeout: 15_000 });

    if (await newCompanyBtn.isVisible()) {
      await newCompanyBtn.click();
    }

    await expect(wizardHeading).toBeVisible({ timeout: 5_000 });

    const companyNameInput = page.locator('input[placeholder="Acme Corp"]');
    await companyNameInput.fill(COMPANY_NAME);

    const nextButton = page.getByRole("button", { name: "Next" });
    await nextButton.click();

    await expect(
      page.locator("h3", { hasText: "Create your first agent" })
    ).toBeVisible({ timeout: 10_000 });

    const agentNameInput = page.locator('input[placeholder="CEO"]');
    await expect(agentNameInput).toHaveValue(AGENT_NAME);

    await expect(
      page.locator("button", { hasText: "Claude Code" }).locator("..")
    ).toBeVisible();

    await page.getByRole("button", { name: "More Agent Adapter Types" }).click();
    await page.getByRole("button", { name: "Process" }).click();

    const commandInput = page.locator('input[placeholder="e.g. node, python"]');
    await commandInput.fill("echo");
    const argsInput = page.locator(
      'input[placeholder="e.g. script.js, --flag"]'
    );
    await argsInput.fill("hello");

    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.locator("h3", { hasText: "Give it something to do" })
    ).toBeVisible({ timeout: 10_000 });

    const taskTitleInput = page.locator(
      'input[placeholder="e.g. Research competitor pricing"]'
    );
    await taskTitleInput.clear();
    await taskTitleInput.fill(TASK_TITLE);

    await page.getByRole("button", { name: "Next" }).click();

    await expect(
      page.locator("h3", { hasText: "Ready to launch" })
    ).toBeVisible({ timeout: 10_000 });

    await expect(page.locator("text=" + COMPANY_NAME)).toBeVisible();
    await expect(page.locator("text=" + AGENT_NAME)).toBeVisible();
    await expect(page.locator("text=" + TASK_TITLE)).toBeVisible();

    await page.getByRole("button", { name: "Create & Open Issue" }).click();

    await expect(page).toHaveURL(/\/issues\//, { timeout: 10_000 });

    const issueId = page.url().match(/\/issues\/([^/?#]+)/)?.[1];
    expect(issueId).toBeTruthy();

    const baseUrl = page.url().split("/").slice(0, 3).join("/");

    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const company = companies.find(
      (c: { name: string }) => c.name === COMPANY_NAME
    );
    expect(company).toBeTruthy();

    const agentsRes = await page.request.get(
      `${baseUrl}/api/companies/${company.id}/agents`
    );
    expect(agentsRes.ok()).toBe(true);
    const agents = await agentsRes.json();
    const ceoAgent = agents.find(
      (a: { name: string }) => a.name === AGENT_NAME
    );
    expect(ceoAgent).toBeTruthy();
    expect(ceoAgent.role).toBe("ceo");
    expect(ceoAgent.adapterType).toBe("process");

    const issuesRes = await page.request.get(
      `${baseUrl}/api/companies/${company.id}/issues`
    );
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json();
    const task = issues.find(
      (i: { id: string; title: string }) =>
        i.id === issueId || i.title === TASK_TITLE
    );
    expect(task).toBeTruthy();
    expect(task.assigneeAgentId).toBe(ceoAgent.id);

    if (!SKIP_LLM) {
      await expect(async () => {
        const res = await page.request.get(
          `${baseUrl}/api/issues/${task.id}`
        );
        const issue = await res.json();
        expect(["in_progress", "done"]).toContain(issue.status);
      }).toPass({ timeout: 120_000, intervals: [5_000] });
    }
  });

  test("inserts selected @mentions into issue comments", async ({ page }) => {
    const companyName = `E2E-Test-mentions-${Date.now()}`;
    const taskTitle = "E2E test task mentions";
    const companyRes = await page.request.post("/api/companies", {
      data: { name: companyName },
    });
    expect(companyRes.ok()).toBe(true);
    const company = await companyRes.json();

    const agentRes = await page.request.post(`/api/companies/${company.id}/agents`, {
      data: {
        name: AGENT_NAME,
        role: "ceo",
        adapterType: "process",
        adapterConfig: {
          command: "echo",
          args: ["hello"],
          timeoutSec: 0,
          graceSec: 15,
        },
      },
    });
    expect(agentRes.ok()).toBe(true);
    const agent = await agentRes.json();

    const issueRes = await page.request.post(`/api/companies/${company.id}/issues`, {
      data: {
        title: taskTitle,
        assigneeAgentId: agent.id,
      },
    });
    expect(issueRes.ok()).toBe(true);
    const issue = await issueRes.json();

    await page.goto(`/${company.issuePrefix}/issues/${issue.id}`);
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/issues/${issue.id}$`));

    const commentEditor = page.locator('[contenteditable="true"]').last();
    await commentEditor.click();
    await page.keyboard.type("@CE");

    const mentionOption = page.getByRole("button", { name: /^@ CEO$/ });
    await expect(mentionOption).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press("Tab");
    await expect(mentionOption).toBeHidden({ timeout: 10_000 });

    await page.keyboard.type("hello");
    await page.getByRole("button", { name: "Comment" }).click();

    await expect(async () => {
      const commentsRes = await page.request.get(`/api/issues/${issue.id}/comments`);
      expect(commentsRes.ok()).toBe(true);
      const comments = await commentsRes.json();
      const latestComment = comments.at(-1);
      expect(latestComment?.body).toBe("@CEO hello");
    }).toPass({ timeout: 10_000, intervals: [500] });
  });
});
