import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { RuntimeService } from "../../packages/shared/src/runtime-services";

test("lifetime drafts survive service stops but cannot overwrite another operator's policy", async ({ page }, testInfo) => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-policy-edit-ui-"));
  await fs.writeFile(path.join(cwd, "worker.cjs"), "console.log('Lifetime edit worker');setInterval(()=>{},1000);");
  const company = await (await page.request.post("/api/companies", { data: { name: "Lifetime edit review" } })).json();
  const created = await page.request.post(`/api/companies/${company.id}/runtime-services`, { data: {
    requestId: randomUUID(), name: "Lifetime edit worker", purpose: "worker", cwd, command: "node worker.cjs",
  } });
  expect(created.status()).toBe(202);
  const service = await created.json() as RuntimeService;
  const apiPath = `/api/companies/${company.id}/runtime-services/${service.id}`;
  const read = async (): Promise<RuntimeService> => (await page.request.get(apiPath)).json();
  try {
    await expect.poll(async () => (await read()).state, { timeout: 30_000 }).toBe("ready");
    await page.goto(`/${company.issuePrefix}/runtime-services/${service.id}`);
    await page.getByRole("button", { name: "Edit lifetime", exact: true }).click();
    await page.getByLabel("Sleep after idle minutes", { exact: true }).fill("90");
    // A separate controller/actor changes lifecycle while the user's draft is
    // open. This must not invalidate the unchanged policy baseline.
    const beforeStop = await read();
    expect((await page.request.post(`${apiPath}/control`, { data: { requestId: randomUUID(), expectedRevision: beforeStop.revision, action: "stop" } })).status()).toBe(202);
    await expect.poll(async () => (await read()).state).toBe("stopped");
    await page.getByRole("button", { name: "Save lifetime", exact: true }).click();
    await expect(page.getByText("Lifetime saved.", { exact: true })).toBeVisible();
    const saved = await read();
    expect(saved).toMatchObject({ state: "stopped", desiredState: "stopped", policy: { idleSeconds: 5400 } });
    await page.getByLabel("Sleep after idle minutes", { exact: true }).fill("120");
    expect((await page.request.patch(`${apiPath}/policy`, { data: { requestId: randomUUID(), expectedRevision: saved.revision, expectedPolicy: saved.policy, policy: { maxRunningSeconds: 1800 } } })).status()).toBe(200);
    await page.getByRole("button", { name: "Save lifetime", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Service lifetime changed");
    await expect(page.getByLabel("Sleep after idle minutes", { exact: true })).toHaveValue("120");
    expect((await read()).policy).toMatchObject({ idleSeconds: 5400, maxRunningSeconds: 1800 });
    await page.screenshot({ path: testInfo.outputPath("policy-conflict-keeps-draft.png"), fullPage: true });
    await page.getByRole("button", { name: "Load current lifetime", exact: true }).click();
    await expect(page.getByLabel("Sleep after idle minutes", { exact: true })).toHaveValue("90");
    await expect(page.getByLabel("Maximum running minutes", { exact: true })).toHaveValue("30");
  } finally {
    const current = await read();
    if (current.state !== "stopped") {
      expect((await page.request.post(`${apiPath}/control`, { data: { requestId: randomUUID(), expectedRevision: current.revision, action: "stop" } })).status()).toBe(202);
      await expect.poll(async () => (await read()).state, { timeout: 20_000 }).toBe("stopped");
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("real service creation, task discovery, logs, and lifecycle controls on desktop and mobile", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const renderErrors: string[] = [];
  page.on("pageerror", (error) => renderErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && message.text().includes("same key")) renderErrors.push(message.text()); });
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-ui-"));
  await fs.writeFile(path.join(cwd, "content.txt"), "dirty source one");
  await fs.writeFile(path.join(cwd, "server.cjs"), `const fs=require('node:fs');console.log('Service UI acceptance boot');require('node:http').createServer((q,s)=>s.end(fs.readFileSync('content.txt'))).listen(Number(process.env.PORT),'127.0.0.1');`);
  let serviceId: string | undefined;
  let companyId: string | undefined;
  try {
    const companyResponse = await page.request.post("/api/companies", { data: { name: "Service controls acceptance" } });
    expect(companyResponse.ok()).toBe(true);
    const company = await companyResponse.json(); companyId = company.id;
    const taskResponse = await page.request.post(`/api/companies/${company.id}/issues`, { data: { title: "Develop a preview", status: "todo" } });
    expect(taskResponse.ok()).toBe(true);
    const task = await taskResponse.json();
    await page.goto(`/${company.issuePrefix}/runtime-services`);
    await page.getByRole("button", { name: "New service", exact: true }).click();
    const form = page.getByRole("form", { name: "Create service" });
    await form.getByLabel("Name", { exact: true }).fill("Node acceptance preview");
    await form.getByLabel("Start command").fill("node server.cjs");
    await form.getByLabel("Working folder").fill(cwd);
    await form.getByText("Task and environment", { exact: true }).click();
    await form.getByRole("combobox", { name: "Associated task" }).click();
    await page.getByPlaceholder("Find a task by title or identifier…").fill("Develop a preview");
    await page.getByRole("option", { name: `${task.identifier} · Develop a preview`, exact: true }).click();
    await form.getByRole("button", { name: "Create and start" }).click();
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/runtime-services/[a-f0-9-]+$`), { timeout: 30_000 });
    // Submitting the expanded form scrolls to its footer. The new detail must
    // show the result first, not inherit that offset and hide its status.
    await expect(page.getByRole("heading", { name: "Node acceptance preview", exact: true })).toBeInViewport();
    serviceId = page.url().split("/").at(-1)!;
    const servicePath = `/api/companies/${company.id}/runtime-services/${serviceId}`;
    const read = async (): Promise<RuntimeService> => (await page.request.get(servicePath)).json();
    await expect.poll(async () => (await read()).state, { timeout: 40_000 }).toBe("ready");
    const card = page.getByRole("region", { name: "Node acceptance preview service" });
    await expect(card.getByRole("status")).toContainText("Running");
    // Internal health is real, but no gateway is configured in this local
    // fixture. The UI must report that limitation instead of inventing a URL.
    await expect(card).toContainText("Preview exposure is not configured");
    const running = await read();
    const directUrl = `http://127.0.0.1:${running.endpoints[0]!.port}`;
    expect(await (await fetch(directUrl)).text()).toBe("dirty source one");
    await fs.writeFile(path.join(cwd, "content.txt"), "dirty source two");
    expect(await (await fetch(directUrl)).text()).toBe("dirty source two");
    await card.getByRole("button", { name: "Logs", exact: true }).click();
    await expect(card.getByLabel("Node acceptance preview logs")).toContainText("Service UI acceptance boot");
    await page.getByRole("button", { name: "Edit lifetime" }).click();
    await page.getByLabel("Sleep after idle minutes").fill("90");
    const keepUntilLocal = await page.evaluate(() => {
      const date = new Date(Date.now() + 3600_000);
      return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    });
    await page.getByLabel("Keep running until", { exact: true }).fill(keepUntilLocal);
    await page.getByRole("button", { name: "Save lifetime" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Lifetime saved" })).toBeVisible();
    await expect.poll(async () => (await read()).policy.idleSeconds).toBe(5400);
    const keepUntilISO = await page.evaluate((value) => new Date(value).toISOString(), keepUntilLocal);
    expect((await read()).policy.keepRunningUntil).toBe(keepUntilISO);
    await expect(card).toContainText("Idle sleep paused until");
    await page.screenshot({ path: testInfo.outputPath("service-lifetime.png"), fullPage: true });
    await page.getByLabel("Keep running until", { exact: true }).fill("");
    await page.getByRole("button", { name: "Save lifetime" }).click();
    await expect.poll(async () => (await read()).policy.keepRunningUntil).toBeNull();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await page.screenshot({ path: testInfo.outputPath("service-desktop.png"), fullPage: true });

    const completed = await page.request.patch(`/api/issues/${task.id}`, { data: { status: "done" } });
    expect(completed.ok()).toBe(true);
    await page.goto(`/${company.issuePrefix}/issues/${task.id}`);
    const taskCard = page.getByRole("region", { name: "Node acceptance preview service" });
    await expect(taskCard).toBeVisible({ timeout: 30_000 });
    await expect(taskCard).toContainText("Running");
    const taskStopBounds = await taskCard.getByRole("button", { name: "Stop", exact: true }).boundingBox();
    expect(taskStopBounds).not.toBeNull();
    expect(taskStopBounds!.y + taskStopBounds!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
    await page.screenshot({ path: testInfo.outputPath("task-services.png"), fullPage: true });
    await taskCard.getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(async () => (await read()).state).toBe("stopped");
    await expect(taskCard.getByRole("status")).toContainText("Stopped");
    await expect(fetch(directUrl)).rejects.toThrow();
    await taskCard.getByRole("button", { name: "Start", exact: true }).click();
    await expect.poll(async () => (await read()).state, { timeout: 30_000 }).toBe("ready");
    expect(await fs.readFile(path.join(cwd, "content.txt"), "utf8")).toBe("dirty source two");

    await page.setViewportSize({ width: 390, height: 760 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/${company.issuePrefix}/runtime-services/${serviceId}`);
    await expect(card).toBeVisible();
    await card.getByRole("button", { name: "Stop", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await read()).state).toBe("stopped");
    await expect(card.getByRole("status")).toContainText("Stopped");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("service-mobile.png"), fullPage: true });
    await testInfo.attach("service-mobile", { path: testInfo.outputPath("service-mobile.png"), contentType: "image/png" });
    await testInfo.attach("service-desktop", { path: testInfo.outputPath("service-desktop.png"), contentType: "image/png" });
    await testInfo.attach("service-lifetime", { path: testInfo.outputPath("service-lifetime.png"), contentType: "image/png" });
    expect(renderErrors).toEqual([]);
  } finally {
    if (companyId && serviceId) {
      const url = `/api/companies/${companyId}/runtime-services/${serviceId}`;
      const service = await (await page.request.get(url)).json() as RuntimeService;
      if (service.state !== "stopped") {
        await page.request.post(`${url}/control`, { data: { action: "stop", expectedRevision: service.revision, requestId: randomUUID() } });
        await expect.poll(async () => (await (await page.request.get(url)).json() as RuntimeService).state, { timeout: 20_000 }).toBe("stopped");
      }
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("a lost restart response is retried once without launching another worker", async ({ page }) => {
  test.setTimeout(120_000);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-retry-ui-"));
  await fs.writeFile(path.join(cwd, "worker.cjs"), `const fs=require('node:fs');let count=0;try{count=Number(fs.readFileSync('boots.txt','utf8'))}catch{}fs.writeFileSync('boots.txt',String(count+1));console.log('Worker boot '+(count+1));setInterval(()=>{},1000);`);
  const company = await (await page.request.post("/api/companies", { data: { name: "Service response recovery" } })).json();
  const created = await page.request.post(`/api/companies/${company.id}/runtime-services`, { data: {
    requestId: randomUUID(), name: "Persistent worker", purpose: "worker", cwd, command: "node worker.cjs",
  } });
  expect(created.status()).toBe(202);
  const service = await created.json() as RuntimeService;
  const servicePath = `/api/companies/${company.id}/runtime-services/${service.id}`;
  const read = async (): Promise<RuntimeService> => (await page.request.get(servicePath)).json();
  try {
    await expect.poll(async () => (await read()).state, { timeout: 30_000 }).toBe("ready");
    expect((await read()).policy.idleSeconds).toBeNull();
    await expect.poll(async () => fs.readFile(path.join(cwd, "boots.txt"), "utf8")).toBe("1");
    await page.goto(`/${company.issuePrefix}/runtime-services/${service.id}`);
    const card = page.getByRole("region", { name: "Persistent worker service" });
    await expect(card).toContainText("Runs until stopped");
    const restartRequests: Array<{ requestId: string; expectedRevision: number }> = [];
    await page.route(`**${servicePath}/control`, async (route) => {
      const input = route.request().postDataJSON();
      if (input.action !== "restart") { await route.continue(); return; }
      restartRequests.push(input);
      if (restartRequests.length === 1) {
        // The real server accepts the operation; only its response is lost.
        const response = await route.fetch();
        expect(response.status()).toBe(202);
        await route.abort("failed");
      } else await route.continue();
    });
    await card.getByRole("button", { name: "Restart", exact: true }).click();
    await expect(card.getByRole("alert")).toContainText("Checking the service’s current state");
    await expect.poll(async () => fs.readFile(path.join(cwd, "boots.txt"), "utf8"), { timeout: 30_000 }).toBe("2");
    await expect.poll(async () => (await read()).state).toBe("ready");
    await card.getByRole("button", { name: "Retry same request" }).click();
    await expect(card.getByRole("alert")).toHaveCount(0);
    expect(restartRequests).toHaveLength(2);
    expect(restartRequests[1]).toEqual(restartRequests[0]);
    expect(await fs.readFile(path.join(cwd, "boots.txt"), "utf8")).toBe("2");
    await expect(card.getByRole("status")).toContainText("Running");
  } finally {
    const current = await read();
    await page.request.post(`${servicePath}/control`, { data: { action: "stop", expectedRevision: current.revision, requestId: randomUUID() } });
    await expect.poll(async () => (await read()).state, { timeout: 20_000 }).toBe("stopped");
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("a lost creation response preserves the original form request and recovers one service", async ({ page }) => {
  test.setTimeout(90_000);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-create-retry-"));
  await fs.writeFile(path.join(cwd, "worker.cjs"), "setInterval(()=>{},1000);");
  const company = await (await page.request.post("/api/companies", { data: { name: "Creation response recovery" } })).json();
  const base = `/api/companies/${company.id}/runtime-services`;
  const creations: unknown[] = [];
  await page.route(`**${base}`, async (route) => {
    if (route.request().method() !== "POST") { await route.continue(); return; }
    creations.push(route.request().postDataJSON());
    if (creations.length === 1) {
      const response = await route.fetch();
      expect(response.status()).toBe(202);
      await route.abort("failed");
    } else await route.continue();
  });
  try {
    await page.goto(`/${company.issuePrefix}/runtime-services`);
    await page.getByRole("button", { name: "New service", exact: true }).click();
    const form = page.getByRole("form", { name: "Create service" });
    await form.getByLabel("Name", { exact: true }).fill("Create once");
    await form.getByRole("combobox", { name: "Purpose" }).click();
    await page.getByRole("option", { name: "Background worker" }).click();
    await form.getByLabel("Start command").fill("node worker.cjs");
    await form.getByLabel("Working folder").fill(cwd);
    await form.getByRole("button", { name: "Create and start" }).click();
    await expect(form.getByRole("alert")).toContainText("without creating a duplicate");
    await expect(form.getByLabel("Start command")).toBeDisabled();
    await expect(form.getByLabel("Name", { exact: true })).toHaveValue("Create once");
    await form.getByRole("button", { name: "Retry creation" }).click();
    await expect(page).toHaveURL(new RegExp(`/${company.issuePrefix}/runtime-services/[a-f0-9-]+$`));
    expect(creations).toHaveLength(2);
    expect(creations[1]).toEqual(creations[0]);
    const services = await (await page.request.get(base)).json() as RuntimeService[];
    expect(services).toHaveLength(1);
    await expect.poll(async () => (await (await page.request.get(`${base}/${services[0]!.id}`)).json() as RuntimeService).state, { timeout: 30_000 }).toBe("ready");
  } finally {
    const services = await (await page.request.get(base)).json() as RuntimeService[];
    for (const service of services) {
      await page.request.post(`${base}/${service.id}/control`, { data: { action: "stop", expectedRevision: service.revision, requestId: randomUUID() } });
      await expect.poll(async () => (await (await page.request.get(`${base}/${service.id}`)).json() as RuntimeService).state, { timeout: 20_000 }).toBe("stopped");
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("mobile task controls remain usable through slow startup, cancellation, and readiness failure", async ({ page }, testInfo) => {
  test.setTimeout(150_000);
  await page.setViewportSize({ width: 390, height: 760 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-slow-mobile-"));
  await fs.writeFile(path.join(cwd, "server.cjs"), `
const fs = require('node:fs');
let boots = 0; try { boots = Number(fs.readFileSync('boots.txt', 'utf8')); } catch {}
fs.writeFileSync('boots.txt', String(boots + 1));
console.log('Waiting for application setup');
require('node:http').createServer((request, response) => {
  const ready = fs.existsSync('ready.txt');
  response.statusCode = ready ? 200 : 503;
  response.end(ready ? 'Application ready' : 'Setup is still running');
}).listen(Number(process.env.PORT), '127.0.0.1');
`);
  const company = await (await page.request.post("/api/companies", { data: { name: "Slow service mobile acceptance" } })).json();
  const task = await (await page.request.post(`/api/companies/${company.id}/issues`, { data: { title: "Develop a slow-starting preview", status: "todo" } })).json();
  const created = await page.request.post(`/api/companies/${company.id}/runtime-services`, { data: {
    requestId: randomUUID(), name: "Setup preview", cwd, command: "node server.cjs", issueId: task.id,
    start: false, endpoints: [{ name: "web" }], policy: { readinessTimeoutSeconds: 30, restartAttempts: 0 },
  } });
  expect(created.status()).toBe(202);
  const service = await created.json() as RuntimeService;
  const servicePath = `/api/companies/${company.id}/runtime-services/${service.id}`;
  const read = async (): Promise<RuntimeService> => {
    const response = await page.request.get(servicePath);
    expect(response.ok()).toBe(true);
    return response.json();
  };
  let releaseFirstResponse!: () => void;
  const responseGate = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
  const starts: Array<{ requestId: string }> = [];
  await page.route(`**${servicePath}/control`, async (route) => {
    const input = route.request().postDataJSON();
    if (input.action !== "start") { await route.continue(); return; }
    starts.push(input);
    if (starts.length !== 1) { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.status()).toBe(202);
    await responseGate;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`/${company.issuePrefix}/issues/${task.identifier}`);
    await page.getByRole("button", { name: "Show properties", exact: true }).click({ timeout: 15_000 });
    const drawer = page.getByRole("dialog");
    const card = drawer.getByRole("region", { name: "Setup preview service" });
    await expect(card).toBeVisible();
    const start = card.getByRole("button", { name: "Start", exact: true });
    await start.focus();
    await page.keyboard.press("Enter");
    await expect(card.getByRole("status")).toContainText("Requesting start");
    await expect(card.getByRole("button", { name: "Restart", exact: true })).toBeDisabled();
    // A repeated key activation while the real request's response is delayed
    // must not send another mutation, even if polling sees the accepted start.
    await page.keyboard.press("Enter");
    expect(starts).toHaveLength(1);
    expect(await card.locator("svg.animate-spin, svg[class*='animate-spin']").evaluateAll((elements) => elements.every((element) => getComputedStyle(element).animationName === "none"))).toBe(true);
    releaseFirstResponse();
    await expect.poll(async () => (await read()).state, { timeout: 20_000 }).toBe("starting");
    await expect(card.getByRole("status")).toContainText("Starting");
    await expect(card).toContainText("Waiting for the application to become ready");
    expect(await fs.readFile(path.join(cwd, "boots.txt"), "utf8")).toBe("1");
    await card.getByRole("button", { name: "Stop", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await read()).state, { timeout: 20_000 }).toBe("stopped");
    await expect(card.getByRole("status")).toContainText("Stopped");

    const stopped = await read();
    const policy = await page.request.patch(`${servicePath}/policy`, { data: { requestId: randomUUID(), expectedRevision: stopped.revision, policy: { readinessTimeoutSeconds: 3 } } });
    expect(policy.ok()).toBe(true);
    // Refresh through the user's drawer so the next action uses its new revision.
    await page.reload();
    await page.getByRole("button", { name: "Show properties", exact: true }).click({ timeout: 15_000 });
    await card.getByRole("button", { name: "Start", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await read()).state, { timeout: 25_000 }).toBe("failed");
    await expect(card.getByRole("alert")).toContainText("startup deadline");
    await card.getByRole("button", { name: "Logs", exact: true }).click();
    await expect(card.getByLabel("Setup preview logs")).toContainText("Waiting for application setup");
    await card.getByRole("button", { name: "Stop", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await read()).state, { timeout: 20_000 }).toBe("stopped");
    await fs.writeFile(path.join(cwd, "ready.txt"), "Setup complete; retain this application data.\n");
    await expect(card.getByRole("status")).toContainText("Stopped");
    await card.getByRole("button", { name: "Start", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await read()).state, { timeout: 25_000 }).toBe("ready");
    await expect(card.getByRole("status")).toContainText("Running");
    expect(starts).toHaveLength(3);
    expect(await fs.readFile(path.join(cwd, "boots.txt"), "utf8")).toBe("3");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await card.getByRole("button", { name: "Stop", exact: true }).scrollIntoViewIfNeeded();
    const bounds = await card.getByRole("button", { name: "Stop", exact: true }).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeGreaterThanOrEqual(0);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(760);
    await page.screenshot({ path: testInfo.outputPath("mobile-task-service-recovered.png"), fullPage: true });
  } finally {
    releaseFirstResponse();
    const current = await read();
    if (current.state !== "stopped") {
      const response = await page.request.post(`${servicePath}/control`, { data: { action: "stop", expectedRevision: current.revision, requestId: randomUUID() } });
      expect(response.ok()).toBe(true);
      await expect.poll(async () => (await read()).state, { timeout: 20_000 }).toBe("stopped");
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
