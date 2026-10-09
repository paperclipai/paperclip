import { test, expect } from "@playwright/test";

const base = process.env.RECOVERY_STORYBOOK_URL;
const states = [
  "working",
  "reconnecting",
  "retry-scheduled",
  "waiting-for-workspace",
  "finalizing",
  "safely-replaced",
  "recovery-exhausted",
  "uncertain-action",
  "unavailable-recovery",
  "waiting-for-access",
  "waiting-for-answer",
  "narrow-long-error",
  "composer-during-recovery",
  "task-list-badges",
  "task-list-badges-canonical",
  "native-chat-status-labels",
  "legacy-chat-status-labels",
  "dashboard-status-labels",
];
test.describe("offline execution recovery stories", () => {
  test.skip(
    !base,
    "Build and serve Storybook, then set RECOVERY_STORYBOOK_URL to its loopback URL.",
  );
  for (const theme of ["light", "dark"])
    for (const narrow of [false, true])
      for (const state of states) {
        test(`${state}: ${theme}, ${narrow ? "narrow" : "desktop"}, reduced motion`, async ({
          page,
        }, info) => {
          await page.setViewportSize({
            width: narrow ? 390 : 1280,
            height: 720,
          });
          await page.emulateMedia({
            reducedMotion: "reduce",
            colorScheme: theme as "light" | "dark",
          });
          const origin = new URL(base!).origin;
          await page.route("**/*", (route) =>
            new URL(route.request().url()).origin === origin
              ? route.continue()
              : route.abort(),
          );
          await page.goto(
            `${base}/iframe.html?id=tasks-execution-recovery--${state}&viewMode=story&globals=theme:${theme}`,
          );
          await expect(page.locator("#storybook-root")).not.toBeEmpty();
          await expect(page.getByRole("dialog")).toHaveCount(0);
          await expect(page.getByRole("button", { name: /Inspect run|Reconcile and continue/ })).toHaveCount(0);
          await expect(page.locator("[data-execution-phase]")).toHaveCount(0);
          if (state === "composer-during-recovery") {
            await expect(page.getByRole("textbox", { name: "Message draft" })).toHaveValue("Continue with the launch notes.");
          }
          if (state.startsWith("task-list-badges")) {
            for (const label of ["Working", "Finishing", "Waiting for access", "Waiting for answer", "Reconnecting", "Retry scheduled", "Recovery needed"]) {
              await expect(page.getByText(label, { exact: true })).toHaveCount(0);
            }
          }
          expect(
            await page.evaluate(
              () => document.documentElement.scrollWidth <= window.innerWidth,
            ),
          ).toBe(true);
          await page.screenshot({
            path: info.outputPath(
              `${state}-${theme}-${narrow ? "narrow" : "desktop"}.png`,
            ),
            fullPage: true,
          });

        });
      }
});
