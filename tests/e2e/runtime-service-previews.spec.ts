import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { test as base, expect } from "@playwright/test";
import type { RuntimeService } from "../../packages/shared/src/runtime-services";
import { verifyRestrictivePreviewPolicies } from "./runtime-service-preview-policies";
import { verifyHiddenPreviewActivity } from "./runtime-service-preview-visibility";

// A service deliberately outlives the browser and server session. Give its
// teardown a separate fixture budget so a timed-out assertion cannot skip Stop.
const test = base.extend<{ trackService: (cwd: string, apiPath?: string) => void }>({
  trackService: [async ({ request }, use) => {
    let cwd: string | undefined;
    let apiPath: string | undefined;
    await use((workspace, servicePath) => { cwd = workspace; apiPath = servicePath; });
    if (apiPath) {
      const read = async (): Promise<RuntimeService> => {
        const response = await request.get(apiPath!);
        expect(response.ok()).toBe(true);
        return response.json();
      };
      const current = await read();
      if (current.state !== "stopped") {
        expect((await request.post(`${apiPath}/control`, { data: { requestId: randomUUID(), expectedRevision: current.revision, action: "stop" } })).status()).toBe(202);
        await expect.poll(async () => (await read()).state, { timeout: 20_000 }).toBe("stopped");
      }
    }
    if (cwd) await fs.rm(cwd, { recursive: true, force: true });
  }, { timeout: 30_000 }],
});

