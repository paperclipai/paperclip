import { test, expect } from "@playwright/test";
import { completeCloudOnboarding, HIRING_TASK_TITLE } from "./onboarding-flow";

/**
 * E2E: post-onboarding launch.
 *
 * Completing the onboarding flow creates the first assigned task and lands the
 * user on the company dashboard. The chat intro still has unit coverage in
 * BoardChat tests; the onboarding handoff no longer routes there.
 */

const COMPANY_NAME = `E2E-TypingIntro-${Date.now()}`;
const MISSION = "Verify the dashboard launch survives the onboarding handoff.";

test.describe("Dashboard launch after onboarding", () => {
  test("creates the first task and opens the dashboard", async ({
    page,
    baseURL,
  }) => {
    // Intercept hire → perform a REAL hire server-side with an inert http
    // adapter so no real agent process spawns. (The cloud flow hires with
    // requireEnvProbe: false, so there is no adapter-environment probe to stub.)
    await page.route("**/agent-hires", async (route) => {
      const req = route.request();
      const body = JSON.parse(req.postData() || "{}");
      const auth = req.headers().authorization;
      const real = await fetch(new URL(req.url(), baseURL).toString(), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(auth ? { Authorization: auth } : {}),
        },
        body: JSON.stringify({
          name: body.name,
          role: body.role,
          adapterType: "http",
          adapterConfig: { url: "http://127.0.0.1:1/dead" },
          runtimeConfig: { heartbeat: { enabled: false } },
        }),
      });
      await route.fulfill({
        status: real.status,
        contentType: "application/json",
        body: await real.text(),
      });
    });

    await page.goto("/onboarding");

    // Welcome → company (name + mission) → agent (role picker) → first task.
    // "Get started" on the task step creates the task and opens the dashboard.
    await completeCloudOnboarding(page, {
      companyName: COMPANY_NAME,
      mission: MISSION,
      choice: "hiring",
    });

    await expect(page).toHaveURL(/\/dashboard$/, { timeout: 30_000 });

    const companiesRes = await page.request.get("/api/companies");
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const company = companies.find((candidate: { name: string }) => candidate.name === COMPANY_NAME);
    expect(company).toBeTruthy();

    const issuesRes = await page.request.get(`/api/companies/${company.id}/issues`);
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json();
    const firstTask = issues.find((candidate: { title: string }) => candidate.title === HIRING_TASK_TITLE);
    expect(firstTask).toBeTruthy();
    await expect(page.getByText(HIRING_TASK_TITLE).first()).toBeVisible({ timeout: 15_000 });
  });
});
