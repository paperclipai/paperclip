import { test, expect } from "@playwright/test";

/**
 * E2E: Onboarding wizard flow (skip_llm mode).
 *
 * Walks through the 5-step OnboardingWizard:
 *   Step 1 — Set up your company (fresh or import)
 *   Step 2 — Create your first agent (adapter selection + config)
 *   Step 3 — Link a workspace (optional, can skip)
 *   Step 4 — Review your team (org chart confirmation)
 *   Step 5 — Launch with a task (task creation + summary + open issue)
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
    await page.goto("/onboarding");

    const wizardHeading = page.locator("h3", { hasText: "Set up your company" });
    const newCompanyBtn = page.getByRole("button", { name: "New Company" });

    await expect(
      wizardHeading.or(newCompanyBtn)
    ).toBeVisible({ timeout: 15_000 });

    if (await newCompanyBtn.isVisible()) {
      await newCompanyBtn.click();
    }

    await expect(wizardHeading).toBeVisible({ timeout: 5_000 });

    // Ensure "Start fresh" mode is selected by default
    await expect(
      page.locator("button", { hasText: "Start fresh" })
    ).toBeVisible();

    const companyNameInput = page.locator('input[placeholder="Acme Corp"]');
    await companyNameInput.fill(COMPANY_NAME);

    const nextButton = page.getByRole("button", { name: "Next" });
    await nextButton.click();

    // After company creation, a Linear connect prompt may appear — skip it
    const skipLinear = page.getByRole("button", { name: /Skip for now|Skip import/ });
    const agentHeading = page.locator("h3", { hasText: "Create your first agent" });
    await expect(skipLinear.or(agentHeading)).toBeVisible({ timeout: 10_000 });
    if (await skipLinear.isVisible()) {
      await skipLinear.click();
    }

    // Step 2: Agent
    await expect(agentHeading).toBeVisible({ timeout: 10_000 });

    const agentNameInput = page.locator('input[placeholder="CEO"]');
    await expect(agentNameInput).toHaveValue(AGENT_NAME);

    await expect(
      page.locator("button", { hasText: "Claude Code" }).locator("..")
    ).toBeVisible();

    await page.getByRole("button", { name: "More Agent Adapter Types" }).click();
    await expect(page.getByRole("button", { name: "Process" })).toHaveCount(0);

    await page.getByRole("button", { name: "Next" }).click();

    // Step 3: Workspace — skip it
    await expect(
      page.locator("h3", { hasText: "Link a workspace" })
    ).toBeVisible({ timeout: 10_000 });

    const baseUrl = page.url().split("/").slice(0, 3).join("/");
    if (SKIP_LLM) {
      const companiesAfterAgentRes = await page.request.get(`${baseUrl}/api/companies`);
      expect(companiesAfterAgentRes.ok()).toBe(true);
      const companiesAfterAgent = await companiesAfterAgentRes.json();
      const companyAfterAgent = companiesAfterAgent.find(
        (c: { name: string }) => c.name === COMPANY_NAME
      );
      expect(companyAfterAgent).toBeTruthy();

      const agentsAfterCreateRes = await page.request.get(
        `${baseUrl}/api/companies/${companyAfterAgent.id}/agents`
      );
      expect(agentsAfterCreateRes.ok()).toBe(true);
      const agentsAfterCreate = await agentsAfterCreateRes.json();
      const ceoAgentAfterCreate = agentsAfterCreate.find(
        (a: { name: string }) => a.name === AGENT_NAME
      );
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
        }
      );
      expect(disableWakeRes.ok()).toBe(true);
    }

    await page.getByRole("button", { name: "Skip" }).click();

    // Step 4: Team review
    await expect(
      page.locator("h3", { hasText: "Review your team" })
    ).toBeVisible({ timeout: 10_000 });

    await page.getByRole("button", { name: "Next" }).click();

    // Step 5: Task + Launch
    await expect(
      page.locator("h3", { hasText: "Launch with a task" })
    ).toBeVisible({ timeout: 10_000 });

    const taskTitleInput = page.locator(
      'input[placeholder="e.g. Review the codebase and create a roadmap"]'
    );
    await taskTitleInput.clear();
    await taskTitleInput.fill(TASK_TITLE);

    // Use data-slot to distinguish the submit button from the progress tab
    await page.locator('button[data-slot="button"]', { hasText: "Launch" }).click();

    await expect(page).toHaveURL(/\/issues\//, { timeout: 30_000 });

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
    expect(ceoAgent.adapterType).not.toBe("process");

    const instructionsBundleRes = await page.request.get(
      `${baseUrl}/api/agents/${ceoAgent.id}/instructions-bundle?companyId=${company.id}`
    );
    expect(instructionsBundleRes.ok()).toBe(true);
    const instructionsBundle = await instructionsBundleRes.json();
    expect(
      instructionsBundle.files.map((file: { path: string }) => file.path).sort()
    ).toEqual(["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"]);

    const issuesRes = await page.request.get(
      `${baseUrl}/api/companies/${company.id}/issues`
    );
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json();
    const task = issues.find(
      (i: { title: string }) => i.title === TASK_TITLE
    );
    expect(task).toBeTruthy();
    expect(task.assigneeAgentId).toBe(ceoAgent.id);
    // Without a workspace scan, the default description is used
    expect(task.description).toContain(
      "You are the CEO. You set the direction for the company."
    );
    expect(task.description).not.toContain("github.com/paperclipai/companies");

    if (!SKIP_LLM) {
      await expect(async () => {
        const res = await page.request.get(
          `${baseUrl}/api/issues/${task.id}`
        );
        const issue = await res.json();
        expect(["in_progress", "done"]).toContain(issue.status);
      }).toPass({ timeout: 120_000, intervals: [5_000] });
    } else {
      await expect
        .poll(async () => {
          const runsRes = await page.request.get(
            `${baseUrl}/api/companies/${company.id}/heartbeat-runs?agentId=${ceoAgent.id}`
          );
          expect(runsRes.ok()).toBe(true);
          const runs = await runsRes.json();
          return Array.isArray(runs) ? runs.length : -1;
        }, { timeout: 10_000, intervals: [500, 1_000, 2_000] })
        .toBe(0);
    }
  });
});
