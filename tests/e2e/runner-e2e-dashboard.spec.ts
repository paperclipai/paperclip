import { expect, test, type Page } from "@playwright/test";

import { runnerExecutionById, runnerMatrix } from "../runner-e2e/catalog.js";
import {
  renderRunnerE2EDashboard,
  type RunnerDashboardEntry,
} from "../runner-e2e/dashboard.js";
import { buildRunnerCampaign } from "../runner-e2e/history.js";
import type { MatrixExecution, RunnerE2EResult } from "../runner-e2e/types.js";

const reportUrl = "http://runner-e2e.test/campaign/";

async function openReport(page: Page, report: string) {
  await page.route(`${reportUrl}**`, (route) => route.fulfill({ contentType: "text/html", body: report }));
  await page.goto(reportUrl);
}

const executionIds = [
  "core-compatibility.legacy-codex.local.message-marker",
  "core-compatibility.legacy-codex.daytona.message-marker",
  "core-compatibility.legacy-claude.local.message-marker",
  "local-session-integrity.runner-acpx-codex.local.structured-question-restart-resume",
] as const;

function resultFor(
  execution: MatrixExecution,
  status: RunnerE2EResult["status"],
): RunnerDashboardEntry {
  const result: RunnerE2EResult = {
    schema: "paperclip.runner-e2e.result/v1",
    executionId: execution.id,
    suiteId: execution.suite.id,
    attempt: 1,
    status,
    profileId: execution.profile.id,
    environmentId: execution.environment.id,
    caseId: execution.task.id,
    provider: execution.profile.provider,
    model: execution.profile.model,
    runtimeMode: execution.profile.expectedRuntimeMode,
    startedAt: "2026-09-05T12:00:00.000Z",
    finishedAt: "2026-09-05T12:00:12.000Z",
    durationMs: 12_000,
    runIds: [`run-${execution.id}`],
    usage: {
      inputTokens: 1_250,
      outputTokens: 75,
      cachedInputTokens: 500,
    },
    matcherResults: [
      {
        matcher: { kind: "message_contains", expected: "PAPERCLIP_E2E_OK" },
        passed: status === "passed",
        detail: status === "passed" ? "matched" : "marker missing",
      },
    ],
    screenshots: [
      {
        id: "final-state",
        label: "Final visible task state",
        file: "final-state.png",
      },
    ],
    cleanup: "passed",
  };

  return {
    result,
    valid: status === "passed",
    errors: status === "passed" ? [] : ["fixture failure"],
    evidenceBaseHref: `evidence/${execution.id}/attempt-1`,
    evidenceFiles: ["final-state.png"],
  };
}

