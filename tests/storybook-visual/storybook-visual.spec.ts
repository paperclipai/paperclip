import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test, type Page } from "@playwright/test";

// One screenshot test per story per theme, generated from the built
// Storybook's index.json. Baselines live outside git and are downloaded into
// the configured Playwright snapshot directory before this suite runs.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const indexJsonPath = join(repoRoot, "ui", "storybook-static", "index.json");

if (!existsSync(indexJsonPath)) {
  throw new Error(`Missing ${indexJsonPath}; run \`pnpm build-storybook\` first.`);
}

type IndexEntry = { id: string; type: string; title: string; name: string };
const entries = Object.values(
  (JSON.parse(readFileSync(indexJsonPath, "utf8")) as { entries: Record<string, IndexEntry> })
    .entries,
).filter((entry) => entry.type === "story");

// Freeze wall-clock time so relative timestamps, spinners driven by
// setInterval, and Date.now()-based rendering are deterministic.
const FIXED_TIME = new Date("2026-06-24T12:00:00.000Z");

const THEMES = ["dark", "light"] as const;

// Stories whose components schedule a delayed state flip (e.g. a "recently
// focused" highlight that clears via setTimeout). Wait past the flip so the
// screenshot always captures the settled terminal state.
const EXTRA_SETTLE_MS: Record<string, number> = {
  // IssueContinuationHandoff clears its focus highlight after 3s + 1s fade.
  "product-issue-management--full-surface-matrix": 4500,
};

// Stories with a genuinely bimodal render race that cannot be settled by
// waiting. The affected element is masked (solid overlay in both baseline and
// comparison) so the rest of the story still snapshot-verifies.
const MASKED_SELECTORS: Record<string, string> = {
  // DocumentAnnotationLayer's ::highlight range over "two selectors" ends 1-2
  // characters short on ~half of renders (anchor offsets race). Mask only the
  // paragraph that carries that highlight.
  "product-documents-annotations--integrated-mobile-bottom-sheet":
    'p:has-text("Use a sidecar anchor made from")',
};

async function renderStory(page: Page, storyId: string, theme: (typeof THEMES)[number]) {
  // Freeze Date only (not timers): page.clock.setFixedTime breaks React
  // rendering in several stories (intermittent "must be used within Provider"
  // errors), so shim the Date constructor instead.
  await page.addInitScript(`{
    const fixedNow = ${FIXED_TIME.getTime()};
    const RealDate = Date;
    class FixedDate extends RealDate {
      constructor(...args) {
        if (args.length === 0) { super(fixedNow); } else { super(...args); }
      }
      static now() { return fixedNow; }
    }
    FixedDate.parse = RealDate.parse;
    FixedDate.UTC = RealDate.UTC;
    window.Date = FixedDate;
  }`);
  await page.goto(
    `/iframe.html?id=${encodeURIComponent(storyId)}&viewMode=story&globals=theme:${theme}`,
    { waitUntil: "load" },
  );
  // Wait for Storybook to finish rendering (sb-show-main) or error out.
  // Don't check #storybook-root children: portal-only stories (open dialogs,
  // sheets) render into document.body and leave the root empty.
  await page.waitForFunction(() => {
    const body = document.body;
    return (
      body.classList.contains("sb-show-main") ||
      body.classList.contains("sb-show-errordisplay")
    );
  });
  const errored = await page.locator(".sb-show-errordisplay").count();
  expect(errored, `story ${storyId} threw during render`).toBe(0);
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const settleMs = EXTRA_SETTLE_MS[storyId];
  if (settleMs) await page.waitForTimeout(settleMs);
}

for (const entry of entries) {
  for (const theme of THEMES) {
    test(`${entry.id} [${theme}]`, async ({ page }) => {
      await renderStory(page, entry.id, theme);
      const maskSelector = MASKED_SELECTORS[entry.id];
      await expect(page).toHaveScreenshot(`${entry.id}--${theme}.png`, {
        fullPage: true,
        mask: maskSelector ? [page.locator(maskSelector)] : undefined,
      });
    });
  }
}


