import { createServer, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

// Exercise the actual HTML entry independently of React, the app server, and
// providers. A React error boundary cannot handle a failed module import.
const html = readFileSync(new URL("../../ui/index.html", import.meta.url), "utf8");
// Offline fallback belongs to stamped production workers. Development workers
// deliberately leave requests to Vite; service-worker-reload.spec.ts covers that.
const worker = readFileSync(new URL("../../ui/public/sw.js", import.meta.url), "utf8")
  .replace("__PAPERCLIP_BUILD_ID__", "bootstrap-recovery-test");

test.use({ serviceWorkers: "allow" });

test.describe("browser bootstrap recovery", () => {
  let mode: "ready" | "failed" | "pending" | "throws";
  let pending: ServerResponse[];
  let baseURL: string;
  let server: ReturnType<typeof createServer>;
  const readyModule = 'document.getElementById("root").innerHTML = "<main>Task ready</main>";';

  test.beforeEach(async () => {
    mode = "ready";
    pending = [];
    server = createServer((request, response) => {
      const pathname = new URL(request.url!, "http://localhost").pathname;
      if (pathname === "/sw.js") {
        response.writeHead(200, { "Content-Type": "text/javascript" });
        response.end(worker);
      } else if (pathname === "/src/main.tsx") {
        response.writeHead(200, { "Content-Type": "text/javascript" });
        response.end('import "/dependency.js";');
      } else if (pathname === "/dependency.js") {
        if (mode === "pending") {
          pending.push(response);
          return;
        }
        response.writeHead(mode === "failed" ? 503 : 200, {
          "Content-Type": "text/javascript", "Cache-Control": "no-store",
        });
        response.end(mode === "throws" ? 'throw new Error("startup fixture failure")' : readyModule);
      } else if (pathname === "/tasks/reload") {
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(html);
      } else {
        response.writeHead(404);
        response.end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    baseURL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  test.afterEach(async () => {
    for (const response of pending) response.destroy();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  for (const controlled of [false, true]) {
    test(`failed dependency offers a working retry (${controlled ? "service worker controlled" : "first visit"})`, async ({ page }) => {
      if (controlled) {
        await page.goto(`${baseURL}/tasks/reload`);
        await page.evaluate(async () => {
          await navigator.serviceWorker.register("/sw.js");
          await navigator.serviceWorker.ready;
        });
        await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
      }
      mode = "failed";
      await page.goto(`${baseURL}/tasks/reload`);
      await expect(page.getByRole("heading", { name: "Paperclip couldn’t start" })).toBeVisible();
      expect(await page.locator("#root").evaluate(root => root.childElementCount)).toBe(0);
      mode = "ready";
      await page.getByRole("button", { name: "Reload page" }).click();
      await expect(page.getByRole("main")).toHaveText("Task ready");
      await expect(page.locator("#paperclip-startup")).toBeHidden();
      await expect(page).toHaveURL(`${baseURL}/tasks/reload`);
    });
  }

  test("offline retries keep a recovery action until the connection returns", async ({ page, context }) => {
    await page.goto(`${baseURL}/tasks/reload`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    mode = "failed";
    await page.reload();
    await expect(page.getByRole("heading", { name: "Paperclip couldn’t start" })).toBeVisible();
    await context.setOffline(true);
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await page.getByRole("button", { name: "Reload page" }).click();
        await expect(page.getByRole("heading", { name: "Paperclip is offline" })).toBeVisible();
        await expect(page.getByRole("button", { name: "Reload page" })).toBeVisible();
      }
    } finally {
      await context.setOffline(false);
    }
    mode = "ready";
    await page.getByRole("button", { name: "Reload page" }).click();
    await expect(page.getByRole("main")).toHaveText("Task ready");
    await expect(page).toHaveURL(`${baseURL}/tasks/reload`);
  });

  test("a stalled import shows recovery and dismisses it when startup eventually succeeds", async ({ page }) => {
    mode = "pending";
    await page.clock.install();
    await page.goto(`${baseURL}/tasks/reload`, { waitUntil: "commit" });
    await expect.poll(() => pending.length).toBe(1);
    await page.clock.runFor(30_000);
    await expect(page.getByRole("heading", { name: "Paperclip is taking longer to load" })).toBeVisible();
    // Late success must recover in place, without a reload or losing the route.
    pending[0]!.writeHead(200, { "Content-Type": "text/javascript" });
    pending[0]!.end(readyModule);
    await expect(page.getByRole("main")).toHaveText("Task ready");
    await expect(page.locator("#paperclip-startup")).toBeHidden();
    await expect(page).toHaveURL(`${baseURL}/tasks/reload`);
  });

  test("module evaluation errors before React mounts show recovery", async ({ page }) => {
    mode = "throws";
    await page.goto(`${baseURL}/tasks/reload`);
    await expect(page.getByRole("heading", { name: "Paperclip couldn’t start" })).toBeVisible();
  });

  test("completed startup disables the timer and error handlers", async ({ page }) => {
    await page.clock.install();
    await page.goto(`${baseURL}/tasks/reload`);
    await expect(page.getByRole("main")).toHaveText("Task ready");
    await page.evaluate(() => window.dispatchEvent(new ErrorEvent("error", { message: "later unrelated error" })));
    await page.clock.runFor(60_000);
    await expect(page.locator("#paperclip-startup")).toBeHidden();
    await expect(page.getByRole("main")).toHaveText("Task ready");
  });
});
