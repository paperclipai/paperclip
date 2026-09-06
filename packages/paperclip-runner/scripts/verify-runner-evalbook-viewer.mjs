#!/usr/bin/env node
// Execute the built viewer against actual generated pages, without a runner API.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile, readdir, mkdir } from "node:fs/promises";
import { resolve, join, extname, sep } from "node:path";
import { chromium } from "@playwright/test";

const arg = (name) => process.argv[process.argv.indexOf(name) + 1];
if (!process.argv.includes("--report-root"))
  throw new Error("--report-root is required");
const root = resolve(arg("--report-root"));
const screenshots = process.argv.includes("--screenshots")
  ? resolve(arg("--screenshots"))
  : null;
const samples = new Map();
for (const entry of await readdir(join(root, "attempts"), {
  withFileTypes: true,
})) {
  if (!entry.isDirectory()) continue;
  const route = `attempts/${entry.name}/index.html`;
  const html = await readFile(join(root, route), "utf8");
  const encoded =
    html.match(
      /<script type="application\/json" id="paperclip-eval-report">([^<]*)<\/script>/u,
    )?.[1] ??
    html.match(/window\.__PAPERCLIP_EVAL_REPORT__=(.*?);<\/script>/su)?.[1];
  assert.ok(encoded, `Attempt lacks canonical viewer payload: ${route}`);
  const payload = JSON.parse(encoded);
  const messages = payload.view.turns
    .flatMap((turn) => turn.items)
    .filter((item) => ["user_message", "agent_message"].includes(item.kind));
  const kind = !messages.length
    ? "missing-recording"
    : payload.passed
      ? "passed"
      : "failed";
  if (!samples.has(kind)) samples.set(kind, { route, payload });
}
assert.ok(samples.size, "No attempt pages to verify");
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://report.invalid");
    const path = resolve(root, `.${decodeURIComponent(url.pathname)}`);
    if (!path.startsWith(`${root}${sep}`)) {
      res.writeHead(403).end();
      return;
    }
    const mime = {
      ".html": "text/html",
      ".js": "text/javascript",
      ".css": "text/css",
      ".woff2": "font/woff2",
    };
    res.writeHead(200, {
      "Content-Type": mime[extname(path)] ?? "application/octet-stream",
    });
    res.end(await readFile(path));
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  if (screenshots) await mkdir(screenshots, { recursive: true });
  for (const [kind, { route, payload }] of samples) {
    const page = await browser.newPage({
      viewport: { width: 1440, height: 1000 },
    });
    const errors = [];
    const requests = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => requests.push(request.url()));
    await page.goto(`${origin}/${route}`, { waitUntil: "networkidle" });
    await page.locator(".pit-thread").waitFor({ state: "visible" });
    assert.equal(
      await page.locator("h1").textContent(),
      payload.view.issue.title,
    );
    assert.equal(
      await page
        .getByRole("button", { name: "Reset scenario", exact: true })
        .count(),
      0,
    );
    assert.equal(
      await page.getByText("Loading company state…", { exact: true }).count(),
      0,
    );
    assert.ok(
      await page.getByText(payload.run.model, { exact: false }).count(),
      "Model missing from inspector",
    );
    const tool = page
      .locator('[data-thread-item="tool_activity"] summary')
      .first();
    if (await tool.count()) {
      await tool.click();
      assert.ok(
        await page.locator('[data-thread-item="tool_activity"][open]').count(),
      );
      if (payload.publication)
        assert.ok(
          await page
            .getByText("Arguments withheld from public replay.", {
              exact: false,
            })
            .count(),
        );
    }
    if (payload.publication) {
      assert.ok(
        await page
          .getByText(payload.publication.notice, { exact: true })
          .count(),
      );
      assert.ok(
        requests.every(
          (url) => url.startsWith(origin) && !url.includes("/api/"),
        ),
        "Replay attempted a remote/API request",
      );
    }
    assert.deepEqual(errors, [], `Viewer errors for ${kind}`);
    if (screenshots)
      await page.screenshot({
        path: join(screenshots, `${kind}.png`),
        fullPage: true,
      });
    await page
      .getByRole("link", { name: "← All results", exact: true })
      .click();
    assert.equal(new URL(page.url()).pathname, "/index.html");
    await page.goto(`${origin}/${route}`, { waitUntil: "networkidle" });
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".pit-thread").waitFor({ state: "visible" });
    assert.deepEqual(errors, [], `Reload errors for ${kind}`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator(".pit-thread").waitFor({ state: "visible" });
    await page.close();
    console.log(
      `Verified ${kind}: chat, read-only controls, navigation, reload and narrow viewport`,
    );
  }
} finally {
  await browser?.close();
  await new Promise((done) => server.close(done));
}
