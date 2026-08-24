import { expect, test, type Page } from "@playwright/test";

const ADMIN_EMAIL =
  process.env.PAPERCLIP_RELEASE_SMOKE_EMAIL ??
  process.env.SMOKE_ADMIN_EMAIL ??
  "smoke-admin@paperclip.local";
const ADMIN_PASSWORD =
  process.env.PAPERCLIP_RELEASE_SMOKE_PASSWORD ??
  process.env.SMOKE_ADMIN_PASSWORD ??
  "paperclip-smoke-password";

const COMPANY_NAME = `Release-Smoke-${Date.now()}`;
const MISSION = "Ship a reliable release smoke suite for Paperclip.";
const AGENT_NAME = "CEO";
// Seeded by the wizard's launch step (DEFAULT_TASK_TITLE in
// ui/src/components/OnboardingWizard.tsx).
const FIRST_TASK_TITLE = "Paperclip onboarding";

async function signIn(page: Page) {
  await page.goto("/");
  await expect(page).toHaveURL(/\/auth/);

  await page.locator('input[type="email"]').fill(ADMIN_EMAIL);
  await page.locator('input[type="password"]').fill(ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign In" }).click();

  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
}

async function openOnboarding(page: Page) {
  const wizardHeading = page.locator("h3", { hasText: "Name your organization" });
  const startButton = page.getByRole("button", { name: "Start Onboarding" });

  await expect(wizardHeading.or(startButton)).toBeVisible({ timeout: 20_000 });

  if (await startButton.isVisible()) {
    await startButton.click();
  }

  await expect(wizardHeading).toBeVisible({ timeout: 10_000 });
}

test.describe("Docker authenticated onboarding smoke", () => {
  test("logs in, completes onboarding, and hires the lead agent", async ({
    page,
  }) => {
    await signIn(page);
    await openOnboarding(page);

    // Step 1: name the company.
    await page.locator('input[placeholder="Acme Corp"]').fill(COMPANY_NAME);
    await page.getByRole("button", { name: "Next" }).click();

    // Step 2: define the mission directly; confirming creates the company.
    await expect(
      page.locator("h3", { hasText: "Define your mission" })
    ).toBeVisible({ timeout: 10_000 });
    await page.getByRole("button", { name: "I know my mission" }).click();
    await page
      .locator('textarea[placeholder="What is your team trying to achieve?"]')
      .fill(MISSION);
    await page.getByRole("button", { name: "Confirm mission" }).click();

    // Step 3: give the team lead a role, then a name. The role gates "Next".
    const roleSelect = page.locator("#onboarding-agent-role");
    await expect(roleSelect).toBeVisible({ timeout: 20_000 });
    await roleSelect.click();
    await page.getByRole("option", { name: "CEO", exact: true }).click();
    await page.locator("#onboarding-agent-name").fill(AGENT_NAME);
    await page.getByRole("button", { name: "Next" }).click();

    // Step 4: keep the default adapter and connect (hire) the lead. The
    // adapter environment check runs inside the smoke container, where no
    // agent CLIs are installed; an unhealthy report is expected and must not
    // block the hire. Allow generous time for the env probe + hire +
    // auto-approval.
    const connectButton = page.getByRole("button", { name: "Connect" });
    await expect(connectButton).toBeVisible({ timeout: 10_000 });
    await expect(connectButton).toBeEnabled({ timeout: 30_000 });
    await connectButton.click();

    // Step 5: review, then launch. "Get started" provisions the onboarding
    // goal/project/first task and, only on success, drops the user into the
    // seeded first task's thread (not the dashboard).
    const getStartedButton = page.getByRole("button", { name: "Get started" });
    await expect(getStartedButton).toBeVisible({ timeout: 60_000 });
    await expect(getStartedButton).toBeEnabled({ timeout: 10_000 });
    await getStartedButton.click();
    await expect(page).toHaveURL(/\/issues\//, { timeout: 30_000 });

    const baseUrl = new URL(page.url()).origin;

    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = (await companiesRes.json()) as Array<{ id: string; name: string }>;
    const company = companies.find((entry) => entry.name === COMPANY_NAME);
    expect(company).toBeTruthy();

    const agentsRes = await page.request.get(
      `${baseUrl}/api/companies/${company!.id}/agents`
    );
    expect(agentsRes.ok()).toBe(true);
    const agents = (await agentsRes.json()) as Array<{
      id: string;
      name: string;
      role: string;
      adapterType: string;
    }>;
    const ceoAgent = agents.find((entry) => entry.name === AGENT_NAME);
    expect(ceoAgent).toBeTruthy();
    expect(ceoAgent!.role).toBe("ceo");
    expect(ceoAgent!.adapterType).not.toBe("process");

    const goalsRes = await page.request.get(
      `${baseUrl}/api/companies/${company!.id}/goals`
    );
    expect(goalsRes.ok()).toBe(true);
    const goals = (await goalsRes.json()) as Array<{
      id: string;
      title: string;
      level: string;
      status: string;
    }>;
    expect(goals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: MISSION,
          level: "company",
          status: "active",
        }),
      ])
    );

    const issuesRes = await page.request.get(
      `${baseUrl}/api/companies/${company!.id}/issues`
    );
    expect(issuesRes.ok()).toBe(true);
    const issues = (await issuesRes.json()) as Array<{
      id: string;
      identifier: string | null;
      title: string;
      assigneeAgentId: string | null;
    }>;
    const seededIssue = issues.find((entry) => entry.title === FIRST_TASK_TITLE);
    expect(seededIssue).toBeTruthy();
    expect(seededIssue!.assigneeAgentId).toBe(ceoAgent!.id);

    // The launch must have landed on the seeded task itself, not merely on
    // some issue route.
    const seededRef = seededIssue!.identifier ?? seededIssue!.id;
    expect(new URL(page.url()).pathname.endsWith(`/issues/${seededRef}`)).toBe(
      true
    );

    await expect.poll(
      async () => {
        const runsRes = await page.request.get(
          `${baseUrl}/api/companies/${company!.id}/heartbeat-runs?agentId=${ceoAgent!.id}`
        );
        expect(runsRes.ok()).toBe(true);
        const runs = (await runsRes.json()) as Array<{
          agentId: string;
          invocationSource: string;
          status: string;
        }>;
        const latestRun = runs.find((entry) => entry.agentId === ceoAgent!.id);
        return latestRun
          ? {
              invocationSource: latestRun.invocationSource,
              status: latestRun.status,
            }
          : null;
      },
      {
        timeout: 30_000,
        intervals: [1_000, 2_000, 5_000],
      }
    ).toEqual(
      expect.objectContaining({
        invocationSource: "assignment",
        status: expect.stringMatching(/^(queued|running|succeeded|failed)$/),
      })
    );
  });
});
