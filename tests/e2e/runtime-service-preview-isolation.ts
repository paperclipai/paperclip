import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import type { RuntimeService } from "../../packages/shared/src/runtime-services";

const cookieName = "__Host-Http-paperclip-preview";

/** Real sibling processes and browser origins. The only adversarial injection
 * is replaying an already-issued fixture credential through a raw HTTP client. */
export async function verifyPreviewIsolation(input: {
  owner: Page; member: BrowserContext; primary: Page; browser: Browser; baseURL: string;
  companyId: string; serviceId: string; appOrigin: string;
  trackService: (cwd: string, apiPath?: string) => void; testInfo: TestInfo;
}) {
  const { owner, member, primary, browser, baseURL, companyId, appOrigin, trackService, testInfo } = input;
  const headers = { origin: baseURL };
  const create = async (company: string, label: string, api = false) => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-preview-isolation-")); trackService(cwd);
    await fs.writeFile(path.join(cwd, "app.cjs"), `const http=require('node:http');
function start(endpoint,port){http.createServer((req,res)=>{
if(req.url==='/attempt-cookies'){res.setHeader('Set-Cookie',[${JSON.stringify(`${cookieName}=untrusted-app; Path=/; Secure; HttpOnly; SameSite=Lax`)},${JSON.stringify(`app_scope=sibling; Domain=${new URL(appOrigin).hostname}; Path=/; SameSite=Lax`)}]);}
if(req.headers.origin){res.setHeader('Access-Control-Allow-Origin',req.headers.origin);res.setHeader('Access-Control-Allow-Credentials','true');}
if(req.url==='/data'||req.url.startsWith('/api/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({application:${JSON.stringify(label)},endpoint,cookie:req.headers.cookie||null}));return;}
res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><title>'+${JSON.stringify(label)}+'</title></head><body><h1>'+${JSON.stringify(label)}+'</h1><p>'+endpoint+'</p></body></html>');
}).listen(Number(port),'127.0.0.1')};start('web',process.env.PORT);if(process.env.API_PORT)start('api',process.env.API_PORT);`);
    const created = await owner.request.post(`/api/companies/${company}/runtime-services`, { headers, data: {
      requestId: randomUUID(), name: label, cwd, command: "node app.cjs",
      endpoints: [{ name: "web" }, ...(api ? [{ name: "api", portEnv: "API_PORT" }] : [])],
    } });
    expect(created.status()).toBe(202);
    const service: RuntimeService = await created.json(), apiPath = `/api/companies/${company}/runtime-services/${service.id}`;
    trackService(cwd, apiPath);
    const read = async (): Promise<RuntimeService> => (await owner.request.get(apiPath)).json();
    await expect.poll(async () => {
      const current = await read();
      return current.endpoints.length === (api ? 2 : 1)
        && current.endpoints.every((endpoint) => endpoint.status === "ready" && Boolean(endpoint.url));
    }, { timeout: 40_000 }).toBe(true);
    const ready = await read();
    return { apiPath, read, web: ready.endpoints.find((endpoint) => endpoint.name === "web")!.url!,
      api: ready.endpoints.find((endpoint) => endpoint.name === "api")?.url, id: service.id };
  };

  const sibling = await create(companyId, "Sibling app", true);
  const foreignCompanyResponse = await owner.request.post("/api/companies", { headers, data: { name: "Other preview company" } });
  expect(foreignCompanyResponse.ok()).toBe(true);
  const foreignCompany = await foreignCompanyResponse.json();
  const foreign = await create(foreignCompany.id, "Other company app");
  expect(new Set([appOrigin, sibling.web, sibling.api, foreign.web]).size).toBe(4);
  const ownCookie = (await member.cookies(appOrigin)).find((cookie) => cookie.name === cookieName)!;
  expect(ownCookie).toMatchObject({ httpOnly: true, secure: true, sameSite: "Lax", domain: new URL(appOrigin).hostname });
  await primary.evaluate(() => { localStorage.setItem("private_app_state", "primary"); document.cookie = "app_scope=primary; Path=/; SameSite=Lax"; });

  const replay = await browser.newContext();
  const siblingPage = await member.newPage(), foreignPage = await member.newPage();
  try {
    // Validate that the issued credential works only for its app, rather than
    // confusing an expired cookie or an unavailable service with isolation.
    const credential = { cookie: `${cookieName}=${ownCookie.value}` };
    expect((await replay.request.get(`${appOrigin}/echo`, { headers: credential })).status()).toBe(200);
    for (const target of [sibling.web, sibling.api!, foreign.web]) {
      expect((await replay.request.get(`${target}/data`, { headers: credential })).status()).toBe(401);
    }
    expect((await replay.request.get(`${baseURL}/api/companies/${companyId}/runtime-services/${input.serviceId}`, { headers: credential })).status()).toBe(401);
    expect((await replay.request.post(`${appOrigin}/.paperclip/activity`, {
      headers: { ...credential, origin: sibling.web }, data: { visible: true },
    })).status()).toBe(403);

    expect((await member.request.get(`${sibling.web}/data`)).status()).toBe(401);
    await siblingPage.goto(sibling.web);
    await expect(siblingPage.getByRole("heading", { name: "Sibling app", exact: true })).toBeVisible();
    expect(await siblingPage.evaluate(() => localStorage.getItem("private_app_state"))).toBeNull();
    expect(await siblingPage.evaluate(() => document.cookie)).not.toContain("app_scope=primary");
    const siblingCookie = (await member.cookies(sibling.web)).find((cookie) => cookie.name === cookieName)!;
    expect(siblingCookie.value).not.toBe(ownCookie.value);
    // The member can use this second app, but its credential cannot authorize
    // another endpoint on the same service record.
    expect((await replay.request.get(`${sibling.api}/data`, { headers: { cookie: `${cookieName}=${siblingCookie.value}` } })).status()).toBe(401);
    await siblingPage.goto(`${sibling.web}/attempt-cookies`);
    expect((await member.cookies(sibling.web)).find((cookie) => cookie.name === cookieName)?.value).toBe(siblingCookie.value);
    expect(await siblingPage.evaluate(() => document.cookie)).toContain("app_scope=sibling");
    expect(await primary.evaluate(() => document.cookie)).toContain("app_scope=primary");
    expect(await primary.evaluate(() => localStorage.getItem("private_app_state"))).toBe("primary");
    await siblingPage.evaluate(() => {
      document.cookie = "parent_scope=untrusted; Domain=localhost; Path=/";
      document.cookie = "__Host-Http-paperclip-preview=untrusted; Secure; Path=/";
    });
    expect(await primary.evaluate(() => document.cookie)).not.toContain("parent_scope");
    expect((await member.cookies(sibling.web)).find((cookie) => cookie.name === cookieName)?.value).toBe(siblingCookie.value);

    const crossOriginRead = await primary.evaluate(async (target) => {
      try { const response = await fetch(`${target}/data`, { credentials: "include" }); return { readable: response.ok, status: response.status }; }
      catch { return { readable: false, status: null }; }
    }, sibling.web);
    expect(crossOriginRead.readable).toBe(false);
    const appAPI = await (await member.request.get(`${sibling.web}/api/companies`)).json();
    expect(appAPI).toMatchObject({ application: "Sibling app", endpoint: "web" });
    expect(appAPI.cookie).toBe("app_scope=sibling");

    for (const endpoint of [foreign.apiPath, `${foreign.apiPath}/logs`, `${foreign.apiPath}/shares`]) {
      expect((await member.request.get(`${baseURL}${endpoint}`)).status()).toBe(403);
    }
    await foreignPage.goto(foreign.web);
    await expect(foreignPage.getByRole("heading", { name: "Preview access required", exact: true })).toBeVisible();
    await foreignPage.screenshot({ path: testInfo.outputPath("other-company-denied-mobile.png"), fullPage: true });
    // The owner's successful visit proves this is a live app denied by the
    // member's company boundary, not an unavailable endpoint.
    const ownerPreview = await owner.context().newPage();
    try {
      await ownerPreview.goto(foreign.web);
      await expect(ownerPreview.getByRole("heading", { name: "Other company app", exact: true })).toBeVisible();
    } finally { await ownerPreview.close(); }
    const current = await foreign.read();
    expect((await owner.request.post(`${foreign.apiPath}/control`, { headers,
      data: { requestId: randomUUID(), expectedRevision: current.revision, action: "stop" } })).status()).toBe(202);
    await expect.poll(async () => (await foreign.read()).state, { timeout: 20_000 }).toBe("stopped");
    await foreignPage.goto(foreign.web);
    await expect(foreignPage.getByRole("heading", { name: "Preview access required", exact: true })).toBeVisible();
    expect(await foreign.read()).toMatchObject({ state: "stopped", desiredState: "stopped" });
    await siblingPage.screenshot({ path: testInfo.outputPath("sibling-app-mobile.png"), fullPage: true });
    return { distinctOrigins: 4, credentialReplayDenied: true, endpointCredentialReplayDenied: true,
      previewCookieCannotAuthorizeBoard: true, crossOriginActivityDenied: true, appStorageIsolated: true,
      reservedCookieOverwriteDenied: true, crossOriginReadDenied: true, foreignCompanyDenied: true,
      unauthorizedVisitCannotWake: true, siblingServiceId: sibling.id, foreignServiceId: foreign.id };
  } finally { await replay.close(); await siblingPage.close(); await foreignPage.close(); }
}
