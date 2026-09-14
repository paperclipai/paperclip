import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { test as base, expect } from "@playwright/test";
import type { RuntimeService } from "@paperclipai/shared";

const test = base.extend<{ trackService: (cwd: string, apiPath?: string) => void }>({
  trackService: [async ({ request }, use) => {
    let cwd: string | undefined;
    let apiPath: string | undefined;
    await use((workspace, servicePath) => { cwd = workspace; apiPath = servicePath; });
    if (apiPath) {
      const read = async (): Promise<RuntimeService> => {
        const response = await request.get(apiPath!); expect(response.ok()).toBe(true); return response.json();
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

test("operator binds service credentials, recovers a lost save, rotates and diagnoses unavailable credentials", async ({ page, trackService }, testInfo) => {
  test.setTimeout(180_000);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-credential-ui-")); trackService(cwd);
  await fs.writeFile(path.join(cwd, "server.cjs"), `const value=process.env.APP_SECRET||'missing'; console.log('Credential '+value); require('node:http').createServer((q,s)=>s.end(require('node:crypto').createHash('sha256').update(value).digest('hex'))).listen(Number(process.env.PORT),'127.0.0.1');`);
  const company = await (await page.request.post("/api/companies", { data: { name: "Service credential acceptance" } })).json();
  const original = `synthetic-service-secret-${randomUUID()}`;
  const rotated = `synthetic-rotated-secret-${randomUUID()}`;
  const secretResponse = await page.request.post(`/api/companies/${company.id}/secrets`, { data: { name: "Application credential", value: original, provider: "local_encrypted" } });
  expect(secretResponse.ok()).toBe(true); const secret = await secretResponse.json();
  const create = await page.request.post(`/api/companies/${company.id}/runtime-services`, { data: {
    requestId: randomUUID(), name: "App with credentials", cwd, command: "node server.cjs", endpoints: [{ name: "web" }], start: false,
  } });
  expect(create.status()).toBe(202); const created: RuntimeService = await create.json();
  const servicePath = `/api/companies/${company.id}/runtime-services/${created.id}`; trackService(cwd, servicePath);
  const read = async (): Promise<RuntimeService> => (await page.request.get(servicePath)).json();
  const proof = async () => (await fetch(`http://127.0.0.1:${(await read()).endpoints[0]!.port}`)).text();
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  await page.goto(`/${company.issuePrefix}/runtime-services/${created.id}`);
  const card = page.getByRole("region", { name: "App with credentials service" });
  await page.getByRole("button", { name: "Configure environment" }).click();
  const env = page.getByRole("region", { name: "Service environment" });
  await env.getByRole("button", { name: "Add variable" }).click();
  await env.getByLabel("Variable name").fill("APP_SECRET");
  await env.getByLabel("Value source").click();
  await expect(page.getByRole("menuitem", { name: /^User secret/ })).toHaveCount(0);
  await page.getByRole("menuitem", { name: /^Organization secret/ }).click();
  await page.keyboard.press("Escape");
  await env.getByRole("button", { name: "Save environment" }).click();
  await expect(env.getByRole("alert")).toContainText("choose an organization secret");
  await env.getByRole("combobox").click();
  await page.getByRole("option", { name: /Application credential/ }).click();
  const saves: unknown[] = [];
  await page.route(`**${servicePath}/environment`, async (route) => {
    if (route.request().method() !== "PATCH") { await route.continue(); return; }
    saves.push(route.request().postDataJSON());
    if (saves.length === 1) { const response = await route.fetch(); expect(response.ok()).toBe(true); await route.abort("failed"); }
    else await route.continue();
  });
  await env.getByRole("button", { name: "Save environment" }).click();
  await expect(env).toContainText("Could not confirm the save");
  await expect(env.getByLabel("Variable name")).toBeDisabled();
  await expect(env.getByRole("button", { name: "Close environment" })).toBeDisabled();
  await env.getByRole("button", { name: "Retry same request" }).click();
  await expect(env.getByRole("status")).toContainText("Environment saved");
  expect(saves).toHaveLength(2); expect(saves[1]).toEqual(saves[0]);
  expect(JSON.stringify(saves)).not.toContain(original);
  expect(await (await page.request.get(`${servicePath}/environment`)).json()).toMatchObject({ env: { APP_SECRET: { type: "secret_ref", secretId: secret.id, version: "latest" } } });
  await page.screenshot({ path: testInfo.outputPath("service-environment.png"), fullPage: true });
  await testInfo.attach("Service credential binding", { path: testInfo.outputPath("service-environment.png"), contentType: "image/png" });
  await card.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => (await read()).state, { timeout: 40_000 }).toBe("ready");
  expect(await proof()).toBe(digest(original));
  await expect(env.getByRole("button", { name: "Save environment" })).toBeDisabled();
  await expect(env).toContainText("Stop the service before changing its environment");
  await card.getByRole("button", { name: "Logs", exact: true }).click();
  await expect(card.getByLabel("App with credentials logs")).toContainText("Credential [REDACTED]");
  await expect(card.getByLabel("App with credentials logs")).not.toContainText(original);
  expect((await page.request.post(`/api/secrets/${secret.id}/rotate`, { data: { value: rotated } })).ok()).toBe(true);
  expect(await proof()).toBe(digest(original));
  await card.getByRole("button", { name: "Restart", exact: true }).click();
  await expect.poll(async () => { try { return await proof(); } catch { return "restarting"; } }, { timeout: 40_000 }).toBe(digest(rotated));
  // The app can answer before the controller publishes its ready revision.
  // Wait for the user-visible restart to finish before issuing another action.
  await expect(card.getByRole("status")).toHaveText("Running");
  expect((await page.request.patch(`/api/secrets/${secret.id}`, { data: { status: "disabled" } })).ok()).toBe(true);
  await card.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(async () => (await read()).state, { timeout: 20_000 }).toBe("stopped");
  await expect(card.getByRole("status")).toHaveText("Stopped");
  await card.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => (await read()).state, { timeout: 30_000 }).toBe("failed");
  await expect(card.getByRole("alert")).toContainText("launch credentials are unavailable");
  await expect(card.getByLabel("App with credentials logs")).not.toContainText(rotated);
  // A failed launch still owns its compute intent. Stop must remain available
  // even when the credential cannot be resolved to start another process.
  await card.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Stopped");
  expect(await read()).toMatchObject({ state: "stopped", desiredState: "stopped" });
  expect((await page.request.patch(`/api/secrets/${secret.id}`, { data: { status: "active" } })).ok()).toBe(true);
  await card.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => (await read()).state, { timeout: 30_000 }).toBe("ready");
  expect(await proof()).toBe(digest(rotated));
  await expect(card.getByRole("alert")).toHaveCount(0);
});
