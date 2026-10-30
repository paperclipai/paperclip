import { describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { captureProductScreenshot } from "./product-screenshot.js";

describe("product screenshot boundary", () => {
  it("excludes a sign-in screen rendered at an unchanged task URL", async () => {
    const screenshot = vi.fn();
    const page = { url: () => "https://qa.example.test/QA/issues/QA-1", locator: () => ({ isVisible: async () => false, screenshot }) } as unknown as Page;
    await expect(captureProductScreenshot(page, "https://qa.example.test", "shot.png")).rejects.toThrow("product_screen_unavailable");
    expect(screenshot).not.toHaveBeenCalled();
  });
  it("captures only the signed-in product region and refuses other origins", async () => {
    const screenshot = vi.fn(), locator = vi.fn(() => ({ isVisible: async () => true, screenshot }));
    const page = { url: () => "https://qa.example.test/QA/issues/QA-1", locator } as unknown as Page;
    await captureProductScreenshot(page, "https://qa.example.test", "shot.png");
    expect(locator).toHaveBeenCalledWith("main#main-content"); expect(screenshot).toHaveBeenCalledTimes(1);
    await expect(captureProductScreenshot(page, "https://other.example.test", "shot.png")).rejects.toThrow("product_screen_unavailable");
    expect(screenshot).toHaveBeenCalledTimes(1);
  });
});