test("Vite React Fast Refresh, private stable origin, retained files and sleep/wake", async ({ page, context, browser, trackService }, testInfo) => {
  const soakSeconds = Number(process.env.PAPERCLIP_PREVIEW_SOAK_SECONDS ?? 0);
  test.setTimeout(240_000 + soakSeconds * 1000);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-vite-preview-"));
  trackService(cwd);
  const dependencies = Object.fromEntries(await Promise.all(["vite", "@vitejs/plugin-react", "react", "react-dom"].map(async (name) => [name,
    JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "../../ui/node_modules", name, "package.json"), "utf8")).version,
  ])));
  await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "preview-acceptance", version: "1.0.0", private: true, type: "module", dependencies }));
  await promisify(execFile)("pnpm", ["install", "--ignore-workspace", "--prefer-offline", "--ignore-scripts"], { cwd, timeout: 90_000 });
  // Polling observes agent/editor changes even when native macOS file events
  // are unavailable inside the workspace sandbox.
  await fs.writeFile(path.join(cwd, "vite.config.js"), "import {defineConfig} from 'vite';import react from '@vitejs/plugin-react';export default defineConfig({plugins:[react()],server:{watch:{usePolling:true,interval:300}}});");
  await fs.writeFile(path.join(cwd, "index.html"), '<!doctype html><html><head><title>Preview acceptance</title></head><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>');
  await fs.writeFile(path.join(cwd, "main.jsx"), "import React from 'react';import{createRoot}from'react-dom/client';import App from './App.jsx';createRoot(document.getElementById('root')).render(<App/>);");
  await fs.mkdir(path.join(cwd, "public"));
  await fs.writeFile(path.join(cwd, "public/sw.js"), "self.addEventListener('fetch',event=>{});");
  const source = (label: string) => `import React,{useState}from'react';export default function App(){const[count,setCount]=useState(0);return <main><h1>${label}</h1><button onClick={()=>setCount(count+1)}>Count {count}</button><p>{location.pathname+location.search}</p></main>}`;
  await fs.writeFile(path.join(cwd, "App.jsx"), source("First dirty edit"));
  const company = await (await page.request.post("/api/companies", { data: { name: "Vite preview acceptance" } })).json();
  const created = await page.request.post(`/api/companies/${company.id}/runtime-services`, { data: {
    requestId: randomUUID(), name: "React preview", cwd, command: 'node node_modules/vite/bin/vite.js --host 127.0.0.1 --port "$PORT" --strictPort', endpoints: [{ name: "web" }],
  } });
  expect(created.status()).toBe(202);
  const service = await created.json() as RuntimeService;
  const servicePath = `/api/companies/${company.id}/runtime-services/${service.id}`;
  trackService(cwd, servicePath);
  const read = async (): Promise<RuntimeService> => (await page.request.get(servicePath)).json();
  const control = async (action: "start" | "stop" | "sleep" | "restart") => {
    const current = await read();
    expect((await page.request.post(`${servicePath}/control`, { data: { action, expectedRevision: current.revision, requestId: randomUUID() } })).status()).toBe(202);
  };
  await expect.poll(async () => (await read()).endpoints[0]?.status, { timeout: 50_000, message: "Public preview route becomes verified" }).toBe("ready");
  const url = (await read()).endpoints[0]!.url!;
  expect(url).toContain(".localhost:");
  await page.goto(`/${company.issuePrefix}/runtime-services/${service.id}`);
  const previewPromise = context.waitForEvent("page");
  await page.getByRole("link", { name: "Open web" }).click();
  const preview = await previewPromise;
  await expect(preview.getByRole("heading", { name: "First dirty edit" })).toBeVisible({ timeout: 30_000 });
  expect(new URL(preview.url()).origin).toBe(url);
  expect(preview.url()).not.toContain("ticket=");
  await preview.goto(`${url}/nested/page?check=1`);
  await expect(preview.getByText("/nested/page?check=1", { exact: true })).toBeVisible();
  await preview.getByRole("button", { name: "Count 0" }).click();
  await preview.getByRole("button", { name: "Count 1" }).click();
  await preview.evaluate(() => { localStorage.setItem("retained", "yes"); document.cookie = "app_value=retained;Path=/;SameSite=Lax"; });
  const ws = preview.waitForEvent("websocket");
  await preview.reload();
  const socket = await ws;
  expect(new URL(socket.url()).host).toBe(new URL(url).host);
  await preview.getByRole("button", { name: "Count 0" }).click();
  await preview.getByRole("button", { name: "Count 1" }).click();
  await fs.writeFile(path.join(cwd, "App.jsx"), source("Hot reloaded dirty edit"));
  await expect(preview.getByRole("heading", { name: "Hot reloaded dirty edit" })).toBeVisible({ timeout: 20_000 });
  await expect(preview.getByRole("button", { name: "Count 2" })).toBeVisible();
  let latestLabel = soakSeconds > 0 ? "Still hot after ten minutes" : "Hot reloaded dirty edit";
  if (soakSeconds > 0) {
    const until = Date.now() + soakSeconds * 1000;
    do {
      const current = await read();
      expect(current.state).toBe("ready"); expect(current.endpoints[0]?.url).toBe(url);
      expect(Date.now() - Date.parse(current.previewActivity!.lastSignalAt!)).toBeLessThan(45_000);
      await delay(Math.min(10_000, Math.max(0, until - Date.now())));
    } while (Date.now() < until);
    await fs.writeFile(path.join(cwd, "App.jsx"), source(latestLabel));
    await expect(preview.getByRole("heading", { name: latestLabel })).toBeVisible({ timeout: 20_000 });
    await expect(preview.getByRole("button", { name: "Count 2" })).toBeVisible();
  }
  expect(preview.url()).toBe(`${url}/nested/page?check=1`);
  await expect.poll(async () => (await read()).previewActivity?.lastSignalAt).toBeTruthy();
  const cookies = await context.cookies(url);
  const auth = cookies.find((cookie) => cookie.name === "__Host-Http-paperclip-preview");
  expect(auth).toMatchObject({ httpOnly: true, secure: true, path: "/" });
  expect(await preview.evaluate(() => document.cookie)).not.toContain("paperclip-preview");
  // Chromium reports a failed worker-script fetch through registration's
  // rejection, without necessarily emitting a response on the owning Page.
  const sw = await preview.evaluate(async () => { try { await navigator.serviceWorker.register("/sw.js"); return "registered"; } catch (error) { return String(error); } });
  expect(sw).toMatch(/bad HTTP response code \(403\)/);
  await preview.screenshot({ path: testInfo.outputPath("vite-fast-refresh.png"), fullPage: true });
  await testInfo.attach("Vite Fast Refresh", { path: testInfo.outputPath("vite-fast-refresh.png"), contentType: "image/png" });

  await page.setViewportSize({ width: 390, height: 760 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const sharesPath = `${servicePath}/shares`;
  const shareRequests: unknown[] = [];
  let loseCreateResponse!: () => void;
  const createGate = new Promise<void>((resolve) => { loseCreateResponse = resolve; });
  // Commit through the real API before dropping the first response. Retry
  // must recover that same capability, not create another public link.
  await page.route(`**${sharesPath}`, async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    shareRequests.push(route.request().postDataJSON());
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    if (shareRequests.length === 1) { await createGate; await route.abort("failed"); }
    else await route.fulfill({ response });
  });
  await page.getByRole("button", { name: "Share preview", exact: true }).click();
  await page.getByRole("button", { name: "Create share link", exact: true }).focus();
  await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Creating link…", exact: true })).toBeDisabled();
  await expect(page.getByLabel("Link expires after", { exact: true })).toBeDisabled();
  await expect.poll(() => shareRequests.length).toBe(1);
  await page.screenshot({ path: testInfo.outputPath("sharing-pending-mobile.png"), fullPage: true });
  loseCreateResponse();
  await expect(page.getByRole("alert")).toContainText("Could not confirm link creation");
  await page.getByRole("button", { name: "Retry same request", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Share link created" })).toBeVisible();
  expect(shareRequests).toHaveLength(2); expect(shareRequests[1]).toEqual(shareRequests[0]);
  const storedShares = await (await page.request.get(sharesPath)).json();
  expect(storedShares).toHaveLength(1);
  const linkInput = page.getByRole("textbox", { name: "web share link" });
  await expect(linkInput).toBeVisible();
  const link = await linkInput.inputValue();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("preview-sharing.png"), fullPage: true });
  await testInfo.attach("Preview sharing", { path: testInfo.outputPath("preview-sharing.png"), contentType: "image/png" });
  const guest = await browser.newContext({ viewport: { width: 390, height: 760 }, reducedMotion: "reduce" });
  try {
    // Resource requests cannot silently acquire a board session.
    expect((await guest.request.get(url)).status()).toBe(401);
    const guestPage = await guest.newPage();
    const guestSocketPromise = guestPage.waitForEvent("websocket");
    await guestPage.goto(link);
    const guestSocket = await guestSocketPromise;
    let guestSocketClosed = false;
    guestSocket.on("close", () => { guestSocketClosed = true; });
    await expect(guestPage.getByRole("heading", { name: latestLabel })).toBeVisible({ timeout: 20_000 });
    expect(new URL(guestPage.url()).origin).toBe(url);
    expect(guestPage.url()).not.toContain("ticket=");
    let revokeCalls = 0;
    let loseRevokeResponse!: () => void;
    const revokeGate = new Promise<void>((resolve) => { loseRevokeResponse = resolve; });
    await page.route(`**${sharesPath}/${storedShares[0].id}`, async (route) => {
      revokeCalls++;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await revokeGate; await route.abort("failed");
    });
    await page.getByRole("button", { name: "Revoke link", exact: true }).focus();
    await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Revoking…", exact: true })).toBeDisabled();
    await expect.poll(() => guestSocketClosed, { timeout: 10_000 }).toBe(true);
    expect((await guest.request.get(url)).status()).toBe(401);
    await page.screenshot({ path: testInfo.outputPath("revocation-pending-mobile.png"), fullPage: true });
    loseRevokeResponse();
    // A fresh authoritative list confirms the completed revocation even when
    // its response was lost. Do not leave contradictory failure/retry copy.
    await expect(page.getByRole("status").filter({ hasText: "Share link revoked" })).toBeVisible();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Retry revocation", exact: true })).toHaveCount(0);
    expect(revokeCalls).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("revocation-complete-mobile.png"), fullPage: true });
    latestLabel = "Private edit after revocation";
    await fs.writeFile(path.join(cwd, "App.jsx"), source(latestLabel));
    await expect(preview.getByRole("heading", { name: latestLabel })).toBeVisible({ timeout: 20_000 });
    await expect(preview.getByRole("button", { name: "Count 2" })).toBeVisible();
    await guestPage.goto(link);
    await expect(guestPage.getByRole("heading", { name: "Share link unavailable" })).toBeVisible();
    const proof = testInfo.outputPath("sharing-mobile.json");
    await fs.writeFile(proof, JSON.stringify({ shareRequests, shareCount: storedShares.length, revokeCalls, guestSocketClosed,
      guestDeniedAfterRevoke: true, ownerFastRefreshPreserved: true, backend: "real local service, gateway and API; first mutation responses dropped after server acceptance" }, null, 2));
    await testInfo.attach("sharing-mobile.json", { path: proof, contentType: "application/json" });
  } finally { await guest.close(); }

  // Close the document so its visible heartbeat cannot race this deliberate
  // idle sleep. Revisit the exact app URL without another agent run.
  await preview.close();
  await control("sleep");
  await expect.poll(async () => (await read()).state, { timeout: 20_000 }).toBe("sleeping");
  const sleepingUrl = (await read()).endpoints[0]!.url;
  expect(sleepingUrl).toBe(url);
  await page.reload();
  await expect(page.getByRole("link", { name: "Open web" })).toBeVisible();
  const revisit = await context.newPage();
  await revisit.goto(`${url}/nested/page?check=1`);
  await expect(revisit.getByRole("heading", { name: latestLabel })).toBeVisible({ timeout: 40_000 });
  expect(revisit.url()).toBe(`${url}/nested/page?check=1`);
  expect(await revisit.evaluate(() => localStorage.getItem("retained"))).toBe("yes");
  expect(await revisit.evaluate(() => document.cookie)).toContain("app_value=retained");
  await revisit.close();
  await control("stop");
  await expect.poll(async () => (await read()).state, { timeout: 20_000 }).toBe("stopped");
  const stopped = await context.newPage();
  await stopped.goto(url);
  await expect(stopped.getByRole("heading", { name: "Preview is stopped" })).toBeVisible();
  expect((await read()).desiredState).toBe("stopped");
  await stopped.close();
});

