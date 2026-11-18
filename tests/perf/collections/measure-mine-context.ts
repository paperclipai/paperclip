import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { arch, loadavg, platform } from "node:os";
import { chromium, expect, request, type APIRequestContext, type BrowserContext, type Page, type Request } from "@playwright/test";

type Fixture = {
  company: { id: string; issuePrefix: string };
  parents: Array<{ id: string }>;
  children: Array<{ id: string }>;
};
type Arm = "baseline" | "candidate";
type Read = { path: string; view: string | null; ids: number; start: number; status?: number; end?: number; failed?: string };
declare global {
  interface Window { __mineContextMeasure: { first: number | null } }
}

function loopbackOrigin(value: string | undefined, name: string) {
  assert.ok(value, `Set ${name} to a disposable local origin.`);
  const url = new URL(value);
  assert.ok(["http:", "https:"].includes(url.protocol)
    && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
    && url.pathname === "/" && !url.username && !url.password && !url.search && !url.hash,
  `${name} must be an exact loopback origin.`);
  return url.origin;
}
const arms = ["baseline", "candidate"] as const;
const origins = Object.fromEntries(arms.map(arm => [arm,
  loopbackOrigin(process.env[`INBOX_${arm.toUpperCase()}_URL`], `INBOX_${arm.toUpperCase()}_URL`),
])) as Record<Arm, string>;
const apiOrigins = Object.fromEntries(arms.map(arm => [arm,
  loopbackOrigin(process.env[`INBOX_${arm.toUpperCase()}_API_URL`] ?? origins[arm], `INBOX_${arm.toUpperCase()}_API_URL`),
])) as Record<Arm, string>;
assert.notEqual(origins.baseline, origins.candidate, "Use distinct baseline and candidate UI origins.");
const pairs = Number(process.env.INBOX_PAIRS ?? 5);
const tailMs = Number(process.env.INBOX_TAIL_MS ?? 2_000);
const latencyValue = process.env.INBOX_NETWORK_LATENCY_MS ?? "0";
assert.match(latencyValue, /^\d+$/, "INBOX_NETWORK_LATENCY_MS must be an integer from 0 to 2000.");
const networkLatencyMs = Number(latencyValue);
assert.ok(Number.isSafeInteger(networkLatencyMs) && networkLatencyMs <= 2_000, "INBOX_NETWORK_LATENCY_MS must be an integer from 0 to 2000.");
const networkScenario = networkLatencyMs === 0 ? "native" : `latency-${networkLatencyMs}ms`;
assert.ok(Number.isSafeInteger(pairs) && pairs > 0, "INBOX_PAIRS must be a positive integer.");
assert.ok(Number.isSafeInteger(tailMs) && tailMs >= 0 && tailMs <= 30_000, "INBOX_TAIL_MS must be between 0 and 30000.");
const cacheMode = process.env.INBOX_HTTP_CACHE ?? "warm";
assert.ok(["warm", "cold", "both"].includes(cacheMode), "INBOX_HTTP_CACHE must be warm, cold, or both.");
const scenarios = cacheMode === "both" ? ["warm", "cold"] as const : [cacheMode as "warm" | "cold"];
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
  for (let index = 0; index < 4; index++) fixture.parents.push(await create(`Parent ${index}`, index === 0 ? "blocked" : "done"));
  for (let index = 0; index < 30; index++) fixture.children.push(await create(`Inbox child ${index}`, "todo", fixture.parents[index % 4]!.id));
  for (const parent of fixture.parents.slice(1)) await api(client, "POST", `/issues/${parent.id}/inbox-archive`, {});
  await fs.mkdir(path.dirname(fixtureFile), { recursive: true });
  await fs.writeFile(fixtureFile, JSON.stringify(fixture, null, 2));
  return fixture;
}

