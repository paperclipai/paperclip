// Local-only browser comparison. Creates synthetic fixtures; never target staging.
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { chromium } from "@playwright/test";

const [phase, origin, directory] = process.argv.slice(2);
if (!phase || !origin || !directory) throw new Error("Usage: node scripts/benchmark-apps-startup.mjs <phase> <loopback-origin> <output-directory>");
const target = new URL(origin);
if (!["127.0.0.1", "localhost", "[::1]"].includes(target.hostname) || target.pathname !== "/" || target.username || target.password) {
  throw new Error("Only a disposable loopback instance is supported");
}
await fs.mkdir(directory, { recursive: true });
async function api(path, body) {
  const response = await fetch(new URL(`/api${path}`, target), body ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  } : undefined);
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
const fixturePath = `${directory}/fixture.json`;
let fixture;
try { fixture = JSON.parse(await fs.readFile(fixturePath, "utf8")); }
catch (error) {
  if (error.code !== "ENOENT") throw error;
  const company = await api("/companies", { name: "Apps Startup Review" });
  const tasks = [];
  for (let i = 1; i <= 5; i++) tasks.push(await api(`/companies/${company.id}/issues`, {
    title: `Review task ${i}`, description: "Synthetic task context for the sidebar performance comparison.\n".repeat(100),
    status: i === 1 ? "todo" : "done", priority: "medium",
  }));
  const application = await api(`/companies/${company.id}/tools/applications`, { name: "Review Connector", type: "mcp_http" });
  const connection = await api(`/companies/${company.id}/tools/connections`, {
    applicationId: application.id, name: "Review account", transport: "mcp_remote", status: "draft", enabled: false,
    transportConfig: { url: "https://example.com/mcp" },
  });
  const agent = await api(`/companies/${company.id}/agents`, {
    name: "Review agent", role: "engineer", adapterType: "codex_local",
    runtimeConfig: { heartbeat: { enabled: false } },
  });
  await api(`/agents/${agent.id}/pause`, {});
  const session = await api("/auth/get-session");
  fixture = { company, tasks, application, connection, agent, userId: session?.user?.id ?? null };
  await fs.writeFile(fixturePath, JSON.stringify(fixture, null, 2));
}
const variants = process.env.PAPERCLIP_APPS_BENCH_BASELINE_DIST ? [
  { label: "baseline-paired", dist: process.env.PAPERCLIP_APPS_BENCH_BASELINE_DIST },
  { label: "candidate-paired", dist: process.env.PAPERCLIP_APPS_BENCH_CANDIDATE_DIST },
] : [{ label: phase, dist: null }];
if (variants.length > 1) {
  if (!variants[1].dist) throw new Error("Paired mode requires PAPERCLIP_APPS_BENCH_CANDIDATE_DIST");
  const serverAssets = process.env.PAPERCLIP_APPS_BENCH_SERVER_DIST
    ? `${process.env.PAPERCLIP_APPS_BENCH_SERVER_DIST}/assets`
    : new URL("../ui/dist/assets/", import.meta.url);
  await fs.mkdir(serverAssets, { recursive: true });
  const serverAssetsPath = await fs.realpath(serverAssets);
  // Preserve both content-addressed asset sets in the loopback server's
  // static directory. Selecting an HTML document alone is insufficient.
  for (const variant of variants) {
    const sourceAssetsPath = await fs.realpath(`${variant.dist}/assets`);
    if (sourceAssetsPath !== serverAssetsPath) {
      await fs.cp(sourceAssetsPath, serverAssetsPath, { recursive: true, force: false });
    }
  }
}
const browser = await chromium.launch();
const samples = [];
try {
  for (const scenario of ["cold", "in-app"]) {
    for (let run = 0; run < 5; run++) {
      for (const variant of variants) {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: "block" });
      await context.addInitScript(({ fixture }) => {
        const entries = fixture.tasks.map((task, index) => ({
          id: task.id, companyId: task.companyId, title: task.title, identifier: task.identifier,
          status: task.status, recordedAt: index + 1, snapshotUpdatedAt: new Date(task.updatedAt).getTime(),
        }));
        localStorage.setItem("paperclip.selectedCompanyId", fixture.company.id);
        localStorage.setItem(`paperclip.recentTasks.v2:${fixture.company.id}:${fixture.userId ?? "__local_board__"}`, JSON.stringify(entries));
        window.__appsLongTasks = [];
        new PerformanceObserver(list => window.__appsLongTasks.push(...list.getEntries().map(e => ({ start: e.startTime, duration: e.duration }))))
          .observe({ type: "longtask", buffered: true });
      }, { fixture });
      const page = await context.newPage();
      if (variant.dist) {
        // Select only the production document. Assets and APIs still travel
        // through the real local server with the same network profile.
        const html = await fs.readFile(`${variant.dist}/index.html`, "utf8");
        await page.route(url => url.origin === target.origin &&
          ["apps", "dashboard"].some(name => url.pathname === `/${fixture.company.issuePrefix}/${name}`),
        route => route.fulfill({ status: 200, contentType: "text/html", body: html }));
      }
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Performance.enable");
      await cdp.send("Network.setCacheDisabled", { cacheDisabled: scenario === "cold" });
      await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 50, downloadThroughput: 9 * 1024 * 1024 / 8, uploadThroughput: 1.5 * 1024 * 1024 / 8 });
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });
      if (scenario === "in-app") {
        const initialDetails = new Set();
        let finishInitialRefresh;
        const initialRefresh = new Promise(resolve => { finishInitialRefresh = resolve; });
        const observeInitialRefresh = async response => {
          const path = new URL(response.url()).pathname;
          if (path.endsWith("/issues/summaries")) {
            await response.finished();
            finishInitialRefresh();
          } else if (fixture.tasks.some(task => path === `/api/issues/${task.id}`)) {
            await response.finished();
            initialDetails.add(path);
            if (initialDetails.size === fixture.tasks.length) finishInitialRefresh();
          }
        };
        page.on("response", observeInitialRefresh);
        await page.goto(new URL(`/${fixture.company.issuePrefix}/dashboard`, target).href);
        await page.getByRole("link", { name: "Connectors", exact: true }).first().waitFor({ timeout: 90_000 });
        await Promise.race([initialRefresh, new Promise((_, reject) => {
          const timeout = setTimeout(() => reject(new Error("Initial recent-task refresh did not finish")), 90_000);
          timeout.unref();
        })]);
        await page.waitForTimeout(2_000);
        page.off("response", observeInitialRefresh);
      }
      const initialMetrics = await cdp.send("Performance.getMetrics");
      const scriptDurationAtStart = scenario === "in-app"
        ? initialMetrics.metrics.find(metric => metric.name === "ScriptDuration")?.value ?? 0
        : 0;
      const records = [];
      const requests = [];
      page.on("request", request => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith("/api/")) requests.push({ path, startedMs: performance.now() - started });
      });
      let detailCompleted = 0;
      let detailReadyMax = 0;
      let sidebarReady = null;
      let observedNavigationStart;
      const started = performance.now();
      page.on("response", async response => {
        const url = new URL(response.url());
        if (!url.pathname.startsWith("/api/")) return;
        try {
          await response.finished();
          const completedMs = performance.now() - started;
          const body = await response.body();
          const sizes = await response.request().sizes();
          records.push({ path: url.pathname, status: response.status(), decodedBytes: body.byteLength, encodedBytes: sizes.responseBodySize, completedMs });
          if (url.pathname.endsWith("/issues/summaries")) sidebarReady = completedMs;
          if (fixture.tasks.some(task => url.pathname === `/api/issues/${task.id}`)) {
            detailCompleted++;
            detailReadyMax = Math.max(detailReadyMax, completedMs);
            if (detailCompleted >= fixture.tasks.length) sidebarReady = detailReadyMax;
          }
        } catch { /* navigation cancellation has no completed response */ }
      });
      observedNavigationStart = await page.evaluate(() => performance.now());
      if (scenario === "cold") await page.goto(new URL(`/${fixture.company.issuePrefix}/apps`, target).href);
      else await page.getByRole("link", { name: "Connectors", exact: true }).first().click();
      await page.getByRole("list", { name: "Connector list", exact: true }).waitFor({ timeout: 90_000 });
      await page.getByRole("searchbox", { name: "Search connectors" }).waitFor();
      const usableMs = performance.now() - started;
      await page.waitForTimeout(2_000);
      const metrics = await cdp.send("Performance.getMetrics");
      const longTasks = await page.evaluate(() => window.__appsLongTasks);
      const recentRecords = records.filter(record => record.path.endsWith("/issues/summaries") || fixture.tasks.some(task => record.path === `/api/issues/${task.id}`));
      samples.push({ variant: variant.label, scenario, run: run + 1, usableMs, sidebarReadyMs: sidebarReady, recentBytes: recentRecords.reduce((n, r) => n + r.decodedBytes, 0),
        recentEncodedBytes: recentRecords.reduce((n, r) => n + r.encodedBytes, 0),
        apiRequests: requests.length,
        recentRequests: requests.filter(record => record.path.endsWith("/issues/summaries") || fixture.tasks.some(task => record.path === `/api/issues/${task.id}`)).length,
        records, requests,
        longTaskMs: longTasks.filter(task => scenario === "cold" || task.start >= observedNavigationStart).reduce((n, task) => n + task.duration, 0),
        scriptDurationSeconds: (metrics.metrics.find(metric => metric.name === "ScriptDuration")?.value ?? 0) - scriptDurationAtStart,
      });
      if (run === 0) await page.screenshot({ path: `${directory}/${variant.label}-${scenario}.png`, fullPage: true });
      await context.close();
      console.log(`${variant.label} ${scenario} ${run + 1}: connectors=${Math.round(usableMs)}ms recent=${samples.at(-1).recentRequests} requests/${samples.at(-1).recentBytes} bytes`);
      }
    }
  }
} finally { await browser.close(); }
await fs.writeFile(`${directory}/${phase}.json`, JSON.stringify({ phase, origin, revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  browser: browser.version(), viewport: "1440x1000", profile: "50ms latency; 9Mbps down; 1.5Mbps up; 4x CPU", samples,
}, null, 2));
