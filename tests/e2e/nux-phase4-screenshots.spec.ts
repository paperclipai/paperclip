import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * NUX Phase 4 — visual QA screenshot capture.
 *
 * Boots a throwaway local_trusted instance (see playwright.config.ts webServer)
 * and captures screenshots of every surface integrated by NUX Phases 1–3:
 *   - Company setup
 *   - Team-lead hire step
 *   - Workspace link
 *   - Team review
 *   - Launch task
 *   - Conference Room (BoardChat) shell + composer + activity feed
 *   - Artifacts page
 *
 * These are structural/rendering checks — LLM-dependent streaming (CEO chat
 * responses, hiring-plan generation) is verified separately on an LLM-backed
 * instance. Screenshots land in ./nux-phase4-shots for upload as evidence.
 */

// Write under the gitignored test-results dir so re-runs leave no untracked
// noise; screenshots are uploaded to the issue as QA evidence, not committed.
const SHOT_DIR = path.join(__dirname, "test-results", "nux-phase4-shots");

function shot(name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return path.join(SHOT_DIR, name);
}

async function openWizard(page: import("@playwright/test").Page) {
  await page.goto("/onboarding");
  const startBtn = page.getByRole("button", { name: /Start Onboarding|New Company|Add Agent/ });
  if (await startBtn.count()) {
    await startBtn.first().click();
  }
}

test.describe("NUX Phase 4 visual QA", () => {
  test("captures every integrated surface", async ({ page, baseURL }) => {
    // New-NUX surfaces are flag-gated default-OFF (PAP-136/137/138): turn the
    // experimental flag on for this throwaway instance before driving them.
    const flagRes = await page.request.patch("/api/instance/settings/experimental", {
      data: { enableConferenceRoomChat: true },
    });
    expect(flagRes.ok()).toBe(true);

    const consoleErrors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    });
    page.on("pageerror", (err) => consoleErrors.push("PAGEERROR: " + err.message));

    const baseUrl =
      baseURL ?? "http://127.0.0.1:" + (process.env.PAPERCLIP_E2E_PORT ?? "3199");

    await page.route("**/test-environment", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({ status: "pass", checks: [] }),
      }),
    );

    await page.route("**/agent-hires", async (route) => {
      const req = route.request();
      const body = JSON.parse(req.postData() || "{}");
      const auth = req.headers().authorization;
      const real = await fetch(new URL(req.url(), baseUrl).toString(), {
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

    // ── Section A: onboarding wizard ──────────────────────────────────────
    await openWizard(page);
    await expect(
      page.getByRole("heading", { name: "Set up your company" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder("Acme Corp").fill("QA Robotics");
    await page
      .getByPlaceholder("What is this company trying to achieve?")
      .fill("Build affordable home robots that handle household chores.");
    await page.screenshot({ path: shot("01-company-setup.png") });

    await page.getByRole("button", { name: /^Next/ }).click();
    await expect(
      page.getByRole("heading", { name: "Create your first agent" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: shot("02-create-agent.png") });

    await page.getByRole("button", { name: /^Next/ }).click();
    await expect(
      page.getByRole("heading", { name: "Link a workspace" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: shot("03-link-workspace.png") });

    // The company just created anchors the route-scoped sections below.
    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const qaCompany = (Array.isArray(companies) ? companies : []).find(
      (c: { name: string }) => c.name === "QA Robotics",
    );
    expect(qaCompany, "wizard should have created QA Robotics").toBeTruthy();
    const prefix: string = qaCompany.issuePrefix;

    await page.getByRole("button", { name: "Skip" }).click();
    await expect(
      page.getByRole("heading", { name: "Review your team" }),
    ).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: shot("04-review-team.png") });

    await page.getByRole("button", { name: /^Next/ }).click();
    await expect(
      page.getByRole("heading", { name: "Launch with a task" }),
    ).toBeVisible({ timeout: 10_000 });
    const taskTitleInput = page.getByPlaceholder(
      "e.g. Review the codebase and create a roadmap",
    );
    await taskTitleInput.clear();
    await taskTitleInput.fill("Create the first robotics launch plan");
    await page.screenshot({ path: shot("05-launch-task.png") });

    await page.getByRole("button", { name: "Close" }).click();

    // ── Section C: Conference Room (BoardChat) ────────────────────────────
    // Visit the company dashboard first so CompanyContext selects the company
    // from the route before we land on the board-chat surface.
    await page.evaluate(() => window.localStorage.clear());
    await page.goto(`/${prefix}/dashboard`);
    await page.waitForLoadState("networkidle");
    await page.goto(`/${prefix}/board-chat`);
    await expect(page).toHaveURL(new RegExp(`/${prefix}/board-chat`));
    // Composer renders once a company is selected. (Regression guard for the
    // Rules-of-Hooks crash that previously blanked this page — see PAP-50.)
    await expect(
      page.getByPlaceholder("Ask anything about your company..."),
    ).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2_000); // let welcome bubble + suggestion chips stage in
    await page.screenshot({ path: shot("06-board-chat.png") });

    // ── Section D: Artifacts ──────────────────────────────────────────────
    await page.goto(`/${prefix}/artifacts`);
    await expect(page).toHaveURL(new RegExp(`/${prefix}/artifacts`));
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1_000);
    await page.screenshot({ path: shot("07-artifacts.png") });

    for (const f of [
      "01-company-setup.png",
      "02-create-agent.png",
      "03-link-workspace.png",
      "04-review-team.png",
      "05-launch-task.png",
      "06-board-chat.png",
      "07-artifacts.png",
    ]) {
      const p = shot(f);
      expect(fs.existsSync(p), `missing ${f}`).toBe(true);
      expect(fs.statSync(p).size, `empty ${f}`).toBeGreaterThan(1_000);
    }

    // No React Rules-of-Hooks / render crashes on any surface we visited.
    const hookErrors = consoleErrors.filter(
      (e) => /Rendered more hooks|change in the order of Hooks/i.test(e),
    );
    expect(hookErrors, hookErrors.join("\n")).toHaveLength(0);
  });
});
