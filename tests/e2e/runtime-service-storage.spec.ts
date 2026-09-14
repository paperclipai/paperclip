import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { test as base, expect } from "@playwright/test";
import type { RuntimeService, RuntimeServiceStorageView } from "../../packages/shared/src/runtime-services";

const test = base.extend<{ track: (cwd: string, servicePath?: string) => void }>({
  track: [async ({ request }, use) => {
    let directory: string | undefined; const services = new Set<string>();
    await use((cwd, servicePath) => { directory = cwd; if (servicePath) services.add(servicePath); });
    const results = await Promise.allSettled([...services].map(async (servicePath) => {
      const current: RuntimeService = await (await request.get(servicePath)).json();
      if (current.state === "stopped") return;
      expect((await request.post(`${servicePath}/control`, { data: { requestId: randomUUID(), expectedRevision: current.revision, action: "stop" } })).status()).toBe(202);
      await expect.poll(async () => (await (await request.get(servicePath)).json()).state, { timeout: 20_000 }).toBe("stopped");
    }));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map((result) => result.reason), "Storage fixture cleanup failed");
    if (directory) await fs.rm(directory, { recursive: true, force: true });
  }, { timeout: 45_000 }],
});

test("shared workspace storage: real files, response loss, mobile feedback and stopped-service measurement", async ({ page, track }, testInfo) => {
  test.setTimeout(120_000);
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-service-storage-ui-")); track(cwd);
  await fs.mkdir(path.join(cwd, "node_modules")); await fs.mkdir(path.join(cwd, ".git"));
  await fs.writeFile(path.join(cwd, "node_modules/dependency.bin"), Buffer.alloc(2 * 1024 * 1024, 1));
  await fs.writeFile(path.join(cwd, ".git/dirty-note"), "Uncommitted source survives Stop");
  await fs.writeFile(path.join(cwd, "server.cjs"), "require('node:http').createServer((req,res)=>res.end('Storage app')).listen(Number(process.env.PORT),'127.0.0.1');");
  const company = await (await page.request.post("/api/companies", { data: { name: "Workspace storage acceptance" } })).json();
  async function create(name: string, start: boolean) {
    const response = await page.request.post(`/api/companies/${company.id}/runtime-services`, { data: {
      requestId: randomUUID(), name, cwd, command: "node server.cjs", start, endpoints: [{ name: "web" }],
    } });
    expect(response.status()).toBe(202);
    const service: RuntimeService = await response.json(), apiPath = `/api/companies/${company.id}/runtime-services/${service.id}`;
    track(cwd, apiPath); return { service, apiPath };
  }
  const app = await create("Storage app", true), sibling = await create("Shared worker", false);
  expect(sibling.service.allocationId).toBe(app.service.allocationId);
  const read = async (): Promise<RuntimeService> => (await page.request.get(app.apiPath)).json();
  const storage = async (): Promise<RuntimeServiceStorageView> => (await page.request.get(`${app.apiPath}/storage`)).json();
  await expect.poll(async () => (await read()).state, { timeout: 40_000 }).toBe("ready");
  const running = await read();
  expect(await (await fetch(`http://127.0.0.1:${running.endpoints[0]!.port}`)).text()).toBe("Storage app");
  await page.setViewportSize({ width: 390, height: 760 }); await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(`/${company.issuePrefix}/runtime-services/${app.service.id}`);
  const panel = page.getByRole("region", { name: "Workspace storage", exact: true });
  await expect(panel.getByRole("link", { name: "Shared worker", exact: true })).toBeVisible();
  let release!: () => void, accepted!: () => void, calls = 0;
  const gate = new Promise<void>((resolve) => { release = resolve; }), acceptedRequest = new Promise<void>((resolve) => { accepted = resolve; });
  await page.route(`**${app.apiPath}/storage/refresh`, async (route) => {
    const response = await route.fetch(); calls++;
    if (calls === 1) { expect(response.status()).toBe(200); accepted(); await gate; await route.abort("failed"); }
    else await route.fulfill({ response });
  });
  try {
    await panel.getByRole("button", { name: "Check storage", exact: true }).click(); await acceptedRequest;
    await expect(panel.getByRole("button", { name: "Checking storage…", exact: true })).toBeDisabled();
    await page.keyboard.press("Enter"); expect(calls).toBe(1);
    await panel.screenshot({ path: testInfo.outputPath("storage-pending-mobile.png") });
  } finally { release(); }
  await expect(panel.getByRole("button", { name: "Check storage", exact: true })).toBeEnabled();
  await expect(panel.getByRole("alert")).toHaveCount(0);
  const first = await storage(); expect(first.usage.status).toBe("ready"); expect(first.usage.bytes!).toBeGreaterThanOrEqual(2 * 1024 * 1024);
  expect(first.serviceCount).toBe(2);
  await fs.writeFile(path.join(cwd, "application-data.bin"), Buffer.alloc(2 * 1024 * 1024, 2));
  await delay(2100);
  await panel.getByRole("button", { name: "Check storage", exact: true }).click();
  await expect.poll(async () => (await storage()).usage.bytes).toBeGreaterThan(first.usage.bytes!);
  const larger = await storage();
  expect(larger.usage.bytes! - first.usage.bytes!).toBeGreaterThanOrEqual(2 * 1024 * 1024);
  expect((await read()).lastActivityAt).toBe(running.lastActivityAt);
  expect((await read()).startedAt).toBe(running.startedAt);
  const shared: RuntimeServiceStorageView = await (await page.request.get(`${sibling.apiPath}/storage`)).json();
  expect(shared.usage).toEqual(larger.usage);
  await page.getByRole("region", { name: "Storage app service", exact: true }).getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(async () => (await read()).state, { timeout: 20_000 }).toBe("stopped");
  await delay(2100); await panel.getByRole("button", { name: "Check storage", exact: true }).click();
  await expect.poll(async () => (await storage()).usage.checkedAt).not.toBe(larger.usage.checkedAt);
  expect((await read()).state).toBe("stopped");
  expect(await fs.readFile(path.join(cwd, ".git/dirty-note"), "utf8")).toBe("Uncommitted source survives Stop");
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await panel.screenshot({ path: testInfo.outputPath("storage-stopped-mobile.png") });
  const proof = { serviceId: app.service.id, allocationId: app.service.allocationId, serviceCount: 2,
    firstBytes: first.usage.bytes, largerBytes: larger.usage.bytes, sharedMeasurement: true,
    lostResponseRecovered: true, repeatedSubmissionPrevented: true, measurementDoesNotRenewActivity: true,
    stoppedServiceRemainsStopped: true, dirtySourceRetained: true, final: (await storage()).usage };
  const file = testInfo.outputPath("storage-acceptance.json"); await fs.writeFile(file, JSON.stringify(proof, null, 2));
  await testInfo.attach("storage-acceptance", { path: file, contentType: "application/json" });
});
