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
  "keyboard-inspection",
  "reconciliation-entry",
  "reconciliation-error",
  "reconciliation-saving",
  "reconciliation-completed",
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
          if (state.startsWith("reconciliation-")) {
            if (state === "reconciliation-completed") {
              await expect(page.getByRole("status")).toHaveText(
                "Decision recorded. Continuation is queued.",
              );
              await expect(
                page.getByRole("button", {
                  name: "Reconcile and continue",
                  exact: true,
                }),
              ).toBeFocused();
            } else {
              const dialog = page.getByRole("dialog", {
                name: "Reconcile execution",
              });
              await expect(dialog).toBeVisible();
              if (state === "reconciliation-error")
                await expect(dialog.getByRole("alert")).toContainText(
                  "previous provider is still running",
                );
              if (state === "reconciliation-saving")
                await expect(
                  dialog.getByRole("button", { name: "Recording decision…" }),
                ).toBeDisabled();
              if (state === "reconciliation-entry")
                await expect(
                  dialog.getByRole("button", { name: "Record and continue" }),
                ).toBeDisabled();
              await expect(dialog).toHaveCSS("animation-name", "none");
              await dialog.getByRole("button").last().scrollIntoViewIfNeeded();
            }
          } else {
            const status = page.locator(
              "#storybook-root [data-execution-phase]",
            );
            await expect(status).toBeVisible();
            for (const icon of await status.locator("svg").all())
              await expect(icon).toHaveCSS("animation-name", "none");
            if (state === "keyboard-inspection")
              await expect(
                page.getByRole("button", { name: "Inspect run" }),
              ).toBeFocused();
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
          if (state === "reconciliation-entry") {
            await page.keyboard.press("Escape");
            await expect(page.getByRole("dialog")).not.toBeVisible();
            await expect(
              page.getByRole("button", {
                name: "Reconcile and continue",
                exact: true,
              }),
            ).toBeFocused();
          }
        });
      }
});