test("browser cookie isolation requires a public suffix, beyond distinct preview origins", async ({ browser }) => {
  const isolated = await browser.newContext();
  try {
    // Every request is fulfilled locally. These known PSL domains exercise
    // Chromium's built-in cookie rules, not those hosting services or DNS.
    await isolated.route("**/*", (route) => route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Cookie scope probe</title>" }));
    const app = await isolated.newPage();
    for (const example of [
      { host: "app1.foo.paperclip.app", parents: ["foo.paperclip.app", "paperclip.app"], isolated: false },
      { host: "app1.s3.amazonaws.com", parents: ["s3.amazonaws.com", "amazonaws.com"], isolated: true },
    ]) {
      await isolated.clearCookies();
      await app.goto(`https://${example.host}/`);
      const written = await app.evaluate((parents) => {
        document.cookie = "own=retained;Secure;Path=/";
        localStorage.setItem("own", "retained");
        for (const [index, domain] of parents.entries()) document.cookie = `parent${index}=injected;Domain=${domain};Secure;Path=/`;
        return document.cookie;
      }, example.parents);
      expect(written).toContain("own=retained");
      for (let index = 0; index < example.parents.length; index++) {
        expect(written.includes(`parent${index}=injected`)).toBe(!example.isolated);
      }
      const neighbor = await isolated.newPage();
      await neighbor.goto(`https://${example.host.replace("app1.", "app2.")}/`);
      expect(await neighbor.evaluate(() => localStorage.getItem("own"))).toBeNull();
      const neighborCookies = await neighbor.evaluate(() => document.cookie);
      expect(neighborCookies).not.toContain("own=retained");
      expect(neighborCookies.includes("injected")).toBe(!example.isolated);
      await neighbor.close();
    }
  } finally { await isolated.close(); }
});

test("restrictive app policies preserve app behavior, reveal missing activity, and honor idle sleep and explicit holds", async ({ page, context, trackService }, testInfo) => {
  test.setTimeout(180_000);
  await verifyRestrictivePreviewPolicies({ page, context, trackService, testInfo });
});

test("a real hidden tab sleeps despite app polling and sockets, then wakes when visible", async ({ page, trackService }, testInfo) => {
  test.setTimeout(180_000);
  await verifyHiddenPreviewActivity({ page, trackService, testInfo });
});

test("visible use renews idle time, a closed preview sleeps despite polling, and hard limits still stop it", async ({ page, context, trackService }) => {
  test.setTimeout(180_000);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-preview-lifetime-"));
  trackService(cwd);
  await fs.writeFile(path.join(cwd, "app.cjs"), `require('node:http').createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><title>Lifetime preview</title></head><body><h1>Lifetime preview</h1></body></html>')}).listen(Number(process.env.PORT),'127.0.0.1');`);
  const company = await (await page.request.post("/api/companies", { data: { name: "Preview lifetime acceptance" } })).json();
  const created = await page.request.post(`/api/companies/${company.id}/runtime-services`, { data: {
    requestId: randomUUID(), name: "Lifetime preview", cwd, command: "node app.cjs", endpoints: [{ name: "web" }], policy: { idleSeconds: 30 },
  } });
  expect(created.status()).toBe(202);
  const service = await created.json() as RuntimeService;
  const apiPath = `/api/companies/${company.id}/runtime-services/${service.id}`;
  trackService(cwd, apiPath);
  const read = async (): Promise<RuntimeService> => (await page.request.get(apiPath)).json();
  const preview = await context.newPage();
  await expect.poll(async () => (await read()).endpoints[0]?.status, { timeout: 40_000 }).toBe("ready");
  const url = (await read()).endpoints[0]!.url!;
  await preview.goto(url);
  await expect(preview.getByRole("heading", { name: "Lifetime preview" })).toBeVisible({ timeout: 25_000 });
  expect(await preview.evaluate(() => document.visibilityState)).toBe("visible");
  const first = await read();
  const waitUntil = Date.now() + 45_000;
  do {
    const current = await read();
    expect(current.state).toBe("ready");
    await delay(2_000);
  } while (Date.now() < waitUntil);
  const active = await read();
  expect(Date.parse(active.lastActivityAt) - Date.parse(first.lastActivityAt)).toBeGreaterThan(30_000);
  await preview.close();
  const lastActivity = (await read()).lastActivityAt;
  // APIRequestContext shares cookies with the browser but performs resource
  // requests, not document navigation. These real polls must not renew use.
  await expect.poll(async () => {
    await context.request.get(`${url}/poll`);
    await context.request.get(`${url}/.paperclip/status`);
    const current = await read();
    expect(current.lastActivityAt).toBe(lastActivity);
    return current.state;
  }, { timeout: 40_000, intervals: [1_000] }).toBe("sleeping");
  expect((await read()).stopReason).toBe("idle");
  const sleeping = await read();
  expect((await page.request.patch(`${apiPath}/policy`, { data: {
    requestId: randomUUID(), expectedRevision: sleeping.revision,
    policy: { maxRunningSeconds: 30, keepRunningUntil: new Date(Date.now() + 300_000).toISOString() },
  } })).status()).toBe(200);
  const revisit = await context.newPage();
  await revisit.goto(`${url}/retained-route`);
  await expect(revisit.getByRole("heading", { name: "Lifetime preview" })).toBeVisible({ timeout: 30_000 });
  expect(revisit.url()).toBe(`${url}/retained-route`);
  await expect.poll(async () => (await read()).state, { timeout: 40_000, intervals: [1_000] }).toBe("stopped");
  expect(await read()).toMatchObject({ desiredState: "stopped", stopReason: "maximum_lifetime", endpoints: [{ url }] });
  await revisit.reload();
  await expect(revisit.getByRole("heading", { name: "Preview is stopped" })).toBeVisible();
  expect((await read()).desiredState).toBe("stopped");
  await revisit.close();
});
