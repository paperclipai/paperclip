import { expect, type Page } from "@playwright/test";

/**
 * Shared driver for the cloud onboarding flow (ui/src/components/onboarding/).
 *
 * The flow replaced the retired OnboardingWizard, which had a front door, a
 * separate company-name step, a separate mission step, an adapter step and a
 * review step. The cloud flow is four screens:
 *
 *   start   — "Welcome to Paperclip!" (unnumbered)
 *   company — name + mission on one card; "Next" creates the company + goal
 *   agent   — role picker (+ optional name); "Create" hires the lead agent
 *   task    — first-task choice; "Get started" launches it and opens the dashboard
 *
 * Four specs drove the old wizard's selectors, so the step drivers live here
 * rather than being copy-pasted: when the flow changes again, this is the one
 * file to update.
 */

/** Default role picked in the agent step. */
export const DEFAULT_ROLE = "Chief of Staff";

/**
 * Name the agent step auto-fills when DEFAULT_ROLE is picked. Selecting a role
 * populates the (optional) name field with the role's acronym — see
 * ROLE_ACRONYMS in ui/src/components/onboarding/onboarding-data.ts.
 */
export const DEFAULT_ROLE_ACRONYM = "COS";

/** Title of the task created by the "hiring" first-task choice. */
export const HIRING_TASK_TITLE = "Hire your first engineer and create a hiring plan";

export type FirstTaskChoice = "hiring" | "strategy" | "custom";

/**
 * Matches each first-task ChoiceCard. The cards are buttons whose accessible
 * name is title + description, so these match on the title fragment only.
 */
const CHOICE_CARD: Record<FirstTaskChoice, RegExp> = {
  hiring: /Create a hiring plan/,
  strategy: /Write a team strategy doc/,
  // Trailing ellipsis in the UI copy is deliberately not matched.
  custom: /Write your own task/,
};

/** Step 0 — the welcome screen. Advances to the first numbered step. */
export async function startCloudOnboarding(page: Page): Promise<void> {
  await expect(page.getByRole("heading", { name: "Welcome to Paperclip!" })).toBeVisible({
    timeout: 15_000,
  });
  await page
    .getByRole("button", { name: /Set up Paperclip for your company or team/ })
    .click();
}

/**
 * Step 1 — company name + mission on a single card. "Next" persists the company
 * and its company-level goal, then advances to the agent step.
 */
export async function completeCompanyStep(
  page: Page,
  { companyName, mission }: { companyName: string; mission: string },
): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "What is the name of your company or team?" }),
  ).toBeVisible({ timeout: 15_000 });
  await page.locator("#onboarding-company-name").fill(companyName);
  await page.locator("#onboarding-mission").fill(mission);
  await page.getByRole("button", { name: /^Next/ }).click();
}

/**
 * Step 2 — role picker (a Radix select) plus an optional name. "Create" hires
 * the lead agent. Pass `name` to override the acronym the role auto-fills.
 */
export async function completeAgentStep(
  page: Page,
  { role = DEFAULT_ROLE, name }: { role?: string; name?: string } = {},
): Promise<void> {
  await expect(page.getByRole("heading", { name: "Create your first agent" })).toBeVisible({
    timeout: 30_000,
  });
  await page.locator("#onboarding-agent-role").click();
  await page.getByRole("option", { name: role, exact: true }).click();
  if (name !== undefined) {
    await page.locator("#onboarding-agent-name").fill(name);
  }
  await page.getByRole("button", { name: /^Create/ }).click();
}

/**
 * Step 3 — pick the first task and launch it. "Get started" creates the task
 * and navigates to the company dashboard.
 */
export async function completeTaskStep(
  page: Page,
  { choice = "hiring", customTask }: { choice?: FirstTaskChoice; customTask?: string } = {},
): Promise<void> {
  await expect(
    page.getByRole("heading", { name: "Assign your agent a first task" }),
  ).toBeVisible({ timeout: 30_000 });
  await page.getByRole("button", { name: CHOICE_CARD[choice] }).click();
  if (choice === "custom") {
    await page.getByPlaceholder("Describe the first task").fill(customTask ?? "");
  }
  await page.getByRole("button", { name: /Get started/ }).click();
}

/**
 * Drives the whole cloud flow from an already-loaded /onboarding route through
 * to the dashboard navigation. Callers that need to assert or screenshot
 * between steps should call the individual step drivers instead.
 */
export async function completeCloudOnboarding(
  page: Page,
  {
    companyName,
    mission,
    role = DEFAULT_ROLE,
    choice = "hiring",
    customTask,
  }: {
    companyName: string;
    mission: string;
    role?: string;
    choice?: FirstTaskChoice;
    customTask?: string;
  },
): Promise<void> {
  await startCloudOnboarding(page);
  await completeCompanyStep(page, { companyName, mission });
  await completeAgentStep(page, { role });
  await completeTaskStep(page, { choice, customTask });
}