test("filters execution previews and pages through the filtered screenshot gallery", async ({
  page,
}) => {
  const catalog = executionIds.map(runnerExecutionById);
  const entries = catalog.map((execution, index) =>
    resultFor(execution, index === 1 ? "failed" : "passed"),
  );
  await openReport(
    page,
    renderRunnerE2EDashboard({
      title: "Runner E2E interaction fixture",
      generatedAt: "2026-09-05T12:01:00.000Z",
      expected: executionIds,
      catalog: runnerMatrix,
      entries,
    }),
  );

  const filters = page
    .locator("[data-report-query]")
    .locator("..")
    .locator("..");
  await expect(page.locator(".suite-nav")).toHaveCount(0);
  await expect(page.locator(".suite-section")).toHaveCount(2);
  await expect(page.locator('select[data-report-suite] option')).toHaveCount(3);
  await expect(page.locator('select[data-report-profile] option')).toHaveCount(4);
  await expect(page.locator("[data-report-result]")).toHaveText(
    "4 of 4 executions shown",
  );
  await expect(page.locator("[data-gallery-item]")).toHaveCount(4);
  const passedCard = page.locator('[data-execution-id="core-compatibility.legacy-codex.local.message-marker"]');
  const failedCard = page.locator('[data-execution-id="core-compatibility.legacy-codex.daytona.message-marker"]');
  await expect(passedCard.locator(".status")).toHaveText("passed");
  await expect(passedCard.locator(".case-outcome")).toBeHidden();
  await expect(passedCard.locator(".billing-strip")).toBeHidden();
  await expect(passedCard.locator(".execution-id")).toBeHidden();
  await expect(passedCard.locator(".case-diagnostics > summary")).toContainText("1/1 checks · 12s");
  await expect(failedCard.locator(":scope > .case-outcome")).toBeVisible();
  expect(
    await filters.evaluate((element) => getComputedStyle(element).position),
  ).toBe("static");
  await page.locator('.feature-coverage > summary').click();
  await page.locator('.feature-coverage').getByRole('button', { name: 'Questions and approvals', exact: true }).click();
  await expect(page.locator('select[data-report-feature]')).toHaveValue('questions-and-approvals');
  await expect(page.locator('.feature-coverage')).not.toHaveAttribute('open');
  await expect(page.locator('[data-report-result]')).toHaveText('1 of 4 executions shown');
  await expect(page.locator('.suite-section:visible')).toHaveCount(1);
  await expect(page.locator('[data-gallery-open]')).toHaveText('View gallery · 1');
  await page.setViewportSize({ width: 900, height: 900 });
  await expect(page.locator('.execution-preview:visible')).toHaveCount(1);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('[data-report-reset]').click();

  const widthBefore = await passedCard.evaluate((card) => card.getBoundingClientRect().width);
  await passedCard.locator(".case-diagnostics > summary").click();
  const widthAfter = await passedCard.evaluate((card) => card.getBoundingClientRect().width);
  expect(widthAfter).toBe(widthBefore);
  await expect(passedCard.locator(".billing-strip")).toBeVisible();

  await page.locator("[data-report-query]").fill("Legacy Claude");
  await expect(page.locator("[data-report-result]")).toHaveText(
    "1 of 4 executions shown",
  );
  await expect(page.locator("[data-gallery-open]")).toHaveText(
    "View gallery · 1",
  );

  await page.locator("[data-report-reset]").click();
  await expect(page.locator("[data-report-query]")).toBeFocused();
  await page
    .locator("select[data-report-profile]")
    .selectOption("legacy-codex");
  await expect(page.locator("[data-report-result]")).toHaveText(
    "2 of 4 executions shown",
  );
  await expect(page.locator("[data-gallery-open]")).toHaveText(
    "View gallery · 2",
  );

  await page.locator("[data-gallery-open]").click();
  const dialog = page.locator("[data-gallery-dialog]");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("[data-gallery-profile]")).toHaveText(
    "Legacy Codex",
  );
  await expect(dialog.locator("[data-gallery-environment]")).toHaveText(
    "Isolated local",
  );
  await expect(dialog.locator("[data-gallery-position]")).toHaveText(
    "Image 1 of 2",
  );
  await expect(dialog.locator("[data-gallery-original]")).toHaveAttribute("href", /legacy-codex\.local\.message-marker\/attempt-1\/final-state\.png$/);

  await page.keyboard.press("ArrowRight");
  await expect(dialog.locator("[data-gallery-environment]")).toHaveText(
    "Daytona sandbox",
  );
  await expect(dialog.locator("[data-gallery-status]")).toHaveText("failed");
  await expect(dialog.locator("[data-gallery-position]")).toHaveText(
    "Image 2 of 2",
  );
  await expect(dialog.locator("[data-gallery-original]")).toHaveAttribute("href", /legacy-codex\.daytona\.message-marker\/attempt-1\/final-state\.png$/);

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.locator("[data-report-reset]").click();
  await page.keyboard.press("/");
  await expect(page.locator("[data-report-query]")).toBeFocused();
});

function navigationReport(ids: readonly string[], suppliedEntries?: readonly RunnerDashboardEntry[]) {
  const catalog = ids.map(runnerExecutionById);
  const entries = suppliedEntries ?? catalog.map((execution) => resultFor(execution, "passed"));
  const generatedAt = "2026-09-05T12:01:00.000Z";
  return renderRunnerE2EDashboard({
    title: "Runner E2E navigation fixture",
    generatedAt,
    expected: ids,
    catalog: runnerMatrix,
    entries,
    campaign: buildRunnerCampaign({
      campaignId: "navigation-fixture",
      generatedAt,
      expected: ids,
      catalog,
      results: entries.map((entry) => entry.result),
    }),
  });
}

