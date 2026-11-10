import assert from "node:assert/strict";
import { chromium, expect } from "@playwright/test";
import path from "node:path";

/** The actual built board UI, real APIs and ordinary browser navigation. No
 * route stubs, response injection, request retries or fabricated UI state. */
export async function openRollingDeploymentBrowser(input: { origin: string; root: string; taskTitle: string; taskPath: string; omittedAssets: string[] }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const sockets: { openedAt: number; closedAt?: number; firstFrameAt?: number }[] = [];
  const errors: string[] = [];
  const assets: string[] = [];
  const metrics: { reconnectMs?: number; oldChunkLoaded: boolean; pageErrors: number } = { oldChunkLoaded: false, pageErrors: 0 };
  page.on("pageerror", error => errors.push(error.message));
  page.on("response", response => { if (response.url().includes("/assets/") && response.ok()) assets.push(response.url()); });
  page.on("websocket", socket => {
    if (!socket.url().includes("/events/ws")) return;
    const record = { openedAt: Date.now() } as typeof sockets[number]; sockets.push(record);
    socket.on("framereceived", () => { record.firstFrameAt ??= Date.now(); });
    socket.on("close", () => { record.closedAt = Date.now(); });
  });
  try {
    await page.goto(`${input.origin}${input.taskPath}`);
    await expect(page.getByRole("heading", { name: input.taskTitle, exact: true }).first()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => sockets.some(socket => socket.firstFrameAt !== undefined), { timeout: 15_000 }).toBe(true);
    assert.equal(assets.some(url => input.omittedAssets.some(asset => url.endsWith(asset))), false, "Old lazy chunk must not have loaded before deployment");
    await page.screenshot({ path: path.join(input.root, "browser-before.png") });
    return {
      metrics,
      async verifyReplacement() {
        try {
        await expect.poll(() => sockets.length, { timeout: 5_000 }).toBeGreaterThan(1);
        await expect.poll(() => sockets.at(-1)?.firstFrameAt !== undefined, { timeout: 5_000 }).toBe(true);
        const closedAt = sockets.find(socket => socket.closedAt !== undefined)?.closedAt;
        assert.ok(closedAt);
        const reconnected = sockets.find(socket => socket.openedAt >= closedAt && socket.firstFrameAt);
        assert.ok(reconnected);
        const reconnectMs = reconnected.firstFrameAt! - closedAt;
        metrics.reconnectMs = reconnectMs;
        assert.ok(reconnectMs <= 5_000, `Browser reconnected after ${reconnectMs}ms`);
        // Use the existing tab's router so its original build requests the
        // previously unopened page's chunk from B after A has been removed.
        const activity = page.getByRole("link", { name: /^(Audit|Activity)$/ }).first();
        await activity.click();
        await expect.poll(() => assets.some(url => input.omittedAssets.some(asset => url.endsWith(asset))), { timeout: 15_000 }).toBe(true);
        await expect(page.getByRole("heading", { name: /^(Audit|Activity)$/ }).first()).toBeVisible({ timeout: 15_000 });
        metrics.oldChunkLoaded = true;
        metrics.pageErrors = errors.length;
        assert.deepEqual(errors, []);
        await page.screenshot({ path: path.join(input.root, "browser-after.png") });
        return metrics;
        } catch (error) {
          await page.screenshot({ path: path.join(input.root, "browser-failure.png") }).catch(() => undefined);
          throw error;
        }
      },
      close: () => browser.close(),
    };
  } catch (error) {
    await page.screenshot({ path: path.join(input.root, "browser-failure.png") }).catch(() => undefined);
    await browser.close(); throw error;
  }
}
