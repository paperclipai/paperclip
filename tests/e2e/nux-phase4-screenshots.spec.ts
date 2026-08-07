import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_ROLE, startCloudOnboarding } from "./onboarding-flow";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * NUX Phase 4 — visual QA screenshot capture.
 *
 * Boots a throwaway local_trusted instance (see playwright.config.ts webServer)
 * and captures screenshots of every integrated onboarding surface:
 *   - Welcome screen (path picker)
 *   - Company step (name + mission)
 *   - Create-your-first-agent step (role picker + capsule)
 *   - First-task step
 *   - "Add an agent to an existing company" entry (/:prefix/onboarding)
 *   - Conference Room (BoardChat) shell + composer + activity feed
 *   - Artifacts page
 *
 * These are structural/rendering checks — LLM-dependent streaming (CEO chat
 * responses, hiring-plan generation) is verified separately on an LLM-backed
 * instance. Screenshots land in ./test-results for upload as evidence.
 */

// Write under the gitignored test-results dir so re-runs leave no untracked
// noise; screenshots are uploaded to the issue as QA evidence, not committed.
const SHOT_DIR = path.join(__dirname, "test-results", "nux-phase4-shots");

const SHOTS = [
  "01-welcome.png",
  "02-company.png",
  "03-agent.png",
  "04-first-task.png",
  "05-add-agent.png",
  "06-board-chat.png",
  "07-artifacts.png",
];

function shot(name: string) {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  return path.join(SHOT_DIR, name);
}

test.describe("NUX Phase 4 visual QA", () => {
  test("captures every integrated surface", async ({ page }) => {
    // Conference Room is flag-gated default-OFF: turn the experimental flag on
    // for this throwaway instance before driving that surface (Section C).
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

    // ── Section A: the cloud flow, step by step ───────────────────────────
    await page.goto("/onboarding");

    await expect(
      page.getByRole("heading", { name: "Welcome to Paperclip!" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: shot("01-welcome.png") });

    await startCloudOnboarding(page);

    // Capture the company step populated but not yet submitted, then submit.
    await expect(
      page.getByRole("heading", { name: "What is the name of your company or team?" }),
    ).toBeVisible({ timeout: 15_000 });
    await page.locator("#onboarding-company-name").fill("QA Robotics");
    await page
      .locator("#onboarding-mission")
      .fill("Build affordable home robots that handle household chores.");
    await page.screenshot({ path: shot("02-company.png") });
    await page.getByRole("button", { name: /^Next/ }).click();

    // Agent step: pick a role so the capsule + preview render, then capture
    // before hiring.
    await expect(
      page.getByRole("heading", { name: "Create your first agent" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.locator("#onboarding-agent-role").click();
    await page.getByRole("option", { name: DEFAULT_ROLE, exact: true }).click();
    await page.screenshot({ path: shot("03-agent.png") });
    await page.getByRole("button", { name: /^Create/ }).click();

    // First-task step: select a choice so the card's selected state is visible.
    await expect(
      page.getByRole("heading", { name: "Assign your agent a first task" }),
    ).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: /Create a hiring plan/ }).click();
    await page.screenshot({ path: shot("04-first-task.png") });

    // The company just created anchors the route-scoped sections below.
    const companiesRes = await page.request.get(`${baseUrl}/api/companies`);
    expect(companiesRes.ok()).toBe(true);
    const companies = await companiesRes.json();
    const qaCompany = (Array.isArray(companies) ? companies : []).find(
      (c: { name: string }) => c.name === "QA Robotics",
    );
    expect(qaCompany, "onboarding should have created QA Robotics").toBeTruthy();
    const prefix: string = qaCompany.issuePrefix;

    // ── Section B: "add an agent to an existing company" entry ────────────
    // OnboardingWizardVariant renders outside <Routes> (App.tsx), so it never
    // sees the :companyPrefix param and the company-scoped route still opens on
    // the welcome screen. The real existing-company entry is the launcher card
    // behind it: dismiss the overlay, then "Add Agent" opens onboarding scoped
    // to this company, which skips company creation and starts at the agent step.
    await page.evaluate(() => window.localStorage.clear());
    await page.goto(`/${prefix}/onboarding`);
    await page.getByRole("button", { name: "Close onboarding" }).click();
    await page.getByRole("button", { name: "Add Agent" }).click();
    await expect(
      page.getByRole("heading", { name: "Create your first agent" }),
    ).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: shot("05-add-agent.png") });

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

    for (const f of SHOTS) {
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
