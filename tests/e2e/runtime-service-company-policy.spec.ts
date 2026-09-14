import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { RuntimeService, RuntimeServiceCompanyPolicy } from "../../packages/shared/src/runtime-services";

test("company policy: safe retry, capacity feedback, retained files and a live hard deadline", async ({ page, context }, testInfo) => {
  test.setTimeout(180_000);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-company-policy-ui-"));
  await fs.writeFile(path.join(cwd, "content.txt"), "Company policy preview");
  await fs.writeFile(path.join(cwd, "server.cjs"), `const fs=require('node:fs');require('node:http').createServer((q,s)=>s.end(fs.readFileSync('content.txt'))).listen(Number(process.env.PORT),'127.0.0.1');`);
  let companyId: string | undefined;
  const renderErrors: string[] = [];
  page.on("pageerror", (error) => renderErrors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error" && message.text().includes("same key")) renderErrors.push(message.text()); });
  const services: string[] = [];
  try {
    const companyResponse = await page.request.post("/api/companies", { data: { name: "Company service policy acceptance" } });
    expect(companyResponse.ok()).toBe(true);
    const company = await companyResponse.json(); companyId = company.id;
    const policyPath = `/api/companies/${company.id}/runtime-service-policy`;
    const servicesPath = `/api/companies/${company.id}/runtime-services`;
    const inventory = `/${company.issuePrefix}/runtime-services`;
    const readPolicy = async (): Promise<RuntimeServiceCompanyPolicy> => (await page.request.get(policyPath)).json();
    const read = async (id: string): Promise<RuntimeService> => (await page.request.get(`${servicesPath}/${id}`)).json();
    await page.goto(inventory);
    await page.getByRole("button", { name: "Company defaults and limits", exact: true }).click();
    const policyForm = page.getByRole("form", { name: "Company defaults and limits", exact: true });
    await policyForm.getByLabel("Preview idle minutes", { exact: true }).fill("2");
    await policyForm.getByLabel("Running service limit", { exact: true }).fill("1");
    await policyForm.getByLabel("Retained allocation limit", { exact: true }).fill("1");
    const policyRequests: unknown[] = [];
    await page.route(`**${policyPath}`, async (route) => {
      if (route.request().method() !== "PATCH") return route.continue();
      policyRequests.push(route.request().postDataJSON());
      if (policyRequests.length === 1) {
        const accepted = await route.fetch(); expect(accepted.status()).toBe(200);
        await route.abort("failed");
      } else await route.continue();
    });
    await policyForm.getByRole("button", { name: "Save company policy", exact: true }).click();
    await expect(policyForm.getByRole("alert")).toContainText("Could not confirm the save");
    await expect(policyForm.getByLabel("Preview idle minutes", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Close company policy", exact: true })).toBeDisabled();
    await policyForm.getByRole("button", { name: "Retry same company policy request" }).click();
    await expect(policyForm.getByRole("status")).toHaveText("Company policy saved.");
    expect(policyRequests).toHaveLength(2);
    expect(policyRequests[1]).toEqual(policyRequests[0]);
    expect((await readPolicy()).revision).toBe(1);
    await page.unroute(`**${policyPath}`);
    await page.screenshot({ path: testInfo.outputPath("company-policy-desktop.png"), fullPage: true });

    async function fillService(name: string, folder = cwd) {
      await page.getByRole("button", { name: "New service", exact: true }).click();
      const form = page.getByRole("form", { name: "Create service" });
      await form.getByLabel("Name", { exact: true }).fill(name);
      await form.getByLabel("Start command").fill("node server.cjs");
      await form.getByLabel("Working folder").fill(folder);
      await form.getByRole("button", { name: "Create and start", exact: true }).click();
      return form;
    }
    await fillService("First capped preview");
    await expect(page).toHaveURL(new RegExp(`${inventory}/[a-f0-9-]+$`));
    const firstId = page.url().split("/").at(-1)!; services.push(firstId);
    await expect.poll(async () => (await read(firstId)).state, { timeout: 30_000 }).toBe("ready");
    expect((await read(firstId)).policy.idleSeconds).toBe(120);
    await page.goto(inventory);
    const secondForm = await fillService("Second capped preview");
    await expect(secondForm.getByRole("alert")).toContainText("Company running-service limit reached (1)");
    expect((await readPolicy()).usage).toEqual({ runningServices: 1, serviceAllocations: 1 });
    await page.getByRole("region", { name: "First capped preview service" }).getByRole("button", { name: "Stop", exact: true }).click();
    await expect.poll(async () => (await read(firstId)).state).toBe("stopped");
    await fs.writeFile(path.join(cwd, "content.txt"), "Retained after releasing a running slot");
    await secondForm.getByRole("button", { name: "Retry creation", exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${inventory}/[a-f0-9-]+$`));
    const secondId = page.url().split("/").at(-1)!; services.push(secondId);
    await expect.poll(async () => (await read(secondId)).state, { timeout: 30_000 }).toBe("ready");
    const second = await read(secondId);
    expect(second.allocationId).toBe((await read(firstId)).allocationId);
    expect((await readPolicy()).usage).toEqual({ runningServices: 1, serviceAllocations: 1 });
    const directUrl = `http://127.0.0.1:${second.endpoints[0]!.port}`;
    const preview = await context.newPage(); await preview.goto(directUrl);
    await expect(preview.locator("body")).toContainText("Retained after releasing a running slot");
    await page.bringToFront();
    await expect(page.getByRole("region", { name: "Second capped preview service" }).getByRole("status")).toHaveText("Running");
    await page.getByRole("button", { name: "Edit lifetime", exact: true }).click();
    await page.getByLabel("Maximum running minutes", { exact: true }).fill("10");
    await page.getByLabel("Keep running until", { exact: true }).fill(await page.evaluate(() => {
      const time = new Date(Date.now() + 3600_000); return new Date(time.getTime() - time.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
    }));
    await page.getByRole("button", { name: "Save lifetime", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Lifetime saved" })).toBeVisible();
    await page.goto(inventory);
    await page.setViewportSize({ width: 390, height: 760 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByRole("button", { name: "Company defaults and limits", exact: true }).focus();
    await page.keyboard.press("Enter");
    const beforeConcurrentEdit = await readPolicy();
    expect((await page.request.patch(policyPath, { data: { requestId: randomUUID(), expectedRevision: beforeConcurrentEdit.revision, config: { previewIdleSeconds: 240 } } })).status()).toBe(200);
    await expect(policyForm.getByRole("alert")).toContainText("Company policy changed while you were editing");
    await expect(policyForm.getByLabel("Preview idle minutes", { exact: true })).toHaveValue("2");
    await expect(policyForm.getByRole("button", { name: "Save company policy", exact: true })).toBeDisabled();
    await policyForm.getByRole("button", { name: "Load current company policy" }).click();
    await expect(policyForm.getByLabel("Preview idle minutes", { exact: true })).toHaveValue("4");
    await policyForm.getByLabel("Company maximum running minutes", { exact: true }).fill("0.5");
    await policyForm.getByLabel("Preview idle minutes", { exact: true }).fill("5");
    await policyForm.getByRole("button", { name: "Save company policy", exact: true }).focus();
    await page.keyboard.press("Enter");
    await expect(policyForm.getByRole("status")).toHaveText("Company policy saved.");
    expect((await read(secondId)).policy.idleSeconds).toBe(120);
    expect((await read(secondId)).effectivePolicy?.maxRunningSeconds).toBe(30);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("company-policy-mobile.png"), fullPage: true });
    await page.screenshot({ path: testInfo.outputPath("company-policy-mobile-viewport.png") });
    await page.goto(`${inventory}/${secondId}`);
    const card = page.getByRole("region", { name: "Second capped preview service" });
    await expect(card).toContainText("Maximum 30 seconds per start, including active use. Set by company policy.");
    // This local fixture has no hosted gateway. Real authorized activity pings
    // exercise its company deadline while a browser displays the HTTP service.
    let activeSignals = 0;
    await expect.poll(async () => {
      const response = await page.request.post(`${servicesPath}/${secondId}/activity`, { data: { visible: true } });
      expect(response.status()).toBe(204); activeSignals++;
      return (await read(secondId)).state;
    }, { timeout: 40_000, intervals: [1000] }).toBe("stopped");
    expect(activeSignals).toBeGreaterThan(1);
    const stopped = await read(secondId);
    expect(stopped.stopReason).toBe("company_maximum_lifetime");
    await expect(card).toContainText("Stopped after reaching the company maximum running time");
    await expect(fetch(directUrl)).rejects.toThrow();
    expect(await fs.readFile(path.join(cwd, "content.txt"), "utf8")).toBe("Retained after releasing a running slot");
    expect((await readPolicy()).usage).toEqual({ runningServices: 0, serviceAllocations: 1 });
    await page.screenshot({ path: testInfo.outputPath("company-deadline-stopped.png"), fullPage: true });
    await preview.close();

    await page.goto(inventory);
    const differentFolder = path.join(cwd, "another-app"); await fs.mkdir(differentFolder);
    const blocked = await fillService("Another allocation", differentFolder);
    await expect(blocked.getByRole("alert")).toContainText("Company retained-allocation limit reached (1)");
    expect((await readPolicy()).usage.serviceAllocations).toBe(1);
    expect(renderErrors).toEqual([]);
    const proofPath = testInfo.outputPath("company-policy-proof.json");
    await fs.writeFile(proofPath, JSON.stringify({ policy: await readPolicy(), firstId, secondId, acceptedPolicyRequest: policyRequests[0], sameRequestRetried: true, activeSignals, stopped }, null, 2));
    await testInfo.attach("company-policy-proof", { path: proofPath, contentType: "application/json" });
  } finally {
    if (companyId) for (const id of services) {
      const url = `/api/companies/${companyId}/runtime-services/${id}`;
      const service: RuntimeService = await (await page.request.get(url)).json();
      if (service.state !== "stopped") {
        await page.request.post(`${url}/control`, { data: { action: "stop", requestId: randomUUID(), expectedRevision: service.revision } });
        await expect.poll(async () => (await (await page.request.get(url)).json()).state, { timeout: 20_000 }).toBe("stopped");
      }
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
