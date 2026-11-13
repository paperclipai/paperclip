import { expect, test } from "@playwright/test";
import { observeBrowserBootstrap } from "../runner-e2e/browser-bootstrap-diagnostics";
import { json, setup } from "./agent-chat.shared";

test.use({ serviceWorkers: "allow", trace: "retain-on-failure" });

test("saved task content survives same-URL navigation and reload with a controlling service worker", async ({ page, request }) => {
  test.setTimeout(120_000);
  const fixture = await setup(request);
  const diagnostics = observeBrowserBootstrap(page);
  const title = "Task reload continuity";
  const comment = "Persisted context remains available after a full page load.";
  try {
    // Unassigned backlog work exercises the actual UI without a provider call.
    const issue = await json(await request.post(`/api/companies/${fixture.company.id}/issues`, {
      data: { title, status: "backlog" },
    }));
    await json(await request.post(`/api/issues/${issue.id}/comments`, { data: { body: comment } }));
    const route = `/${fixture.company.issuePrefix}/issues/${issue.identifier}`;
    const assertLoaded = async () => {
      await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(comment, { exact: true })).toBeVisible();
      await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    };
    await page.goto(route, { waitUntil: "domcontentloaded" });
    await assertLoaded();
    await page.waitForFunction(() => Boolean(navigator.serviceWorker?.controller));
    for (let index = 0; index < 3; index += 1) {
      // The warm-continuity eval used same-URL goto, not just location.reload.
      await page.goto(route, { waitUntil: "domcontentloaded" });
      await assertLoaded();
      await page.reload({ waitUntil: "domcontentloaded" });
      await assertLoaded();
    }
    expect(await json(await request.get(`/api/issues/${issue.id}/runs`))).toEqual([]);
  } finally {
    await test.info().attach("browser-bootstrap", {
      contentType: "application/json",
      body: Buffer.from(JSON.stringify(await diagnostics.snapshot(), null, 2)),
    });
    diagnostics.dispose();
    await fixture.restore();
  }
});

test("an interrupted app bundle offers a retry that restores the saved task", async ({ page, request }) => {
  const fixture = await setup(request);
  const title = "Recover interrupted startup";
  const comment = "This saved comment must survive a startup failure.";
  try {
    const issue = await json(await request.post(`/api/companies/${fixture.company.id}/issues`, {
      data: { title, status: "backlog" },
    }));
    await json(await request.post(`/api/issues/${issue.id}/comments`, { data: { body: comment } }));
    const route = `/${fixture.company.issuePrefix}/issues/${issue.identifier}`;
    // Fail the shipped module before React (and its error boundary) can start.
    await page.route("**/assets/*.js", intercepted => intercepted.abort());
    await page.goto(route);
    await expect(page.getByRole("heading", { name: "Paperclip couldn’t start" })).toBeVisible();
    expect(await page.locator("#root").evaluate(root => root.childElementCount)).toBe(0);
    await page.unroute("**/assets/*.js");
    await page.getByRole("button", { name: "Reload page" }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await expect(page.getByText(comment, { exact: true })).toBeVisible();
    await expect(page.getByTestId("task-chat-composer-input")).toBeVisible();
    await expect(page.locator("#paperclip-startup")).toBeHidden();
    expect(new URL(page.url()).pathname).toBe(route);
    expect(await json(await request.get(`/api/issues/${issue.id}/runs`))).toEqual([]);
  } finally {
    await fixture.restore();
  }
});
