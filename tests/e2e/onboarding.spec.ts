import { test, expect } from "@playwright/test";
import { completeCompanyStep, startCloudOnboarding } from "./onboarding-flow";

/**
 * E2E: cloud onboarding flow.
 *
 * The flow opens on a welcome screen and then runs three numbered steps:
 *   Step 0 — Welcome (unnumbered path picker)
 *   Step 1 — Company name + mission
 *   Step 2 — Create your first agent (role picker)
 *   Step 3 — Assign your agent a first task
 *
 * This test covers the deterministic, LLM-free core: it drives the welcome
 * screen through the company step (which creates the company and a
 * company-level goal) and verifies the flow advances to the agent step.
 *
 * The tail (hiring the agent, launching the first task) is covered by
 * conference-room-typing-intro.spec.ts; surface-level rendering of every step
 * is snapshotted by nux-phase4-screenshots.spec.ts.
 */

const COMPANY_NAME = `E2E-Test-${Date.now()}`;
const MISSION = "Build affordable home robots that handle household chores.";

test.describe("Onboarding flow", () => {
  test("company step: name + mission creates company and goal", async ({
    page,
  }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (err) => pageErrors.push(err.message));

    await page.goto("/onboarding");

    await startCloudOnboarding(page);
    await completeCompanyStep(page, {
      companyName: COMPANY_NAME,
      mission: MISSION,
    });

    // Reaching the agent step means the company + goal writes succeeded.
    await expect(
      page.getByRole("heading", { name: "Create your first agent" }),
    ).toBeVisible({ timeout: 30_000 });

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

    // The flow must not crash the app (Rules-of-Hooks regression).
    expect(pageErrors, pageErrors.join("\n")).toHaveLength(0);
  });
});