async function artifactReceipt(client: APIRequestContext, apiClient: APIRequestContext, arm: Arm) {
  const response = await client.get("/");
  assert.ok(response.ok(), `${arm} UI is unavailable.`);
  const html = await response.text();
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc=["'](\/assets\/[^"']+\.js)["']/g)].map(match => match[1]!);
  assert.ok(scripts.length && !html.includes("/@vite/client"), `${arm} must serve a production UI build.`);
  const assets = [];
  for (const assetPath of scripts) {
    const asset = await client.get(assetPath);
    assert.ok(asset.ok(), `${arm} entry asset is unavailable.`);
    assert.match(asset.headers()["cache-control"] ?? "", /immutable/, `${arm} assets must use the shipped immutable cache policy.`);
    const body = await asset.body();
    assets.push({ path: assetPath, bytes: body.length, sha256: createHash("sha256").update(body).digest("hex") });
  }
  const health = await api(apiClient, "GET", "/health");
  const proxiedHealth = await api(client, "GET", "/health");
  assert.equal(proxiedHealth.commit, health.commit, `${arm} UI proxy and configured API serve different revisions.`);
  const declaredRevision = process.env[`INBOX_${arm.toUpperCase()}_SOURCE_REVISION`];
  if (declaredRevision) assert.match(declaredRevision, /^[a-f0-9]{40}$/, "Source revisions must be full Git SHAs.");
  return { declaredRevision: declaredRevision ?? null, htmlSha256: createHash("sha256").update(html).digest("hex"), assets,
    server: { commit: health.commit, version: health.version, deploymentMode: health.deploymentMode } };
}

function recordPage(page: Page, origin: string) {
  const pending = new WeakMap<Request, Read>();
  let reads: Read[] = [];
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.origin !== origin || !url.pathname.startsWith("/api/")) return;
    const started = request.timing().startTime;
    const read = { path: url.pathname, view: url.searchParams.get("view"),
      ids: url.searchParams.get("ids")?.split(",").length ?? 0, start: started >= 0 ? started : Date.now() };
    reads.push(read);
    pending.set(request, read);
  });
  page.on("response", response => {
    const read = pending.get(response.request());
    if (read) read.status = response.status();
  });
  page.on("requestfinished", request => {
    const read = pending.get(request);
    if (!read) return;
    const timing = request.timing();
    if (timing.startTime >= 0) read.start = timing.startTime;
    if (timing.responseEnd >= 0) read.end = read.start + timing.responseEnd;
  });
  page.on("requestfailed", request => {
    const read = pending.get(request);
    if (read) read.failed = request.failure()?.errorText ?? "failed";
  });
  return { reset() { reads = []; errors.length = 0; }, reads: () => reads, errors };
}
async function preparePage(context: BrowserContext, origin: string) {
  const page = await context.newPage();
  const networkSession = networkLatencyMs > 0 ? await context.newCDPSession(page) : undefined;
  if (networkSession) {
    await networkSession.send("Network.enable");
    await networkSession.send("Network.emulateNetworkConditions", { offline: false, latency: networkLatencyMs,
      downloadThroughput: -1, uploadThroughput: -1, connectionType: "other" });
  }
  const tracker = recordPage(page, origin);
  await page.addInitScript(() => {
    window.__mineContextMeasure = { first: null };
    const observer = new MutationObserver(() => {
      if (location.pathname.endsWith("/inbox/mine") && document.querySelector("[data-inbox-item]")) {
        observer.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => {
          window.__mineContextMeasure.first = performance.now();
        }));
      }
    });
    observer.observe(document, { subtree: true, childList: true });
  });
  return { page, tracker, networkSession };
}
const frames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