test("suite links reveal filtered sections and scroll on repeated clicks", async ({ page }) => {
  const report = navigationReport(executionIds);
  await openReport(page, report);

  const core = page.locator("#suite-core-compatibility");
  const coreHeading = core.getByRole("heading", { name: "Core Runner Compatibility", exact: true });
  const coreLink = page.locator('[data-nav-suite-link="core-compatibility"]');
  const backToTop = page.getByRole("link", { name: "Back to top", exact: true });
  await expect(backToTop).toBeHidden();
  const feature = page.locator("select[data-report-feature]");
  for (let click = 0; click < 2; click += 1) {
    await feature.selectOption("questions-and-approvals");
    await expect(core).toBeHidden();
    await coreLink.click();
    await expect(core).toBeVisible();
    await expect(coreHeading).toBeInViewport();
    await expect(feature).toHaveValue("");
    await expect(page).toHaveURL(`${reportUrl}?view=all#suite-core-compatibility`);
    await expect(page.locator("[data-report-result]")).toHaveText("4 of 4 executions shown");
  }

  await page.locator("select[data-report-profile]").selectOption("legacy-codex");
  await coreLink.click();
  await expect(coreHeading).toBeInViewport();
  await expect(page.locator("select[data-report-profile]")).toHaveValue("legacy-codex");
  await expect(backToTop).toBeVisible();
  expect(await backToTop.evaluate((element) => getComputedStyle(element).position)).toBe("fixed");
  await backToTop.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(backToTop).toBeHidden();
  await expect(page.locator(".report-header h1")).toBeFocused();
  await expect(page.locator("select[data-report-profile]")).toHaveValue("legacy-codex");
  await coreLink.click();

  await page.locator('[data-nav-suite-link="local-session-integrity"]').click();
  await expect(page.locator("#suite-local-session-integrity")).toBeVisible();
  await feature.selectOption("questions-and-approvals");
  await page.goBack();
  await expect(coreHeading).toBeInViewport();
  await expect(feature).toHaveValue("");
});

test("folds the suite tree, inspects configurations, and returns to the scrolling report", async ({ page }) => {
  const ids = [...executionIds, "core-compatibility.legacy-codex.local.ask-question"];
  await openReport(page, navigationReport(ids));
  const coreIndex = page.locator('[data-nav-suite="core-compatibility"]');
  const coreLink = coreIndex.locator('[data-nav-suite-link]');
  await expect(coreIndex).not.toHaveAttribute("open");
  await coreLink.click();
  await expect(coreIndex).toHaveAttribute("open");
  await coreIndex.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(coreIndex).not.toHaveAttribute("open");
  await page.keyboard.press("Enter");
  await expect(coreIndex).toHaveAttribute("open");
  await expect(coreIndex.locator("[data-nav-case]")).toHaveCount(2);
  const sectionToc = page.locator("#suite-core-compatibility .suite-case-toc");
  await expect(sectionToc.locator(".suite-case-list a")).toHaveCount(2);

  const basicLink = coreIndex.getByRole("link", { name: "Basic response", exact: true });
  const profile = page.locator("select[data-report-profile]");
  const feature = page.locator("select[data-report-feature]");
  const crumbs = page.getByRole("navigation", { name: "Breadcrumb", exact: true });
  const returnToCampaign = crumbs.getByRole("link", { name: "navigation-fixture", exact: true });
  await profile.selectOption("legacy-claude");
  const readingPosition = await page.evaluate(() => window.scrollY);
  await basicLink.click();
  const claudeResult = page.locator('[data-execution-id="core-compatibility.legacy-claude.local.message-marker"]');
  await expect(claudeResult).toBeVisible();
  await expect(page.locator("[data-report-case]:visible")).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Legacy Claude · Isolated local", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".report-filters")).toBeHidden();
  expect(new URL(page.url()).searchParams.get("view")).toBe("case");
  expect(new URL(page.url()).hash).toBe("#execution-core-compatibility.legacy-claude.local.message-marker");
  await returnToCampaign.click();
  await expect(profile).toHaveValue("legacy-claude");
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(readingPosition);

  await feature.selectOption("questions-and-approvals");
  await basicLink.click();
  await expect(page.locator('[data-execution-id="core-compatibility.legacy-codex.local.message-marker"]')).toBeVisible();
  await expect(page.locator("[data-nav-configuration]:visible")).toHaveCount(3);
  await crumbs.getByRole("link", { name: "Core Runner Compatibility", exact: true }).click();
  await expect(feature).toHaveValue("");
  await expect(profile).toHaveValue("");
  await expect(page.locator("[data-report-case]:visible")).toHaveCount(5);
  await sectionToc.getByRole("link", { name: "Ask mode question", exact: true }).click();
  await expect(page.locator('[data-execution-id="core-compatibility.legacy-codex.local.ask-question"] .case-heading')).toBeInViewport();
  await sectionToc.getByRole("link", { name: "Back to overview", exact: false }).click();
  await expect(page.locator("#overview")).toBeInViewport();

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(coreIndex).toBeHidden();
  await page.getByRole("button", { name: "Open navigation", exact: true }).click();
  await expect(basicLink).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await basicLink.click();
  await expect(coreIndex).toBeHidden();
  const daytona = page.getByRole("button", { name: "Legacy Codex · Daytona sandbox", exact: true });
  await daytona.click();
  await page.reload();
  await expect(daytona).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-execution-id="core-compatibility.legacy-codex.daytona.message-marker"]')).toBeVisible();
  await expect(page.locator("[data-report-case]:visible")).toHaveCount(1);
  await crumbs.getByRole("link", { name: "Core Runner Compatibility", exact: true }).click();
  const backToTop = page.getByRole("link", { name: "Back to top", exact: true });
  await expect(backToTop).toBeVisible();
  expect(await backToTop.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return bounds.left >= 0 && bounds.right <= innerWidth && bounds.bottom <= innerHeight;
  })).toBe(true);
  await backToTop.click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
});

