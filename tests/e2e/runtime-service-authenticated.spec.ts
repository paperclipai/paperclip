import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test as base, expect, type Page } from "@playwright/test";
import type { RuntimeService } from "../../packages/shared/src/runtime-services";
import { verifyPreviewIsolation } from "./runtime-service-preview-isolation";

const password = "isolated-preview-test-password";
const test = base.extend<{ trackService: (directory: string, apiPath?: string) => void }>({
  trackService: [async ({ page, baseURL }, use) => {
    const directories = new Set<string>(), servicePaths = new Set<string>();
    await use((cwd, servicePath) => { directories.add(cwd); if (servicePath) servicePaths.add(servicePath); });
    const stopped = await Promise.allSettled([...servicePaths].map(async (apiPath) => {
      const current: RuntimeService = await (await page.request.get(apiPath)).json();
      if (current.state !== "stopped") {
        const response = await page.request.post(`${apiPath}/control`, { headers: { origin: baseURL! },
          data: { requestId: randomUUID(), expectedRevision: current.revision, action: "stop" } });
        expect(response.status()).toBe(202);
        await expect.poll(async () => (await (await page.request.get(apiPath!)).json()).state, { timeout: 20_000 }).toBe("stopped");
      }
    }));
    const failures = stopped.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Preview fixture cleanup failed");
    await Promise.all([...directories].map((directory) => fs.rm(directory, { recursive: true, force: true })));
  }, { timeout: 45_000 }],
});

