import { expect, test } from "@playwright/test";

import { runnerExecutionById } from "../runner-e2e/catalog.js";
import {
  renderRunnerE2EDashboard,
  type RunnerDashboardEntry,
} from "../runner-e2e/dashboard.js";
import type { MatrixExecution, RunnerE2EResult } from "../runner-e2e/types.js";

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

test("filters matrix results and pages through the filtered screenshot gallery", async ({
  page,
}) => {
  const catalog = executionIds.map(runnerExecutionById);
  const entries = catalog.map((execution, index) =>
    resultFor(execution, index === 1 ? "failed" : "passed"),
  );
  await page.setContent(
    renderRunnerE2EDashboard({
      title: "Runner E2E interaction fixture",
      generatedAt: "2026-09-05T12:01:00.000Z",
      expected: executionIds,
      catalog,
      entries,
    }),
  );

  const filters = page
    .locator("[data-report-query]")
    .locator("..")
    .locator("..");
  const tabs = page.locator(".suite-nav");
  await expect(page.locator("[data-report-result]")).toHaveText(
    "4 of 4 tests shown",
  );
  await expect(page.locator("[data-gallery-item]")).toHaveCount(4);
  expect(
    await filters.evaluate((element) => getComputedStyle(element).position),
  ).toBe("static");
  expect(
    await tabs.evaluate((element) =>
      element.nextElementSibling?.classList.contains("report-filters"),
    ),
  ).toBe(true);

  const firstTable = page.locator(".matrix").first();
  const widthsBefore = await firstTable
    .locator("thead th")
    .evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().width),
    );
  await firstTable.locator("details summary").first().click();
  const widthsAfter = await firstTable
    .locator("thead th")
    .evaluateAll((cells) =>
      cells.map((cell) => cell.getBoundingClientRect().width),
    );
  expect(widthsAfter).toEqual(widthsBefore);

  await page.locator("[data-report-query]").fill("Legacy Claude");
  await expect(page.locator("[data-report-result]")).toHaveText(
    "1 of 4 tests shown",
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
    "2 of 4 tests shown",
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

  await page.keyboard.press("ArrowRight");
  await expect(dialog.locator("[data-gallery-environment]")).toHaveText(
    "Daytona sandbox",
  );
  await expect(dialog.locator("[data-gallery-status]")).toHaveText("failed");
  await expect(dialog.locator("[data-gallery-position]")).toHaveText(
    "Image 2 of 2",
  );

  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  await page.locator("[data-report-reset]").click();
  await page.keyboard.press("/");
  await expect(page.locator("[data-report-query]")).toBeFocused();
});
