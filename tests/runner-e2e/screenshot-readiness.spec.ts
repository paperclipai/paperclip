import { expect, test } from "@playwright/test";
import { captureLoadedContinuation } from "./continuation-screenshot.js";

const shell = (busy: boolean, title = "Continuation example") => `
  <main data-testid="task-chat-thread"><div aria-busy="${busy}">
    <div data-testid="issue-detail-header"><h2>${title}</h2></div>
    ${busy ? '<div data-testid="task-chat-history-loading">Loading conversation</div>' : '<p>Saved note is ready</p>'}
  </div></main>`;

test("capture waits through app loading and conversation loading", async ({ page }) => {
  await page.setContent(`<p>App loading</p><script>
    setTimeout(() => document.body.innerHTML = ${JSON.stringify(shell(true))}, 150);
    setTimeout(() => document.body.innerHTML = ${JSON.stringify(shell(false))}, 450);
  </script>`);
  let captured = "";
  await captureLoadedContinuation(page, "Continuation example", async () => {
    captured = await page.locator("body").innerText();
    await page.screenshot();
  }, 3000);
  expect(captured).toContain("Saved note is ready");
  expect(captured).not.toContain("Loading");
});

for (const state of ["app-loader", "history-loader", "wrong-task"] as const) {
  test(`does not capture ${state} as a successful checkpoint`, async ({ page }) => {
    await page.setContent(state === "app-loader" ? "<p>App loading</p>" : shell(state === "history-loader", state === "wrong-task" ? "Unrelated task" : undefined));
    let captures = 0;
    await expect(captureLoadedContinuation(page, "Continuation example", async () => {
      captures++;
    }, 250)).rejects.toThrow();
    expect(captures).toBe(0);
  });
}
