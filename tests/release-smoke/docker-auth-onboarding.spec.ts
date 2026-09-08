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
const AGENT_NAME = "Release Smoke Lead";
// The arc asks for a name, not a role, so every onboarding hire is filed under
// the neutral role (DEFAULT_AGENT_ROLE in ui/src/lib/onboarding-agent-role.ts).
const AGENT_ROLE = "general";
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

async function getJson<T>(page: Page, url: string): Promise<T> {
  const response = await page.request.get(url);
  expect(response.ok()).toBe(true);
  return (await response.json()) as T;
}

// ONBOARDING_STORAGE_KEY in ui/src/components/OnboardingWizard.tsx.
const ONBOARDING_DRAFT_STORAGE_KEY = "paperclip-onboarding-state";

/**
 * Open the wizard on its first step and hand back the organization-name field.
 *
 * `/onboarding` resolves to `{ initialStep: 1 }` on a self-hosted instance
 * (`resolveRouteOnboardingOptions`) and the route keeps the wizard open, so
 * this lands on "name your organization" whether or not the instance already
 * holds a company. Navigating explicitly is what keeps the spec re-runnable:
 * the release-smoke config retries once in CI, and by the second attempt the
 * instance is no longer company-less, so sign-in lands on a dashboard instead.
 *
 * The saved draft is dropped first. Sign-in on an instance that already holds
 * an agentless company redirects into *that* company's onboarding, which
 * persists its id into the draft; the restored draft then makes step 1 skip
 * creating a company and hire into the old one instead. That is an artifact of
 * re-running against a re-used instance, not behaviour this spec is asserting,
 * and a fresh release-smoke container never has it.
 *
 * The field is located by role. Step 1 has no id and its `<label>` is not
 * associated with the input, so the alternative is its placeholder copy — the
 * exact coupling that let this spec drift. The wizard's first screen has
 * exactly one text box, and a second one appearing there would fail Playwright's
 * strict mode loudly rather than silently matching the wrong control.
 */
async function openOnboarding(page: Page) {
  await page.evaluate((key) => {
    window.localStorage.removeItem(key);
  }, ONBOARDING_DRAFT_STORAGE_KEY);
  await page.goto("/onboarding");

  const orgNameField = page.getByRole("textbox");
  await expect(orgNameField).toBeVisible({ timeout: 20_000 });
  return orgNameField;
}

test.describe("Docker authenticated onboarding smoke", () => {
  test("logs in, completes onboarding, and hires the lead agent", async ({
    page,
  }) => {
    await signIn(page);

    const baseUrl = new URL(page.url()).origin;

    // A board with no company routes sign-in straight into onboarding rather
    // than a dashboard — the first-run experience this suite exists to guard.
    // Asserted only when the instance really is company-less, because a retry
    // (or a re-used smoke container) runs against one that is not.
    const companiesBeforeOnboarding = await getJson<Array<{ id: string }>>(
      page,
      `${baseUrl}/api/companies`
    );
    if (companiesBeforeOnboarding.length === 0) {
      await expect(page).toHaveURL(/\/onboarding$/, { timeout: 20_000 });
    }

    // Step 1: name the organization. "Continue" creates the company itself and
    // routes straight to the agent step — onboarding no longer asks for the
    // mission (it is collected later, in the app), so step 2 is skipped.
    const orgNameField = await openOnboarding(page);
    await orgNameField.fill(COMPANY_NAME);
    await page.getByRole("button", { name: "Continue", exact: true }).click();

    // Step 3: name the team lead. The name is the step's only question and it
    // gates the CTA; the role picker is gone, so the hire is filed as `general`.
    const agentNameField = page.locator("#onboarding-agent-name");
    await expect(agentNameField).toBeVisible({ timeout: 20_000 });
    await agentNameField.fill(AGENT_NAME);

    const nextButton = page.getByRole("button", { name: "Next", exact: true });
    await expect(nextButton).toBeEnabled({ timeout: 10_000 });
    await nextButton.click();

    // Step 4: keep the default adapter and connect (hire) the lead. Connect
    // probes the adapter environment first and blocks the hire on a `fail`. In
    // the smoke container no agent CLI is installed, which the probe reports as
    // a warning rather than an error, so the hire proceeds — a genuine failure
    // here means the published artifact cannot hire on a clean machine. Allow
    // generous time for the probe + hire + auto-approval.
    const connectButton = page.getByRole("button", {
      name: "Connect",
      exact: true,
    });
    await expect(connectButton).toBeVisible({ timeout: 10_000 });
    await expect(connectButton).toBeEnabled({ timeout: 30_000 });
    await connectButton.click();

    // Step 5: review, then launch. "Get started" provisions the onboarding
    // project and first task and, only on success, drops the user into the
    // seeded first task's thread (not the dashboard).
    const getStartedButton = page.getByRole("button", {
      name: "Get started",
      exact: true,
    });
    await expect(getStartedButton).toBeVisible({ timeout: 60_000 });
    await expect(getStartedButton).toBeEnabled({ timeout: 10_000 });
    await getStartedButton.click();
    await expect(page).toHaveURL(/\/issues\//, { timeout: 30_000 });

    const companies = await getJson<Array<{ id: string; name: string }>>(
      page,
      `${baseUrl}/api/companies`
    );
    const company = companies.find((entry) => entry.name === COMPANY_NAME);
    expect(company).toBeTruthy();

    const agents = await getJson<
      Array<{ id: string; name: string; role: string; adapterType: string }>
    >(page, `${baseUrl}/api/companies/${company!.id}/agents`);
    const leadAgent = agents.find((entry) => entry.name === AGENT_NAME);
    expect(leadAgent).toBeTruthy();
    expect(leadAgent!.role).toBe(AGENT_ROLE);
    expect(leadAgent!.adapterType).not.toBe("process");

    // Onboarding deliberately writes no goal: the mission is collected later in
    // the app, so a fresh company must come out of the wizard with an empty
    // goal list rather than an unchosen one.
    const goals = await getJson<Array<{ id: string }>>(
      page,
      `${baseUrl}/api/companies/${company!.id}/goals`
    );
    expect(goals).toEqual([]);

    const issues = await getJson<
      Array<{
        id: string;
        identifier: string | null;
        title: string;
        assigneeAgentId: string | null;
      }>
    >(page, `${baseUrl}/api/companies/${company!.id}/issues`);
    const seededIssue = issues.find((entry) => entry.title === FIRST_TASK_TITLE);
    expect(seededIssue).toBeTruthy();
    expect(seededIssue!.assigneeAgentId).toBe(leadAgent!.id);

    // The launch must have landed on the seeded task itself, not merely on
    // some issue route.
    const seededRef = seededIssue!.identifier ?? seededIssue!.id;
    expect(new URL(page.url()).pathname.endsWith(`/issues/${seededRef}`)).toBe(
      true
    );

    await expect.poll(
      async () => {
        const runs = await getJson<
          Array<{ agentId: string; invocationSource: string; status: string }>
        >(
          page,
          `${baseUrl}/api/companies/${company!.id}/heartbeat-runs?agentId=${leadAgent!.id}`
        );
        const latestRun = runs.find((entry) => entry.agentId === leadAgent!.id);
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
