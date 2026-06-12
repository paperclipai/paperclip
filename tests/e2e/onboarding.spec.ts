import { test, expect } from "@playwright/test";

/**
 * E2E: Onboarding wizard flow (NUX Phase 2 expanded wizard).
 *
 * The wizard now opens on a front door (path picker) and the "Create a new
 * company" path runs:
 *   Step 0  — Front door (Create a new company / Level up existing)
 *   Step 1a — Name your company
 *   Step 1b — Define your mission (direct or guided)
 *   Step 2  — Hire your team lead (adapter picker)
 *   Step 3+ — Launch celebration → CEO chat → hiring plan → orientation
 *
 * This test covers the deterministic, LLM-free core: it drives the front door
 * through company naming + mission definition (which creates the company and a
 * company-level goal) and verifies the wizard advances to the team-lead step.
 *
 * The tail (CEO chat at step 4, hiring-plan generation at step 5, final
 * landing) depends on a live LLM and is verified separately during manual /
 * LLM-backed QA — see PAP-50. Surface-level rendering of every step is
 * snapshotted by nux-phase4-screenshots.spec.ts.
 */

const COMPANY_NAME = `E2E-Test-${Date.now()}`;
const MISSION = "Build affordable home robots that handle household chores.";

test.describe("Onboarding wizard", () => {
  test("create-company path: name + mission creates company and goal", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    // New-NUX surfaces are flag-gated default-OFF (PAP-136/137/138): turn the
    // experimental flag on for this throwaway instance before driving them.
    const flagRes = await page.request.patch("/api/instance/settings/experimental", {
      data: { enableConferenceRoomChat: true },
    });
    expect(flagRes.ok()).toBe(true);

    await page.goto("/onboarding");

    // The wizard may open on a launcher card or directly on the capsule
    // wizard; the front door (step 0) requires a click into the create path.
    const startBtn = page.getByRole("button", {
      name: /Start Onboarding|New Company|Add Agent/,
    });
    if (await startBtn.count()) {
      await startBtn.first().click();
    }
    const createCard = page.getByRole("button", { name: /Build a new team/ });
    if (await createCard.count()) {
      await createCard.first().click();
    }

    // Step 1 — Name your team.
    await expect(
      page.getByRole("heading", { name: "Name your team" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder("Acme Corp").fill(COMPANY_NAME);
    await page.getByRole("button", { name: /^Next/ }).click();

    // Step 2 — Define your mission (direct entry is the default path).
    await expect(
      page.getByRole("heading", { name: "Define your mission" }),
    ).toBeVisible({ timeout: 10_000 });
    await page
      .getByPlaceholder("What is your team trying to achieve?")
      .fill(MISSION);

    // "Confirm mission" creates the company + a company-level goal, then
    // advances to the team-lead naming step of the capsule wizard.
    await page.getByRole("button", { name: /Confirm mission/ }).click();
    await page.waitForSelector('input[placeholder="Chief of staff"]', {
      timeout: 30_000,
    });

    // Verify the company + company-level goal were persisted.
    const baseUrl = page.url().split("/").slice(0, 3).join("/");
    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const company = companies.find(
      (c: { name: string }) => c.name === COMPANY_NAME,
    );
    expect(company, `company ${COMPANY_NAME} should exist`).toBeTruthy();

    const goalsRes = await page.request.get(
      `${baseUrl}/api/companies/${company.id}/goals`,
    );
    expect(goalsRes.ok()).toBe(true);
    const goals = await goalsRes.json();
    const companyGoal = (Array.isArray(goals) ? goals : []).find(
      (g: { level?: string }) => g.level === "company",
    );
    expect(companyGoal, "a company-level goal should be created").toBeTruthy();

    // The expanded wizard must not crash the app (Rules-of-Hooks regression).
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
  });
});