const uiClients = Object.fromEntries(await Promise.all(arms.map(async arm => [arm, await request.newContext({ baseURL: origins[arm], extraHTTPHeaders: { Origin: origins[arm] } })]))) as Record<Arm, APIRequestContext>;
const apiClients = Object.fromEntries(await Promise.all(arms.map(async arm => [arm, await request.newContext({ baseURL: apiOrigins[arm], extraHTTPHeaders: { Origin: apiOrigins[arm] } })]))) as Record<Arm, APIRequestContext>;
const samples: Array<Record<string, unknown>> = [];
const artifacts: Partial<Record<Arm, Awaited<ReturnType<typeof artifactReceipt>>>> = {};
let expectedRowIds: Array<string | null> | undefined;
let fixture: Fixture | undefined;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let runError: string | undefined;
const warmPages: Partial<Record<Arm, Awaited<ReturnType<typeof preparePage>> & { context: BrowserContext }>> = {};
const save = async () => {
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output, JSON.stringify({ pairs, fixture, origins, apiOrigins, artifacts, rowSequenceReference: expectedRowIds,
    completed: !runError && samples.length === pairs * scenarios.length * 2, error: runError,
    settings: { viewport: "1440x900", httpCache: cacheMode, serviceWorkers: "blocked", tailMs,
      queryCache: "new document for every initial sample, retained for warm navigation and Back", serverCache: "retained, not reset", cpu: "native", network: "loopback",
      networkScenario, networkLatencyMs, networkEmulation: networkLatencyMs === 0 ? "none" : "Chromium CDP minimum request-to-response-header latency; unlimited throughput; no request interception",
      readiness: "initial: browser clock to Mine rows plus two animation frames; warm/Back: host clock around browser actions and two frames",
      node: process.version, platform: platform(), arch: arch(), browser: browser?.version() }, samples,
  }, null, 2));
};
try {
  for (const arm of arms) artifacts[arm] = await artifactReceipt(uiClients[arm], apiClients[arm], arm);
  fixture = await retainFixture(apiClients.candidate);
  for (const arm of arms) await api(apiClients[arm], "GET", `/companies/${fixture.company.id}`);
  await api(apiClients.candidate, "PUT", `/companies/${fixture.company.id}/workspace-preferences/me`, { coordinatorWorkspaceEnabled: true });
  browser = await chromium.launch({ headless: process.env.INBOX_HEADFUL !== "1", channel: process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL });
  if (scenarios.includes("warm")) for (const arm of arms) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
    const prepared = await preparePage(context, origins[arm]);
    warmPages[arm] = { ...prepared, context };
    await prepared.page.goto(`${origins[arm]}/${fixture.company.issuePrefix}/inbox/mine`);
    await expect(prepared.page.locator("[data-inbox-item]").first()).toBeVisible();
    await prepared.page.waitForLoadState("networkidle");
  }
  for (const httpCache of scenarios) for (let pair = 0; pair < pairs; pair++) {
    for (const arm of pair % 2 ? ["candidate", "baseline"] as const : arms) {
      const retained = warmPages[arm];
      const context: BrowserContext = httpCache === "warm" ? retained!.context : await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: "block" });
      const prepared: Awaited<ReturnType<typeof preparePage>> = httpCache === "warm" ? retained! : await preparePage(context, origins[arm]);
      const { page, tracker } = prepared;
      let rowIds: Array<string | null> | undefined;
      try {
        await page.bringToFront();
        tracker.reset();
        if (httpCache === "warm") await page.reload();
        else await page.goto(`${origins[arm]}/${fixture.company.issuePrefix}/inbox/mine`);
        const rows = page.locator("[data-inbox-item]");
        await expect(rows.first()).toBeVisible();
        await page.waitForFunction(() => window.__mineContextMeasure.first !== null);
        const { initial, timeOrigin } = await page.evaluate(() => ({ initial: window.__mineContextMeasure.first!, timeOrigin: performance.timeOrigin }));
        rowIds = await page.locator("[data-inbox-issue-link]").evaluateAll(nodes => nodes.map(node => node.getAttribute("href")));
        const node = await rows.first().elementHandle();
        const firstBox = await rows.first().boundingBox();
        await page.waitForTimeout(tailMs);
        const tailEnd = await page.evaluate(() => performance.now());
        const tailBox = await rows.first().boundingBox();
        assert.ok(await node!.evaluate(element => element.isConnected), "Initial rows were replaced during the tail.");
        assert.ok(Math.abs(firstBox!.y - tailBox!.y) < 1 && Math.abs(firstBox!.height - tailBox!.height) < 1, "Initial row geometry changed during the tail.");
        const initialReads = tracker.reads().filter(read => read.start >= timeOrigin).map(read => ({ ...read, start: read.start - timeOrigin,
          end: read.end === undefined ? null : read.end - timeOrigin, beforeReveal: read.start - timeOrigin <= initial }));
        const resources = await page.evaluate(() => performance.getEntriesByType("resource").map(entry => {
          const resource = entry as PerformanceResourceTiming;
          const url = new URL(resource.name);
          return { path: url.pathname, start: resource.startTime, ms: resource.duration, end: resource.responseEnd,
            transferBytes: resource.transferSize, encodedBytes: resource.encodedBodySize };
        }).filter(resource => resource.path.startsWith("/api/") || resource.path.startsWith("/assets/")));
        const milestones = Object.fromEntries(["/api/health", "/api/auth/get-session", "/api/cli-auth/me", "/api/companies", "/api/workspace-preferences/me"].map(path => [path, resources.find(resource => resource.path === path) ?? null]));
        const primary = initialReads.find(read => read.path.endsWith("/inbox/mine") || (read.path.endsWith("/issues") && read.view === "index" && read.ids === 0));
        await page.getByRole("tab", { name: "Recent", exact: true }).click();
        await expect(page.getByRole("tab", { name: "Recent", exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(rows.first()).toBeVisible();
        await frames(page);
        const start = performance.now();
        await page.getByRole("tab", { name: "Mine", exact: true }).click();
        await expect(page.getByRole("tab", { name: "Mine", exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(rows.first()).toBeVisible();
        await frames(page);
        const warm = performance.now() - start;
        await page.locator("[data-inbox-issue-link]").first().click();
        await expect(page.getByTestId("issue-detail-header")).toBeVisible();
        const backStart = performance.now();
        await page.goBack();
        await expect(page.getByRole("tab", { name: "Mine", exact: true })).toHaveAttribute("aria-selected", "true");
        await expect(rows.first()).toBeVisible();
        await frames(page);
        const back = performance.now() - backStart;
        assert.deepEqual(tracker.errors, [], "The page reported JavaScript errors.");
        expectedRowIds ??= rowIds;
        assert.deepEqual(rowIds, expectedRowIds, "Mine row order or membership changed between samples.");
        samples.push({ pair, arm, httpCache, networkScenario, networkLatencyMs, status: "passed", initial, warm, back, primary, milestones, tailEnd, rowIds,
          rowSequenceEquivalent: true, firstBox, tailBox, initialReads, resources,
          counts: { beforeReveal: initialReads.filter(read => read.beforeReveal).length, throughTail: initialReads.length,
            throttled: initialReads.filter(read => read.status === 429).length, unfinished: initialReads.filter(read => read.end === null && !read.failed).length },
          errors: [...tracker.errors], load: loadavg() });
        console.log(JSON.stringify({ pair, arm, httpCache, networkScenario, networkLatencyMs, initial, warm, back, primaryStart: primary?.start, rows: rowIds.length }));
      } catch (error) {
        samples.push({ pair, arm, httpCache, networkScenario, networkLatencyMs, status: "failed", error: error instanceof Error ? error.message : String(error), rowIds, errors: [...tracker.errors], reads: tracker.reads(), load: loadavg() });
        throw error;
      } finally {
        await save();
        if (httpCache === "cold") await context.close();
      }
    }
  }
} catch (error) {
  runError = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await save();
  await browser?.close();
  await Promise.all([...Object.values(uiClients), ...Object.values(apiClients)].map(client => client.dispose()));
}
