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
  // The unchanged dialog character animates through its SVG runtime even with
  // reduced motion. Keep the harness picker and footer fully visible.
  "agents-codex-runner-creation--experimental-native-harnesses":
    '[role="dialog"] [data-slot="agent-avatar"]',
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
  const codexCreation = storyId.startsWith("agents-codex-runner-creation--");
  const codexSettings = /^agents-configuration-refresh--(?:codex-runtime|runner-runtime|codex-(?:legacy|native)-)/.test(storyId);
  if (codexCreation || codexSettings) {
    // These production journeys fetch accounts and then exercise controls in
    // play. sb-show-main precedes both; a stable loading frame proves neither.
    await page.waitForFunction(id => {
      const preview = (window as unknown as { __STORYBOOK_PREVIEW__?: { storyRenders?: Array<{ id: string; phase: string }> } }).__STORYBOOK_PREVIEW__;
      return preview?.storyRenders?.some(render => render.id === id && render.phase === "finished");
    }, storyId);
    const expected = storyId.endsWith("--experimental-native-harnesses") ? page.getByRole("button", { name: "Experimental harness", exact: true })
      : storyId.endsWith("--task-ready") ? page.getByRole("heading", { name: /is ready/ })
      : page.getByRole("button", { name: codexCreation || storyId.endsWith("--codex-legacy-advanced") ? "Runner" : "Harness", exact: true });
    await expect(expected).toBeVisible();
  }
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  const settleMs = EXTRA_SETTLE_MS[storyId];
  if (settleMs) await page.waitForTimeout(settleMs);
}

for (const entry of entries) {
  for (const theme of THEMES) {
    test(`${entry.id} [${theme}]`, async ({ page }) => {
      await renderStory(page, entry.id, theme);
      // The fixture avatar's SVG snooze marks animate independently of reduced
      // motion. Exclude the unchanged avatar; keep harness branding and every
      // setup control in these production creation captures.
      const maskSelector = MASKED_SELECTORS[entry.id] ?? (entry.id.startsWith("agents-codex-runner-creation--") ? 'header [data-slot="agent-avatar"]' : undefined);
      await expect(page).toHaveScreenshot(`${entry.id}--${theme}.png`, {
        fullPage: true,
        mask: maskSelector ? [page.locator(maskSelector)] : undefined,
      });
    });
  }
}