async function signUp(page: Page, email: string, name: string) {
  await expect(page.getByRole("heading", { name: "Sign in to Paperclip", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create one", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByLabel("Email", { exact: true }).fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create Account", exact: true }).click();
  await expect(page).not.toHaveURL(/\/auth/, { timeout: 20_000 });
}

async function bootstrapURL(baseURL: string) {
  const home = process.env.PAPERCLIP_AUTH_PREVIEW_FIXTURE_HOME;
  const config = home ? path.join(home, "instances", "playwright-e2e", "config.json") : undefined;
  if (!home || !path.basename(home).startsWith("paperclip-e2e-home-") ||
      config !== path.join(home, "instances", "playwright-e2e", "config.json") || new URL(baseURL).hostname !== "127.0.0.1") {
    throw new Error("Authenticated preview acceptance requires its dedicated throwaway instance");
  }
  const stored = JSON.parse(await fs.readFile(config, "utf8"));
  if (stored.database?.mode !== "embedded-postgres" || stored.server?.port !== Number(new URL(baseURL).port)) throw new Error("Expected the isolated embedded database and server port");
  const result = await promisify(execFile)(process.execPath, ["--import", "./cli/node_modules/tsx/dist/loader.mjs",
    "packages/db/scripts/create-auth-bootstrap-invite.ts", "--config", config, "--base-url", baseURL],
  { cwd: path.resolve(import.meta.dirname, "../.."), timeout: 20_000 });
  return result.stdout.trim();
}

test("authenticated preview access follows current membership and recovers sign-in at the original app path", async ({ page, browser, baseURL, trackService }, testInfo) => {
  test.setTimeout(180_000);
  const health = await (await page.request.get("/api/health")).json();
  expect(health.deploymentMode).toBe("authenticated");
  const ownerEmail = `preview-owner-${randomUUID()}@example.test`, memberEmail = `preview-member-${randomUUID()}@example.test`;
  await page.goto("/auth"); await signUp(page, ownerEmail, "Preview owner");
  await page.goto(await bootstrapURL(baseURL!));
  await page.getByRole("button", { name: "Accept invite", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Bootstrap complete", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "Open board", exact: true }).click();
  const headers = { origin: baseURL! };
  const companyResponse = await page.request.post("/api/companies", { headers, data: { name: "Authenticated preview acceptance" } });
  expect(companyResponse.ok()).toBe(true);
  const company = await companyResponse.json();
  await page.goto(`/${company.issuePrefix}/company/settings/members?tab=invites`);
  await page.getByRole("radio", { name: /^Operator/ }).check();
  await page.getByRole("button", { name: "Create invite", exact: true }).click();
  const invite = page.getByRole("textbox", { name: "Latest invite URL", exact: true }); await expect(invite).toBeVisible();
  const memberContext = await browser.newContext({ viewport: { width: 390, height: 760 }, reducedMotion: "reduce" });
  try {
    const memberPage = await memberContext.newPage();
    await memberPage.goto(await invite.inputValue());
    await expect(memberPage.getByRole("heading", { name: "Create your account", exact: true })).toBeVisible();
    await memberPage.getByLabel("Name", { exact: true }).fill("Preview member");
    await memberPage.getByLabel("Email", { exact: true }).fill(memberEmail);
    await memberPage.getByLabel("Password", { exact: true }).fill(password);
    await memberPage.getByRole("button", { name: "Create account and continue", exact: true }).click();
    await expect(memberPage).not.toHaveURL(/\/invite\//, { timeout: 20_000 });
    const members = await (await page.request.get(`/api/companies/${company.id}/members`)).json();
    const member = members.members.find((entry: { user?: { email?: string } }) => entry.user?.email === memberEmail);
    expect(member).toMatchObject({ status: "active", membershipRole: "operator" });
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-authenticated-preview-")); trackService(cwd);
    await fs.writeFile(path.join(cwd, "app.cjs"), `const http=require('node:http'),crypto=require('node:crypto');
const server=http.createServer((req,res)=>{if(req.url==='/echo'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({app:true,headers:req.headers}));return}res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><title>Private preview</title></head><body><h1>Private preview</h1><p id="path"></p><script>document.getElementById("path").textContent=location.pathname+location.search;window.appSocket=new WebSocket(location.origin.replace("http","ws")+"/events");</script></body></html>')});
server.on('upgrade',(req,socket)=>{const key=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+key+'\\r\\n\\r\\n');const timer=setInterval(()=>socket.write(Buffer.from([129,2,111,107])),200);socket.on('error',()=>{});socket.on('close',()=>clearInterval(timer))});server.listen(Number(process.env.PORT),'127.0.0.1');`);
    const created = await page.request.post(`/api/companies/${company.id}/runtime-services`, { headers, data: {
      requestId: randomUUID(), name: "Authenticated app", cwd, command: "node app.cjs", endpoints: [{ name: "web" }],
    } });
    expect(created.status()).toBe(202);
    const service: RuntimeService = await created.json(), servicePath = `/api/companies/${company.id}/runtime-services/${service.id}`;
    trackService(cwd, servicePath);
    const read = async (): Promise<RuntimeService> => (await page.request.get(servicePath)).json();
    await expect.poll(async () => (await read()).endpoints[0]?.status, { timeout: 40_000 }).toBe("ready");
    const appOrigin = (await read()).endpoints[0]!.url!, deepURL = `${appOrigin}/nested/page?check=1`;
    const preview = await memberContext.newPage();
    const socketPromise = preview.waitForEvent("websocket"); await preview.goto(deepURL);
    await expect(preview.getByRole("heading", { name: "Private preview", exact: true })).toBeVisible();
    expect(preview.url()).toBe(deepURL);
    const socket = await socketPromise; let socketClosed = false; socket.on("close", () => { socketClosed = true; });
    expect((await memberContext.request.get(`${appOrigin}/echo`)).status()).toBe(200);
    const echo = await (await memberContext.request.get(`${appOrigin}/echo`)).json();
    expect(echo.headers.cookie).toBeUndefined();
    const membershipPath = `/api/companies/${company.id}/members/${member.id}`;
    expect((await page.request.patch(membershipPath, { headers, data: { membershipRole: "viewer" } })).status()).toBe(200);
    await memberPage.goto(`${baseURL}/${company.issuePrefix}/runtime-services/${service.id}`);
    await expect(memberPage.getByRole("link", { name: "Open web", exact: true })).toBeVisible();
    await expect(memberPage.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0);
    const current = await read();
    expect((await memberContext.request.post(`${baseURL}${servicePath}/control`, { headers,
      data: { requestId: randomUUID(), expectedRevision: current.revision, action: "stop" } })).status()).toBe(403);
    expect((await memberContext.request.get(`${appOrigin}/echo`)).status()).toBe(200);
    expect(socketClosed).toBe(false);
    await memberPage.screenshot({ path: testInfo.outputPath("viewer-service-mobile.png"), fullPage: true });
    expect((await page.request.patch(membershipPath, { headers, data: { status: "suspended" } })).status()).toBe(200);
    await expect.poll(() => socketClosed, { timeout: 10_000 }).toBe(true);
    expect((await memberContext.request.get(`${appOrigin}/echo`)).status()).toBe(403);
    await preview.reload();
    await expect(preview.getByRole("heading", { name: "Preview access required", exact: true })).toBeVisible();
    await expect(preview.getByText(/company administrator/)).toBeVisible();
    await preview.screenshot({ path: testInfo.outputPath("membership-removed-mobile.png"), fullPage: true });
    expect((await read()).state).toBe("ready");
    expect((await page.request.patch(membershipPath, { headers, data: { status: "active" } })).status()).toBe(200);
    await preview.goto(deepURL);
    await expect(preview.getByRole("heading", { name: "Private preview", exact: true })).toBeVisible();
    await memberContext.clearCookies();
    await preview.goto(deepURL);
    await expect(preview.getByRole("heading", { name: "Sign in to open this preview", exact: true })).toBeVisible();
    await preview.getByRole("link", { name: "Open in Paperclip", exact: true }).click();
    await expect(preview.getByRole("heading", { name: "Sign in to Paperclip", exact: true })).toBeVisible();
    await preview.getByLabel("Email", { exact: true }).fill(memberEmail);
    await preview.getByLabel("Password", { exact: true }).fill(password);
    await preview.getByRole("button", { name: "Sign In", exact: true }).click();
    await expect(preview.getByRole("heading", { name: "Private preview", exact: true })).toBeVisible({ timeout: 20_000 });
    expect(preview.url()).toBe(deepURL);
    expect((await read()).state).toBe("ready");
    await preview.screenshot({ path: testInfo.outputPath("signed-in-preview-mobile.png"), fullPage: true });
    const isolation = await test.step("Sibling and cross-company preview isolation", () => verifyPreviewIsolation({
      owner: page, member: memberContext, primary: preview, browser, baseURL: baseURL!, companyId: company.id,
      serviceId: service.id, appOrigin, trackService, testInfo,
    }));
    const proof = testInfo.outputPath("authenticated-preview.json");
    await fs.writeFile(proof, JSON.stringify({ deploymentMode: health.deploymentMode, viewerCanPreview: true,
      viewerCannotStop: true, suspendedMemberDisconnected: socketClosed, restoredMemberCanPreview: true,
      loginPreservesDeepLink: true, appReceivesNoAuthCookies: true, serviceId: service.id, isolation }, null, 2));
    await testInfo.attach("authenticated-preview.json", { path: proof, contentType: "application/json" });
  } finally { await memberContext.close(); }
});
