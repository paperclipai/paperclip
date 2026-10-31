import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { captureProductScreenshot } from "./product-screenshot.js";

const origin = "https://qa.example.test";
afterEach(() => vi.restoreAllMocks());
function fixture(options: { mounted?: boolean; redirect?: string; afterMount?(): void } = {}) {
  let mounted = false, url = `${origin}/QA/issues/QA-1`;
  const screenshot = vi.fn(async (_input: { path: string; timeout: number }) => {});
  const waitFor = vi.fn(async (_input: { state: string; timeout: number }) => { mounted = options.mounted !== false; if (options.redirect) url = options.redirect; options.afterMount?.(); });
  const locator = vi.fn(() => ({ waitFor, isVisible: async () => mounted, screenshot }));
  const page = { url: () => url, locator } as unknown as Page;
  return { page, locator, waitFor, screenshot };
}
describe("product screenshot boundary", () => {
  it("waits for Layout to mount after the document navigation completes", async () => {
    const f = fixture();
    await captureProductScreenshot(f.page, origin, "shot.png");
    expect(f.locator).toHaveBeenCalledWith("main#main-content");
    expect(f.waitFor).toHaveBeenCalledWith({ state: "visible", timeout: expect.any(Number) });
    expect(f.screenshot).toHaveBeenCalledTimes(1);
    expect(f.waitFor.mock.invocationCallOrder[0]).toBeLessThan(f.screenshot.mock.invocationCallOrder[0]!);
  });
  it("excludes a sign-in screen rendered at an unchanged task URL", async () => {
    const f = fixture({ mounted: false });
    await expect(captureProductScreenshot(f.page, origin, "shot.png")).rejects.toThrow("product_screen_unavailable");
    expect(f.screenshot).not.toHaveBeenCalled();
  });
  it("rejects a product region that never mounts", async () => {
    const f = fixture(); f.waitFor.mockRejectedValueOnce(new Error("Timeout"));
    await expect(captureProductScreenshot(f.page, origin, "shot.png")).rejects.toThrow("product_screen_unavailable");
    expect(f.screenshot).not.toHaveBeenCalled();
  });
  it.each([`${origin}/login`, "https://other.example.test/QA/issues/QA-1"])("excludes a redirect during readiness to %s", async redirect => {
    const f = fixture({ redirect });
    await expect(captureProductScreenshot(f.page, origin, "shot.png")).rejects.toThrow("product_screen_unavailable");
    expect(f.screenshot).not.toHaveBeenCalled();
  });
  it("refuses another origin before waiting or taking a screenshot", async () => {
    const f = fixture();
    await expect(captureProductScreenshot(f.page, "https://other.example.test", "shot.png")).rejects.toThrow("product_screen_unavailable");
    expect(f.waitFor).not.toHaveBeenCalled(); expect(f.screenshot).not.toHaveBeenCalled();
  });
  it("bounds readiness and capture by the campaign deadline", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const f = fixture();
    await captureProductScreenshot(f.page, origin, "shot.png", 1050);
    for (const call of [f.waitFor.mock.calls[0], f.screenshot.mock.calls[0]]) {
      expect((call?.[0] as { timeout: number }).timeout).toBeGreaterThan(0);
      expect((call?.[0] as { timeout: number }).timeout).toBeLessThanOrEqual(50);
    }
  });
  it("does not capture after readiness consumes the remaining deadline", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000), f = fixture({ afterMount: () => { now.mockReturnValue(1050); } });
    await expect(captureProductScreenshot(f.page, origin, "shot.png", 1050)).rejects.toThrow("product_screen_unavailable");
    expect(f.screenshot).not.toHaveBeenCalled();
  });
  it("never disables a timeout when the campaign deadline has elapsed", async () => {
    const f = fixture();
    await expect(captureProductScreenshot(f.page, origin, "shot.png", Date.now())).rejects.toThrow("product_screen_unavailable");
    expect(f.waitFor).not.toHaveBeenCalled(); expect(f.screenshot).not.toHaveBeenCalled();
  });
});
