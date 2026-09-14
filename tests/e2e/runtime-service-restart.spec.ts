import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { test, expect, type APIResponse } from "@playwright/test";
import type { RuntimeService } from "../../packages/shared/src/runtime-services";

async function json<T>(response: APIResponse): Promise<T> {
  expect(response.ok(), await response.text()).toBe(true);
  return response.json();
}
async function fixtureCommand(home: string, command: "stop" | "crash" | "start" | "status" | "finish") {
  return new Promise<{ state: string; pid?: number; previous?: { pid: number; code: number | null; signal: string | null } }>((resolve, reject) => {
    const socket = net.createConnection(path.join(home, "restart.sock"));
    let data = "";
    socket.setEncoding("utf8"); socket.setTimeout(65_000, () => socket.destroy(new Error("Restart fixture timed out")));
    socket.on("error", reject);
    socket.on("connect", () => socket.write(JSON.stringify({ command }) + "\n"));
    socket.on("data", (chunk) => { data += chunk; });
    socket.on("end", () => { try { const result = JSON.parse(data); if (result.error) reject(new Error(result.error)); else resolve(result); } catch (error) { reject(error); } });
  });
}

test.afterAll(async () => {
  const home = process.env.PAPERCLIP_RESTART_FIXTURE_HOME;
  if (home) expect((await fixtureCommand(home, "finish")).state).toBe("finished");
});

