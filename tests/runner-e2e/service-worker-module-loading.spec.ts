import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";

// Isolate the browser loader with the real worker. This is not a native-run
// qualification test: no Paperclip data, credentials or providers are used.
test.use({ serviceWorkers: "allow", trace: "on" });

test("a wide development module graph loads before and after service-worker takeover", async ({ page, context }) => {
  test.setTimeout(60_000);
  const moduleCount = 1_500;
  const worker = readFileSync(new URL("../../ui/public/sw.js", import.meta.url), "utf8");
  const entry = Array.from({ length: moduleCount }, (_, i) => `import "./part-${i}.js";`).join("\n") +
    '\ndocument.getElementById("root").innerHTML = "<main>Ready</main>";';
  const failures: { path: string; error: string | null; worker: boolean }[] = [];
  let forwardedModules = 0;
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://fixture.test").pathname;
    response.setHeader("cache-control", "no-cache");
    if (pathname === "/sw.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(worker);
    } else if (pathname === "/src/entry.js") {
      response.setHeader("content-type", "text/javascript");
      response.end(entry);
    } else if (/^\/src\/part-\d+\.js$/.test(pathname)) {
      response.setHeader("content-type", "text/javascript");
      // A bounded delay keeps the import fan-out outstanding, rather than
      // making the resource-pressure regression depend on host speed.
      setTimeout(() => response.end("export {};"), 5);
    } else {
      response.setHeader("content-type", "text/html");
      response.end('<div id="root"></div><script type="module" src="/src/entry.js"></script>');
    }
  });
  context.on("request", request => {
    if (request.serviceWorker() && new URL(request.url()).pathname.startsWith("/src/")) forwardedModules += 1;
  });
  context.on("requestfailed", request => failures.push({
    path: new URL(request.url()).pathname,
    error: request.failure()?.errorText ?? null,
    worker: Boolean(request.serviceWorker()),
  }));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("main")).toHaveText("Ready");
    expect(failures).toEqual([]);
    await page.evaluate(async () => {
      await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
    });
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));
    // Match the full same-URL navigation in the failed live attempt.
    await page.goto(origin, { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("main")).toHaveText("Ready");
    expect(failures).toEqual([]);
    expect(forwardedModules).toBe(0);
  } finally {
    await test.info().attach("module-loading", {
      contentType: "application/json",
      body: Buffer.from(JSON.stringify({ moduleCount, forwardedModules, failures })),
    });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});