test("case status dots summarize matching results and open failures", async ({ page }) => {
  const ids = [...executionIds, "core-compatibility.legacy-codex.local.ask-question"];
  const entries = executionIds.map((id, index) => resultFor(runnerExecutionById(id), index === 1 ? "failed" : "passed"));
  await openReport(page, navigationReport(ids, entries));
  const toc = page.locator("#suite-core-compatibility .suite-case-toc");
  const basic = toc.getByRole("link", { name: "Basic response", exact: true });
  const missing = toc.getByRole("link", { name: "Ask mode question", exact: true });
  const topLink = page.locator('.report-suite-tree [data-report-case-link="core-compatibility.message-marker"]');
  await expect(basic).toHaveAttribute("data-case-status", "failed");
  await expect(topLink).toHaveAttribute("data-case-status", "failed");
  await expect(basic).toHaveAccessibleDescription("failed · 2/3 configurations passed");
  await expect(missing).toHaveAttribute("data-case-status", "missing");
  await expect(missing).toHaveAttribute("title", "missing · 0/1 configurations passed");
  const red = await basic.locator(".case-status-dot").evaluate((element) => getComputedStyle(element).backgroundColor);

  const profile = page.locator("select[data-report-profile]");
  await profile.selectOption("legacy-claude");
  await expect(basic).toHaveAttribute("data-case-status", "passed");
  await expect(topLink).toHaveAttribute("data-case-status", "passed");
  await expect(basic).toHaveAccessibleDescription("passed · 1/1 configurations passed");
  const green = await basic.locator(".case-status-dot").evaluate((element) => getComputedStyle(element).backgroundColor);
  expect(green).not.toBe(red);
  await expect(missing).toHaveAttribute("title", /no matching configurations/);
  await page.locator('[data-report-journey="core-compatibility.message-marker"]').getByRole("link", { name: "Inspect case ↗", exact: true }).click();
  await expect(page.locator('[data-execution-id="core-compatibility.legacy-claude.local.message-marker"]')).toBeVisible();
  await expect(page.locator("[data-report-case]:visible")).toHaveCount(1);
  await expect(topLink).toHaveAttribute("data-case-status", "passed");
  await page.getByRole("navigation", { name: "Breadcrumb", exact: true }).getByRole("link", { name: "navigation-fixture", exact: true }).click();

  await profile.selectOption("legacy-codex");
  await expect(basic).toHaveAttribute("data-case-status", "failed");
  await page.locator("select[data-report-environment]").selectOption("local");
  await expect(basic).toHaveAttribute("data-case-status", "passed");
  await page.locator("[data-report-reset]").click();
  await basic.click();
  await expect(page).toHaveURL(`${reportUrl}?view=all#execution-core-compatibility.legacy-codex.daytona.message-marker`);
  await expect(page.locator('[data-execution-id="core-compatibility.legacy-codex.daytona.message-marker"] .case-heading')).toBeInViewport();
  await page.locator('[data-execution-id="core-compatibility.legacy-codex.local.message-marker"] .case-open').click();
  await expect(page.locator("[data-report-case]:visible")).toHaveCount(1);
  await expect(topLink).toHaveAttribute("data-case-status", "failed");
  await expect(topLink).toHaveAccessibleDescription("failed · 2/3 configurations passed");
  await page.getByRole("button", { name: "Legacy Codex · Daytona sandbox", exact: true }).click();
  await expect(topLink).toHaveAttribute("data-case-status", "failed");
});
