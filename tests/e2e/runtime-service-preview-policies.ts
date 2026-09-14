import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { expect, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import type { RuntimeService } from "../../packages/shared/src/runtime-services";

/** Production gateway, real CSP enforcement, real elapsed idle deadlines. */
export async function verifyRestrictivePreviewPolicies(input: {
  page: Page; context: BrowserContext; testInfo: TestInfo;
  trackService: (cwd: string, apiPath?: string) => void;
}) {
  const { page, context, trackService, testInfo } = input;
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-preview-policies-")); trackService(cwd);
  const nonce = "preview-acceptance-script";
  const examples = [
    { label: "Nonce-only app", policy: `default-src 'none'; script-src 'nonce-${nonce}'`, scriptAllowed: false },
    { label: "Connection-restricted app", policy: `default-src 'none'; script-src 'self' 'nonce-${nonce}'; connect-src 'none'`, scriptAllowed: true },
  ];
  const select = (example: typeof examples[number]) => fs.writeFile(path.join(cwd, "policy.json"), JSON.stringify(example));
  await select(examples[0]!);
  await fs.writeFile(path.join(cwd, "app.cjs"), `const http=require('node:http'),fs=require('node:fs');
http.createServer((req,res)=>{const config=JSON.parse(fs.readFileSync('policy.json','utf8'));res.setHeader('Content-Type','text/html');res.setHeader('Content-Security-Policy',config.policy);res.end('<!doctype html><html><head><title>'+config.label+'</title></head><body><h1>'+config.label+'</h1><p>Application scripts still work.</p><script nonce="${nonce}">document.body.dataset.appScript="ran"</script></body></html>')}).listen(Number(process.env.PORT),'127.0.0.1');`);
  const company = await (await page.request.post("/api/companies", { data: { name: "Restrictive preview policy acceptance" } })).json();
  const created = await page.request.post(`/api/companies/${company.id}/runtime-services`, { data: {
    requestId: randomUUID(), name: "Restricted preview", cwd, command: "node app.cjs", endpoints: [{ name: "web" }], policy: { idleSeconds: 30 },
  } });
  expect(created.status()).toBe(202);
  const service: RuntimeService = await created.json(), apiPath = `/api/companies/${company.id}/runtime-services/${service.id}`;
  trackService(cwd, apiPath);
  const read = async (): Promise<RuntimeService> => (await page.request.get(apiPath)).json();
  await expect.poll(async () => (await read()).endpoints[0]?.status, { timeout: 40_000 }).toBe("ready");
  const url = (await read()).endpoints[0]!.url!, preview = await context.newPage();
  const violations: string[] = [], scriptResponses: number[] = [];
  preview.on("console", (message) => { if (/content security policy|connect-src|script-src/i.test(message.text())) violations.push(message.text()); });
  preview.on("response", (response) => { if (new URL(response.url()).pathname === "/.paperclip/visibility.js") scriptResponses.push(response.status()); });
  const observations: unknown[] = [];
  try {
    for (const example of examples) {
      await select(example); scriptResponses.length = 0; violations.length = 0;
      await preview.goto(`${url}/retained-route`);
      await expect(preview.getByRole("heading", { name: example.label, exact: true })).toBeVisible({ timeout: 30_000 });
      expect(await preview.locator("body").getAttribute("data-app-script")).toBe("ran");
      expect(await preview.evaluate(() => document.visibilityState)).toBe("visible");
      const response = await context.request.get(`${url}/policy-check`);
      expect(response.status()).toBe(200);
      expect(response.headers()["content-security-policy"]).toBe(example.policy);
      await expect.poll(() => violations.length).toBeGreaterThan(0);
      if (example.scriptAllowed) await expect.poll(() => scriptResponses).toContain(200);
      else expect(scriptResponses).toEqual([]);
      await page.setViewportSize({ width: 390, height: 760 });
      await page.goto(`/${company.issuePrefix}/runtime-services/${service.id}`);
      await expect(page.getByText("Waiting for browser activity. App security policies can prevent activity signals; use the lifetime controls if needed.", { exact: true })).toBeVisible();
      await expect(page.getByText("Sleeps after 30 seconds idle", { exact: true })).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${example.scriptAllowed ? "blocked-connect" : "blocked-script"}-mobile.png`), fullPage: true });
      const before = await read();
      await expect.poll(async () => {
        await context.request.get(`${url}/background-poll`);
        const current = await read();
        expect(current.lastActivityAt).toBe(before.lastActivityAt);
        expect(current.previewActivity?.lastSignalAt).toBeNull();
        return current.state;
      }, { timeout: 40_000, intervals: [1_000] }).toBe("sleeping");
      expect(await read()).toMatchObject({ stopReason: "idle", endpoints: [{ url }] });
      observations.push({ policy: example.policy, applicationScriptRan: true, visibility: "visible", visibilityScriptLoaded: scriptResponses.includes(200), violations: [...violations], sleptWithoutSignals: true });
    }

    // The documented escape hatch must be usable without changing the saved
    // 30-second idle policy, and it must actually keep the app alive.
    await page.getByRole("button", { name: "Edit lifetime", exact: true }).click();
    expect(await page.getByLabel("Sleep after idle minutes", { exact: true }).evaluate((input: HTMLInputElement) => input.checkValidity())).toBe(true);
    const until = new Date(Date.now() + 300_000);
    const localUntil = new Date(until.getTime() - until.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    await page.getByLabel("Keep running until", { exact: true }).fill(localUntil);
    await page.getByRole("button", { name: "Save lifetime", exact: true }).click();
    await expect(page.getByText("Lifetime saved.", { exact: true })).toBeVisible();
    expect((await read()).policy.idleSeconds).toBe(30);
    await preview.reload();
    await expect(preview.getByRole("heading", { name: examples[1]!.label, exact: true })).toBeVisible({ timeout: 30_000 });
    const held = await read(), deadline = Date.now() + 35_000;
    do {
      const current = await read();
      expect(current.state).toBe("ready");
      expect(current.lastActivityAt).toBe(held.lastActivityAt);
      expect(current.previewActivity?.lastSignalAt).toBeNull();
      await delay(1_000);
    } while (Date.now() < deadline);
    await page.screenshot({ path: testInfo.outputPath("explicit-hold-mobile.png"), fullPage: true });
    const proof = { serviceId: service.id, origin: url, observations, holdSavedThroughUI: true, holdPreservedIdleSeconds: 30, heldPastIdleSeconds: 35 };
    const proofPath = testInfo.outputPath("restrictive-policies.json");
    await fs.writeFile(proofPath, JSON.stringify(proof, null, 2));
    await testInfo.attach("restrictive-policies", { path: proofPath, contentType: "application/json" });
  } finally { await preview.close(); }
}
