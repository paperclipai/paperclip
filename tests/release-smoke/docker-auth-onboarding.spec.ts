import { expect, test, type Page } from "@playwright/test";

const ADMIN_EMAIL =
  process.env.PAPERCLIP_RELEASE_SMOKE_EMAIL ??
  process.env.SMOKE_ADMIN_EMAIL ??
  "smoke-admin@paperclip.local";
const ADMIN_PASSWORD =
  process.env.PAPERCLIP_RELEASE_SMOKE_PASSWORD ??
  process.env.SMOKE_ADMIN_PASSWORD ??
  "paperclip-smoke-password";

// A hire needs a live-verified credential since #13344 — the subscription
// path now dead-ends on a `claude auth login` no CI machine can finish — so
// the wizard is driven through "Use API key instead". The server verifies the
// key against api.anthropic.com, which the docker-onboard-smoke harness
// serves from its own mock inside the container's network, so the placeholder
// below passes without any real credential in CI.
//
// The placeholder is offered only to a loopback target — where the mocked
// harness lives. Any other target reaches the real provider, which would
// reject the placeholder late inside the wizard, so those runs must set
// PAPERCLIP_RELEASE_SMOKE_ANTHROPIC_API_KEY and fail up front without it.
// A real key entered here also lands in Playwright's failure traces and DOM
// snapshots (the field is masked on screen, not in the DOM) — those artifacts
// stay on the machine running the suite, and CI never uses a real key.
const BASE_URL =
  process.env.PAPERCLIP_RELEASE_SMOKE_BASE_URL ?? "http://127.0.0.1:3232";
const TARGET_IS_LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1)([:/]|$)/i.test(
  BASE_URL
);
const ANTHROPIC_API_KEY =
  process.env.PAPERCLIP_RELEASE_SMOKE_ANTHROPIC_API_KEY ??
  (TARGET_IS_LOOPBACK ? "sk-ant-release-smoke-placeholder" : "");

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
    // Only bites off-loopback: fail on arrival rather than submitting the
    // placeholder to the real provider and timing out deep in the wizard.
    expect(
      ANTHROPIC_API_KEY,
      "This target reaches the real provider — set PAPERCLIP_RELEASE_SMOKE_ANTHROPIC_API_KEY to a key it accepts"
    ).toBeTruthy();

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

    // Step 4: answer the model-source question, then connect (hire) the lead.
    // The step now opens as a row of source tiles and the footer button has
    // nothing to do until one is picked (#12796/#12801 rebuilt the step around
    // that question); picking Claude collapses the row.
    //
    // Since #13344, a hire requires a verified credential: the subscription
    // path opens an isolated `claude auth login` attempt that only a human at
    // a terminal on the server can finish, and Connect refuses to proceed
    // until it has. The clean-machine path this suite guards is therefore the
    // API key: switch modes, pick Claude, paste a key, Connect — the server
    // verifies it against the provider endpoint (the harness's mock, here)
    // and then hires. A genuine failure here means the published artifact
    // cannot hire on a clean machine even when the provider accepts the
    // credential. Allow generous time for the validation + hire +
    // auto-approval.
    //
    // The mode switch comes before the tile: picking a tile starts the step's
    // collapse sequence and the "Use API key instead" link only offers itself
    // while the row is still a question (`connectLinkVisible` in
    // OnboardingWizard.tsx).
    await expect(
      page.getByRole("heading", { name: "Connect a model" })
    ).toBeVisible({ timeout: 20_000 });

    await page
      .getByRole("button", { name: "Use API key instead", exact: true })
      .click();

    // "Claude API" once the mode has swapped the tile's tag — matched on the
    // stable half.
    const claudeSourceTile = page
      .getByRole("radiogroup", { name: "Model source" })
      .getByRole("radio", { name: /Claude/ });
    await expect(claudeSourceTile).toBeVisible({ timeout: 10_000 });
    await claudeSourceTile.click();

    // OnboardingCardField carries the accessible name via aria-label.
    const apiKeyField = page.getByLabel("API key");
    await expect(apiKeyField).toBeVisible({ timeout: 10_000 });
    await apiKeyField.fill(ANTHROPIC_API_KEY);

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

    // #13068 rebuilt the seeded first task as a chat with the lead: launch
    // posts a deterministic, server-owned greeting plus an opening question
    // card, and deliberately does not wake the assignee — "no run until the
    // user answers". Assert the chat actually opened (the greeting and the
    // card are seeded without an LLM, so their absence means the launch
    // half-finished) …
    await expect(
      page.getByText("Welcome to Paperclip!").first()
    ).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("What would you like to do?")).toBeVisible();

    // … and that the no-run contract holds. This spec used to poll for an
    // assignment-triggered heartbeat run here; a run appearing before the
    // user's first answer is now the regression, not the success. Wake
    // dispatch is asynchronous, so watch the endpoint over a bounded window
    // rather than sampling it once — a launch-time wake that slips through
    // lands well within this window.
    const runsUrl = `${baseUrl}/api/companies/${company!.id}/heartbeat-runs?agentId=${leadAgent!.id}`;
    const noRunDeadline = Date.now() + 15_000;
    while (Date.now() < noRunDeadline) {
      expect(await getJson<Array<{ id: string }>>(page, runsUrl)).toEqual([]);
      await page.waitForTimeout(1_000);
    }
  });
});
