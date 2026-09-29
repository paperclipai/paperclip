import { test, expect } from "@playwright/test";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";

// Real browser/module-cache behavior without a Paperclip instance or LLM.
test("development module revalidation bypasses the offline worker across reloads", async ({ page }) => {
  const worker = await readFile(new URL("../../ui/public/sw.js", import.meta.url), "utf8");
  let revalidations = 0;
  const server: Server = createServer((request, response) => {
    if (request.url === "/sw.js") {
      response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-store" });
      response.end(worker);
    } else if (request.url === "/fixture.js") {
      if (request.headers["if-none-match"] === '"fixture-v1"') {
        revalidations++;
        response.writeHead(304); response.end();
      } else {
        response.writeHead(200, { "content-type": "text/javascript", "cache-control": "no-cache", etag: '"fixture-v1"' });
        response.end('document.getElementById("root").textContent = "App mounted";');
      }
    } else {
      response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
      response.end('<div id="root"></div><script type="module" src="/fixture.js"></script>');
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing fixture port");
  const workerModuleRequests: string[] = [];
  page.context().on("request", request => {
    if (request.url().endsWith("/fixture.js") && request.serviceWorker()) workerModuleRequests.push(request.url());
  });
  try {
    await page.goto(`http://127.0.0.1:${address.port}/`);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
    for (let n = 0; n < 3; n++) {
      await page.reload();
      await expect(page.locator("#root")).toHaveText("App mounted");
    }
    expect(revalidations).toBeGreaterThan(0);
    expect(workerModuleRequests).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
