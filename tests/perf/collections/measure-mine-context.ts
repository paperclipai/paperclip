import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { arch, loadavg, platform } from "node:os";
import { chromium, expect, request, type APIRequestContext } from "@playwright/test";

type Fixture = {
  company: { id: string; issuePrefix: string };
  parents: Array<{ id: string }>;
  children: Array<{ id: string }>;
};
type Arm = "baseline" | "candidate";
declare global {
  interface Window { __mineContextMeasure: { first: number | null } }
}

function loopbackOrigin(value: string | undefined, name: string) {
  assert.ok(value, `Set ${name} to a disposable local production UI origin.`);
  const url = new URL(value);
  assert.ok(["http:", "https:"].includes(url.protocol)
    && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash,
  `${name} must be an exact loopback origin.`);
  return url.origin;
}
const origins = {
  baseline: loopbackOrigin(process.env.INBOX_BASELINE_URL, "INBOX_BASELINE_URL"),
  candidate: loopbackOrigin(process.env.INBOX_CANDIDATE_URL, "INBOX_CANDIDATE_URL"),
};
assert.notEqual(origins.baseline, origins.candidate, "Use distinct baseline and candidate UI origins.");
const pairs = Number(process.env.INBOX_PAIRS ?? 5);
assert.ok(Number.isSafeInteger(pairs) && pairs > 0, "INBOX_PAIRS must be a positive integer.");
const fixtureFile = process.env.INBOX_FIXTURE_FILE ?? "test-results/collections/mine-context-fixture.json";
const output = process.env.INBOX_OUTPUT ?? "test-results/collections/mine-context-timings.json";
assert.notEqual(path.resolve(fixtureFile), path.resolve(output), "Fixture and report paths must differ.");

async function api(client: APIRequestContext, method: string, url: string, data?: unknown) {
  const response = await client.fetch(`/api${url}`, { method, data });
  assert.ok(response.ok(), `${method} ${url} returned HTTP ${response.status()}.`);
  return response.status() === 204 ? null : response.json();
}
async function retainFixture(client: APIRequestContext): Promise<Fixture> {
  const saved = await fs.readFile(fixtureFile, "utf8").then(JSON.parse).catch(error => {
    if (error.code !== "ENOENT") throw error;
    return null;
  }) as Fixture | null;
  if (saved) {
    assert.ok(saved.company?.id && saved.company.issuePrefix
      && saved.parents.length === 4 && saved.children.length === 30, "Invalid retained fixture.");
    return saved;
  }
  const company = await api(client, "POST", "/companies", { name: "Mine parent context performance" });
  const fixture: Fixture = { company: { id: company.id, issuePrefix: company.issuePrefix }, parents: [], children: [] };
  const create = async (title: string, status: string, parentId?: string) => {
    const row = await api(client, "POST", `/companies/${company.id}/issues`, { title, status, parentId });
    return { id: row.id as string };
  };
  for (let index = 0; index < 4; index++) {
    fixture.parents.push(await create(`Parent ${index}`, index === 0 ? "blocked" : "done"));
  }
  for (let index = 0; index < 30; index++) {
    fixture.children.push(await create(`Inbox child ${index}`, "todo", fixture.parents[index % 4]!.id));
  }
  for (const parent of fixture.parents.slice(1)) await api(client, "POST", `/issues/${parent.id}/inbox-archive`, {});
  await fs.mkdir(path.dirname(fixtureFile), { recursive: true });
  await fs.writeFile(fixtureFile, JSON.stringify(fixture, null, 2));
  return fixture;
}

