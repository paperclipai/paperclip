import { expect, test } from "@playwright/test";
import { captureLoadedContinuation, waitForTaskIdentity, waitForTaskChatRendered } from "./continuation-screenshot.js";

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


test("mutable titles do not change task identity, but wrong routes and identifiers fail", async ({ page }) => {
  await page.route("https://fixture.invalid/**", route => route.fulfill({ contentType: "text/html",
    body: `<nav aria-label="breadcrumb"><span aria-current="page"><span>Renamed task</span><span data-slot="task-title-identifier">RUN-1</span></span></nav>${shell(false, "Renamed task")}` }));
  await page.goto("https://fixture.invalid/RUN/issues/RUN-1");
  await waitForTaskIdentity(page, "/RUN/issues/RUN-1", "RUN-1", 500);
  await waitForTaskChatRendered(page, undefined, 500);
  for (const [route, identifier] of [["/RUN/issues/RUN-2", "RUN-1"], ["/RUN/issues/RUN-1", "RUN-2"], ["/RUN/issues/RUN-1", "RUN"]]) {
    await expect(waitForTaskIdentity(page, route, identifier, 150)).rejects.toThrow();
  }
  await expect(waitForTaskChatRendered(page, "Original task title", 150)).rejects.toThrow();
  // An identifier in the mutable title or outside the breadcrumb is not identity.
  await page.setContent(`<nav aria-label="breadcrumb"><span aria-current="page"><span>RUN-1 renamed task</span><span data-slot="task-title-identifier">RUN-2</span></span></nav><span data-slot="task-title-identifier">RUN-1</span>${shell(false)}`);
  await expect(waitForTaskIdentity(page, "/RUN/issues/RUN-1", "RUN-1", 150)).rejects.toThrow();
});
