import { expect, test } from "@playwright/test";
import { observeBrowserBootstrap } from "./browser-bootstrap-diagnostics.js";

const html = '<div id="root"></div><script type="module" src="/entry.js?private=do-not-record"></script>';

test("records an empty root and pending module, then recognizes completed startup", async ({ page }) => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route("http://bootstrap.test/**", async route => {
    if (new URL(route.request().url()).pathname === "/entry.js") {
      await gate;
      await route.fulfill({ contentType: "text/javascript", body: 'document.getElementById("root").innerHTML = "<main>Ready</main>";' });
    } else await route.fulfill({ contentType: "text/html", body: html });
  });
  const diagnostics = observeBrowserBootstrap(page);
  try {
    await page.goto("http://bootstrap.test/", { waitUntil: "commit" });
    await expect.poll(async () => (await diagnostics.snapshot()).pendingModules).toEqual(["/entry.js"]);
    const before = await diagnostics.snapshot();
    expect(before.state).toMatchObject({ rootPresent: true, rootChildCount: 0, serviceWorkerControlled: false });
    expect(JSON.stringify(before)).not.toContain("do-not-record");
    release();
    await expect(page.getByRole("main")).toHaveText("Ready");
    await expect.poll(async () => (await diagnostics.snapshot()).pendingModuleCount).toBe(0);
    expect((await diagnostics.snapshot()).state?.rootChildCount).toBe(1);
  } finally { release(); diagnostics.dispose(); }
});

for (const status of [304, 503]) {
  test(`retains module status ${status} without credentials and clears it on navigation`, async ({ page }) => {
    await page.route("http://bootstrap.test/**", async route => {
      const pathname = new URL(route.request().url()).pathname;
      await route.fulfill(pathname === "/entry.js" ? { status, body: "" }
        : { contentType: "text/html", body: pathname === "/ready" ? '<div id="root">Ready</div>' : html });
    });
    const diagnostics = observeBrowserBootstrap(page);
    try {
      await page.goto("http://bootstrap.test/", { waitUntil: "load" });
      expect((await diagnostics.snapshot()).moduleResponses).toEqual([{ path: "/entry.js", status }]);
      await page.goto("http://bootstrap.test/ready");
      expect((await diagnostics.snapshot()).moduleResponses).toEqual([]);
    } finally { diagnostics.dispose(); }
  });
}