const clients = {
  baseline: await request.newContext({ baseURL: origins.baseline }),
  candidate: await request.newContext({ baseURL: origins.candidate }),
};
const samples: Array<Record<string, unknown>> = [];
let expectedRowIds: Array<string | null> | undefined;
let fixture: Fixture | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const save = async () => {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({
    pairs, fixture, origins, rowSequenceReference: expectedRowIds,
    settings: { viewport: "1440x900", httpCache: "fresh context", serviceWorkers: "blocked",
      queryCache: "empty for cold, retained for warm and Back", cpu: "native", network: "loopback",
      readiness: "cold: browser clock to first Mine row; warm/Back: host clock around browser actions",
      node: process.version, platform: platform(), arch: arch(), browser: browser?.version() },
    samples,
  }, null, 2));
};
try {
  for (const arm of ["baseline", "candidate"] as const) {
    const response = await clients[arm].get("/");
    assert.ok(response.ok(), `${arm} UI is unavailable.`);
    const html = await response.text();
    assert.ok(/src=["']\/assets\/[^"']+\.js["']/.test(html) && !html.includes("/@vite/client"),
      `${arm} must serve a production UI build.`);
  }
  fixture = await retainFixture(clients.candidate);
  for (const arm of ["baseline", "candidate"] as const) await api(clients[arm], "GET", `/companies/${fixture.company.id}`);
  await api(clients.candidate, "PUT", `/companies/${fixture.company.id}/workspace-preferences/me`, { coordinatorWorkspaceEnabled: true });
  browser = await chromium.launch();
  for (let pair = 0; pair < pairs; pair++) {
    const order: Arm[] = pair % 2 ? ["candidate", "baseline"] : ["baseline", "candidate"];
    for (const arm of order) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
      const page = await context.newPage();
      const errors: string[] = [];
      const reads: Array<{ view: string | null; ids: number }> = [];
      let rowIds: Array<string | null> | undefined;
      page.on("pageerror", error => errors.push(error.message));
      page.on("request", request => {
        const url = new URL(request.url());
        if (url.pathname.endsWith("/issues")) reads.push({ view: url.searchParams.get("view"), ids: url.searchParams.get("ids")?.split(",").length ?? 0 });
      });
      try {
        await page.addInitScript(() => {
          window.__mineContextMeasure = { first: null };
          const observer = new MutationObserver(() => {
            if (window.__mineContextMeasure.first === null && location.pathname.endsWith("/inbox/mine") && document.querySelector("[data-inbox-item]")) {
              window.__mineContextMeasure.first = performance.now();
              observer.disconnect();
            }
          });
          observer.observe(document, { subtree: true, childList: true });
        });
        await page.goto(`${origins[arm]}/${fixture.company.issuePrefix}/inbox/mine`);
        const rows = page.locator("[data-inbox-item]");
        await expect(rows.first()).toBeVisible();
        const cold = await page.evaluate(() => window.__mineContextMeasure.first);
        assert.ok(cold !== null, "Cold readiness observer did not see a row.");
        rowIds = await page.locator("[data-inbox-issue-link]").evaluateAll(nodes => nodes.map(node => node.getAttribute("href")));
        const firstBox = await rows.first().boundingBox();
        await page.getByRole("tab", { name: "Recent", exact: true }).click();
        await expect(page.getByRole("tab", { name: "Recent", exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(rows.first()).toBeVisible();
        const start = performance.now();
        await page.getByRole("tab", { name: "Mine", exact: true }).click();
        await expect(page.getByRole("tab", { name: "Mine", exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(rows.first()).toBeVisible();
        const warm = performance.now() - start;
        await page.locator("[data-inbox-issue-link]").first().click();
        await expect(page.getByTestId("issue-detail-header")).toBeVisible();
        const backStart = performance.now();
        await page.goBack();
        await expect(page.getByRole("tab", { name: "Mine", exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(rows.first()).toBeVisible();
        const back = performance.now() - backStart;
        const resources = await page.evaluate(() => performance.getEntriesByType("resource").map(entry => {
          const resource = entry as PerformanceResourceTiming;
          const url = new URL(resource.name);
          return { path: url.pathname, start: resource.startTime, ms: resource.duration, end: resource.responseEnd };
        }).filter(resource => resource.path.startsWith("/api/") || resource.path.startsWith("/assets/")));
        assert.deepEqual(errors, [], "The page reported JavaScript errors.");
        expectedRowIds ??= rowIds;
        assert.deepEqual(rowIds, expectedRowIds, "Mine row order or membership changed between samples.");
        samples.push({ pair, arm, status: "passed", cold, warm, back, rowIds, rowSequenceEquivalent: true, firstBox, reads, resources, errors, load: loadavg() });
        console.log(JSON.stringify({ pair, arm, cold, warm, back, rows: rowIds.length, errors }));
      } catch (error) {
        samples.push({ pair, arm, status: "failed", error: error instanceof Error ? error.message : String(error), rowIds, errors, reads, load: loadavg() });
        throw error;
      } finally {
        await save();
        await context.close();
      }
    }
  }
} finally {
  await save();
  await browser?.close();
  await Promise.all(Object.values(clients).map(client => client.dispose()));
}