for (const theme of THEMES) {
  for (const width of [1200, 390]) {
    for (const state of [
      { story: "native-runner-default", runner: "Automatic (default)" },
      { story: "explicit-legacy-runner", runner: "Legacy runner" },
      { story: "existing-legacy-runner", runner: "Legacy runner" },
    ]) {
      test(`runner UI qualification: ${state.story} ${theme} ${width}px`, async ({ page }, testInfo) => {
        const pageErrors: string[] = [];
        page.on("pageerror", error => pageErrors.push(error.message));
        await page.setViewportSize({ width, height: 900 });
        await renderStory(page, `product-agent-management--${state.story}`, theme);
        const adapter = page.locator('[data-config-section="adapter"]');
        const harness = page.getByRole("button", { name: "Harness", exact: true });
        await expect(harness).toContainText("Codex");
        await expect(adapter.locator("select")).toHaveCount(0);
        await harness.focus();
        await page.keyboard.press("ArrowDown");
        const harnessChoices = page.getByRole("listbox", { name: "Harness", exact: true });
        await expect(harnessChoices).toBeVisible();
        await expect(harnessChoices.getByRole("option", { name: /Paperclip Runner/ })).toHaveCount(0);
        await page.keyboard.press("End");
        await expect(harnessChoices.locator('[role="option"]:not(:disabled)').last()).toBeFocused();
        await page.keyboard.press("Home");
        await expect(harnessChoices.locator('[role="option"]:not(:disabled)').first()).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(harnessChoices).toBeHidden();
        await expect(harness).toBeFocused();
        await adapter.locator("summary").filter({ hasText: "Advanced" }).click();
        const runner = page.getByRole("button", { name: "Runner", exact: true });
        await expect(runner).toHaveText(state.runner);
        for (const label of ["Runner", "Managed harness", "Model", "Thinking effort"]) {
          const trigger = page.getByRole("button", { name: label, exact: true });
          await expect(trigger).toHaveAttribute("aria-haspopup", "listbox");
          await trigger.scrollIntoViewIfNeeded();
          await trigger.click();
          const popup = page.locator('[data-slot="popover-content"]').last();
          await expect(popup).toBeVisible();
          const bounds = await popup.evaluate(element => {
            const r = element.getBoundingClientRect();
            return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: innerWidth, height: innerHeight };
          });
          expect(bounds.left, `${label} left edge`).toBeGreaterThanOrEqual(0);
          expect(bounds.right, `${label} right edge`).toBeLessThanOrEqual(bounds.width + 1);
          expect(bounds.top, `${label} top edge`).toBeGreaterThanOrEqual(0);
          expect(bounds.bottom, `${label} bottom edge`).toBeLessThanOrEqual(bounds.height + 1);
          if (label === "Runner") {
            const choices = page.getByRole("listbox", { name: "Runner", exact: true });
            await expect(choices.getByRole("option", { name: state.runner, exact: true })).toBeFocused();
            await page.screenshot({ path: testInfo.outputPath("runner-dropdown.png"), fullPage: true });
          }
          if (label === "Runner" && state.runner === "Legacy runner") {
            await page.keyboard.press("End");
            await expect(page.getByRole("option", { name: "Legacy runner", exact: true })).toBeFocused();
            await page.keyboard.press("Enter");
          } else {
            await page.keyboard.press("Escape");
          }
          await expect(popup).toBeHidden();
          await expect(trigger).toBeFocused();
        }
        await expect(runner).toHaveText(state.runner);
        if (state.story === "existing-legacy-runner") {
          const name = page.locator('[data-config-section="identity"] input').first();
          await expect(name).toHaveValue("CodexCoder");
          await name.fill("Legacy QA Reviewer");
          const save = page.getByRole("button", { name: "Save", exact: true }).first();
          await expect(save).toBeVisible();
          await page.screenshot({ path: testInfo.outputPath("unrelated-edit-viewport.png") });
          await page.screenshot({ path: testInfo.outputPath("unrelated-edit.png"), fullPage: true });
          await save.click();
          await expect(name).toHaveValue("Legacy QA Reviewer");
          // The production edit fixture commits onSave into its agent state.
          // A cleared dirty footer plus a reverse edit proves the new baseline
          // was saved, rather than merely retaining the draft input value.
          await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
          await name.fill("CodexCoder");
          await expect(save).toBeVisible();
          await save.click();
          await expect(name).toHaveValue("CodexCoder");
          await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Runner", exact: true })).toHaveText("Legacy runner");
          await expect(page.getByRole("button", { name: "Harness", exact: true })).toContainText("Codex");
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        expect(pageErrors, pageErrors.join("\n")).toEqual([]);
        await page.screenshot({ path: testInfo.outputPath("configuration.png"), fullPage: true });
      });
    }
  }
}
