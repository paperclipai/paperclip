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
 *   - "Build a new company" step 1 (company name) + step 2 (mission)
 *   - Team-lead hire step (capsule wizard, PAP-125)
 *   - Onboarding front door (path picker)
 *   - "Add agents to your org" growth intake
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
  const startBtn = page.getByRole("button", { name: /Start Onboarding|New Organization|Add Agent/ });
  if (await startBtn.count()) {
    await startBtn.first().click();
  }
}

test.describe("NUX Phase 4 visual QA", () => {
  test("captures every integrated surface", async ({ page }) => {
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
      "http://127.0.0.1:" + (process.env.PAPERCLIP_E2E_PORT ?? "3199");

    // ── Section A: create-company path (name → mission → hire) ────────────
    await openWizard(page);
    // Front door shows when the wizard doesn't open directly on the create
    // path (e.g. another spec already created a company on this instance).
    const createCard = page.getByRole("button", { name: /Build a new organization/ });
    if (await createCard.count()) {
      await createCard.first().click();
    }
    await expect(
      page.getByRole("heading", { name: "What is the name of your organization?" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.getByPlaceholder("e.g. Northwind Labs").fill("QA Robotics");
    await page.screenshot({ path: shot("02-create-name.png") });

    await page.getByRole("button", { name: /^Continue/ }).click();
    // Step 1's "Next" creates the company and goes straight to the team lead.
    // The mission screenshot that sat here is gone with the step it captured.
    await page.waitForSelector("#onboarding-agent-name", {
      timeout: 30_000,
    });
    await page.screenshot({ path: shot("04-hire-team-lead.png") });

    // The company just created anchors the route-scoped sections below.
    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const qaCompany = (Array.isArray(companies) ? companies : []).find(
      (c: { name: string }) => c.name === "QA Robotics",
    );
    expect(qaCompany, "wizard should have created QA Robotics").toBeTruthy();
    const prefix: string = qaCompany.issuePrefix;

    // ── Section B: front door + growth intake ─────────────────────────────
    await page.evaluate(() => window.localStorage.clear());
    await openWizard(page);
    // Reach the full-screen front door (step 0): either it shows directly or
    // the naming step's Back returns to it.
    //
    // That control used to be a "← Back to start" text link. The naming step now
    // wears the same footer pair as the steps after it, so its Back is labelled
    // like theirs — it still lands on the front door, because the front door is
    // what sits behind step 1.
    //
    // Exact, because the progress strip's segments are buttons with their own
    // labels and an unanchored /Back/ would match more than one.
    if (!(await page.getByRole("heading", { name: "Welcome to Paperclip" }).count())) {
      await page.getByRole("button", { name: "Back", exact: true }).click();
    }
    await expect(
      page.getByRole("heading", { name: "Welcome to Paperclip" }),
    ).toBeVisible({ timeout: 10_000 });
    await expect(
      page.getByRole("heading", { name: "Build a new organization" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Add agents to your org" }),
    ).toBeVisible();
    await page.screenshot({ path: shot("01-front-door.png") });

    await page.getByRole("button", { name: /Add agents to your org/ }).click();
    // The grow path shares step 1 (company name) before its step-2 intake.
    await expect(
      page.getByRole("heading", { name: "What is the name of your organization?" }),
    ).toBeVisible({ timeout: 10_000 });
    await page.getByPlaceholder("e.g. Northwind Labs").fill("QA Robotics Grow");
    await page.getByRole("button", { name: /^Continue/ }).click();
    await expect(
      page.getByRole("heading", { name: /Tell us about your team/ }),
    ).toBeVisible({ timeout: 10_000 });
    await page.screenshot({ path: shot("05-growth-intake.png") });

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
      page.getByPlaceholder("Ask anything about your organization..."),
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
      "01-front-door.png",
      "02-create-name.png",
      "04-hire-team-lead.png",
      "05-growth-intake.png",
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