for (const stopMode of ["stop", "crash"] as const) {
test(`Paperclip ${stopMode} and restart preserves Vite, its old preview origin and an exhausted crash budget`, async ({ page, context, baseURL }, testInfo) => {
  test.setTimeout(240_000);
  const home = process.env.PAPERCLIP_RESTART_FIXTURE_HOME;
  if (!home || !path.basename(home).startsWith("paperclip-e2e-home-") || new URL(baseURL!).hostname !== "127.0.0.1") throw new Error("Restart acceptance requires its isolated fixture");
  const configPath = path.join(home, "instances", "playwright-e2e", "config.json");
  const originalConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (originalConfig.database?.mode !== "embedded-postgres" || originalConfig.server?.port !== Number(new URL(baseURL!).port)) throw new Error("Unexpected fixture configuration");
  const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-restart-vite-")));
  let companyId: string | undefined;
  const serviceIds: string[] = [], pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  const read = async (id: string) => json<RuntimeService>(await page.request.get(`/api/companies/${companyId}/runtime-services/${id}`));
  try {
    const dependencies = Object.fromEntries(await Promise.all(["vite", "@vitejs/plugin-react", "react", "react-dom"].map(async (name) => [name,
      JSON.parse(await fs.readFile(path.resolve(import.meta.dirname, "../../ui/node_modules", name, "package.json"), "utf8")).version,
    ])));
    await fs.writeFile(path.join(cwd, "package.json"), JSON.stringify({ name: "restart-preview-acceptance", private: true, type: "module", dependencies }));
    await promisify(execFile)("pnpm", ["install", "--ignore-workspace", "--prefer-offline", "--ignore-scripts"], { cwd, timeout: 90_000 });
    await fs.mkdir(path.join(cwd, "public"));
    await fs.writeFile(path.join(cwd, "public", "saved.txt"), "Persistent application data");
    await fs.writeFile(path.join(cwd, "index.html"), '<!doctype html><html><head><title>Restart preview</title></head><body><div id="root"></div><script type="module" src="/main.jsx"></script></body></html>');
    await fs.writeFile(path.join(cwd, "main.jsx"), "import React from 'react';import{createRoot}from'react-dom/client';import App from './App.jsx';createRoot(document.getElementById('root')).render(<App/>);");
    const source = (label: string) => `import React,{useState}from'react';export default function App(){const[count,setCount]=useState(0);return <main><h1>${label}</h1><button onClick={()=>setCount(count+1)}>Count {count}</button><p>{location.pathname+location.search}</p></main>}`;
    await fs.writeFile(path.join(cwd, "App.jsx"), source("Before Paperclip restart"));
    await fs.writeFile(path.join(cwd, "start.mjs"), `
      import fs from 'node:fs';import{randomUUID}from'node:crypto';import{createServer}from'vite';import react from'@vitejs/plugin-react';
      const boots=fs.existsSync('boots.json')?JSON.parse(fs.readFileSync('boots.json','utf8')):[];
      boots.push({pid:process.pid,identity:randomUUID()});fs.writeFileSync('boots.json',JSON.stringify(boots));console.log('Vite restart acceptance boot '+boots.length);
      const server=await createServer({configFile:false,plugins:[react()],server:{host:'127.0.0.1',port:Number(process.env.PORT),strictPort:true,watch:{usePolling:true,interval:300}}});await server.listen();
    `);
    await fs.writeFile(path.join(cwd, "crash.cjs"), "const fs=require('node:fs');const count=fs.existsSync('crashes.txt')?Number(fs.readFileSync('crashes.txt','utf8')):0;fs.writeFileSync('crashes.txt',String(count+1));console.log('Crash acceptance attempt '+(count+1));setTimeout(()=>process.exit(17),500);");
    const company = await json<{ id: string; issuePrefix: string }>(await page.request.post("/api/companies", { data: { name: "Full server restart acceptance" } })); companyId = company.id;
    const task = await json<{ id: string }>(await page.request.post(`/api/companies/${company.id}/issues`, { data: { title: "Keep the app across restart", status: "todo" } }));
    const collection = `/api/companies/${company.id}/runtime-services`, policyPath = `/api/companies/${company.id}/runtime-service-policy`;
    await json(await page.request.patch(policyPath, { data: { requestId: randomUUID(), expectedRevision: 0, config: { previewIdleSeconds: 7200, maxRunningServices: 2 } } }));
    const service = await json<RuntimeService>(await page.request.post(collection, { data: { requestId: randomUUID(), name: "Restarted control plane preview", issueId: task.id,
      cwd, command: "node start.mjs", endpoints: [{ name: "web" }], policy: { idleSeconds: 5400 } } })); serviceIds.push(service.id);
    const failing = await json<RuntimeService>(await page.request.post(collection, { data: { requestId: randomUUID(), name: "Bounded crash worker", issueId: task.id,
      cwd, command: "node crash.cjs", purpose: "worker", policy: { restartAttempts: 3 } } })); serviceIds.push(failing.id);
    await expect.poll(async () => (await read(service.id)).endpoints[0]?.status, { timeout: 40_000 }).toBe("ready");
    await expect.poll(async () => ({ state: (await read(failing.id)).state, attempts: await fs.readFile(path.join(cwd, "crashes.txt"), "utf8").catch(() => "0") }), { timeout: 40_000 }).toEqual({ state: "failed", attempts: "4" });
    expect((await read(failing.id)).restartCount).toBe(3);
    const before = await read(service.id), origin = before.endpoints[0]!.url!, direct = `http://127.0.0.1:${before.endpoints[0]!.port}`;
    const originalBoots = JSON.parse(await fs.readFile(path.join(cwd, "boots.json"), "utf8")); expect(originalBoots).toHaveLength(1);
    await page.goto(`/${company.issuePrefix}/runtime-services/${service.id}`);
    const popup = context.waitForEvent("page"); await page.getByRole("link", { name: "Open web", exact: true }).click(); const preview = await popup;
    preview.on("pageerror", (error) => pageErrors.push(error.message));
    const sockets: Array<{ host: string; connectedAt: number | null; closed: boolean }> = [];
    preview.on("websocket", (socket) => {
      const observed = { host: new URL(socket.url()).host, connectedAt: null as number | null, closed: false }; sockets.push(observed);
      socket.on("framereceived", ({ payload }) => { try { if (JSON.parse(payload.toString()).type === "connected") observed.connectedAt = Date.now(); } catch {} });
      socket.on("close", () => { observed.closed = true; });
    });
    const reconnected = (after: number) => expect.poll(() => sockets.some((socket) => socket.host === new URL(origin).host && !socket.closed && socket.connectedAt !== null && socket.connectedAt >= after && Date.now() - socket.connectedAt >= 1000),
      { timeout: 30_000, message: "Vite reconnects through the original preview gateway and completes its own reload" }).toBe(true);
    await expect(preview.getByRole("heading", { name: "Before Paperclip restart" })).toBeVisible({ timeout: 20_000 });
    const oldUrl = `${origin}/nested/app?retained=yes`;
    await preview.goto(oldUrl);
    await preview.evaluate(() => { localStorage.setItem("saved-state", "kept"); document.cookie = "saved_cookie=kept; Path=/; SameSite=Lax"; });
    const oldServer = await fixtureCommand(home, "status"); expect(oldServer.state).toBe("running");
    const outageAt = Date.now();
    const stopped = await fixtureCommand(home, stopMode);
    expect(stopped).toMatchObject({ state: "stopped", previous: { pid: oldServer.pid, ...(stopMode === "crash" ? { code: null, signal: "SIGKILL" } : { code: 0, signal: null }) } });
    await expect(fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(1500) })).rejects.toThrow();
    const offlineChecks: number[] = [];
    for (let count = 0; count < 3; count++) {
      expect(await (await fetch(`${direct}/saved.txt`)).text()).toBe("Persistent application data");
      expect(JSON.parse(await fs.readFile(path.join(cwd, "boots.json"), "utf8"))).toEqual(originalBoots);
      offlineChecks.push(Date.now()); await delay(1000);
    }
    const restarted = await fixtureCommand(home, "start"); expect(restarted.state).toBe("ready"); expect(restarted.pid).not.toBe(oldServer.pid);
    const restartedConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
    expect(restartedConfig.database).toEqual(originalConfig.database);
    await expect.poll(async () => (await read(service.id)).endpoints[0]?.status, { timeout: 75_000, message: "The restarted controller re-verifies the old preview route" }).toBe("ready");
    const recovered = await read(service.id);
    expect(recovered).toMatchObject({ id: service.id, allocationId: before.allocationId, policy: before.policy, restartCount: 0, retention: { state: "retained" } });
    expect(recovered.endpoints[0]).toMatchObject({ port: before.endpoints[0]!.port, url: origin, status: "ready" });
    expect(JSON.parse(await fs.readFile(path.join(cwd, "boots.json"), "utf8"))).toEqual(originalBoots);
    await reconnected(outageAt); await preview.waitForLoadState("domcontentloaded");
    await expect(preview.getByRole("heading", { name: "Before Paperclip restart" })).toBeVisible(); expect(preview.url()).toBe(oldUrl);
    expect(await preview.evaluate(() => localStorage.getItem("saved-state"))).toBe("kept");
    expect(await preview.evaluate(() => document.cookie)).toContain("saved_cookie=kept");
    expect(await preview.evaluate(async () => (await fetch('/saved.txt')).text())).toBe("Persistent application data");
    await preview.getByRole("button", { name: "Count 0", exact: true }).click(); await preview.getByRole("button", { name: "Count 1", exact: true }).click();
    await fs.writeFile(path.join(cwd, "App.jsx"), source("Hot reload after Paperclip restart"));
    await expect(preview.getByRole("heading", { name: "Hot reload after Paperclip restart" })).toBeVisible({ timeout: 20_000 });
    await expect(preview.getByRole("button", { name: "Count 2", exact: true })).toBeVisible();
    // Observe multiple real controller cycles; an immediate snapshot alone
    // would miss a crash budget reset that launches a fifth process later.
    for (let count = 0; count < 8; count++) {
      expect(await read(failing.id)).toMatchObject({ state: "failed", restartCount: 3 });
      expect(await fs.readFile(path.join(cwd, "crashes.txt"), "utf8")).toBe("4"); await delay(1000);
    }
    await page.reload();
    const card = page.getByRole("region", { name: "Restarted control plane preview service" });
    await card.getByRole("button", { name: "Logs", exact: true }).click();
    await expect(card.getByLabel("Restarted control plane preview logs")).toContainText("Vite restart acceptance boot 1");
    await preview.screenshot({ path: testInfo.outputPath("vite-fast-refresh-after-restart.png"), fullPage: true });
    const explicitRestartAt = Date.now();
    await card.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(async () => (await read(service.id)).state).toBe("stopped");
    await expect(fetch(`${direct}/saved.txt`)).rejects.toThrow();
    await card.getByRole("button", { name: "Start", exact: true }).click();
    await expect.poll(async () => (await read(service.id)).endpoints[0]?.status, { timeout: 30_000 }).toBe("ready");
    expect((await read(service.id)).endpoints[0]!.url).toBe(origin);
    expect(JSON.parse(await fs.readFile(path.join(cwd, "boots.json"), "utf8"))).toHaveLength(2);
    await reconnected(explicitRestartAt); await preview.waitForLoadState("domcontentloaded");
    await expect(preview.getByRole("heading", { name: "Hot reload after Paperclip restart" })).toBeVisible(); expect(preview.url()).toBe(oldUrl);
    expect(await preview.evaluate(async () => (await fetch("/saved.txt")).text())).toBe("Persistent application data");
    await preview.screenshot({ path: testInfo.outputPath("vite-after-control-plane-restart.png"), fullPage: true });
    await page.goto(`/${company.issuePrefix}/issues/${task.id}`);
    await expect(page.getByRole("region", { name: "Restarted control plane preview service" })).toContainText("Running");
    await expect(page.getByRole("region", { name: "Bounded crash worker service" })).toContainText("Failed");
    await page.screenshot({ path: testInfo.outputPath("task-services-after-restart.png"), fullPage: true });
    const policy = await json<{ revision: number; config: { previewIdleSeconds: number } }>(await page.request.get(policyPath));
    expect(policy).toMatchObject({ revision: 1, config: { previewIdleSeconds: 7200 } });
    expect(pageErrors).toEqual([]);
    const proof = testInfo.outputPath("restart-proof.json");
    await fs.writeFile(proof, JSON.stringify({ actualServerStopAndRestart: true, stopMode, originalDatabasePort: originalConfig.database.embeddedPostgresPort, oldServerPid: oldServer.pid, newServerPid: restarted.pid,
      sameDatabaseAndConfiguration: true, appStayedAliveDuringOutage: offlineChecks, originalAppProcess: originalBoots[0], noDuplicateLaunchAfterRecovery: true,
      previewOrigin: origin, originalRouteRestored: true, cookiesAndBrowserStoragePreserved: true, fastRefreshAfterRecovery: true,
      websocketConnections: sockets, explicitStopStartWorks: true, taskPropertiesRecovered: true, crashBudgetRetained: { restartCount: 3, launches: 4 }, companyPolicyPreserved: true, pageErrors }, null, 2));
    await testInfo.attach("restart-proof", { path: proof, contentType: "application/json" }); await preview.close();
  } finally {
    await fixtureCommand(home, "start");
    for (const id of serviceIds) {
      const current = await read(id);
      if (["stopped", "deleted"].includes(current.state)) continue;
      await json(await page.request.post(`/api/companies/${companyId}/runtime-services/${id}/control`, { data: { action: "stop", expectedRevision: current.revision, requestId: randomUUID() } }));
      await expect.poll(async () => (await read(id)).state, { timeout: 25_000 }).toBe("stopped");
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
}
