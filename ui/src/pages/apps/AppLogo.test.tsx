// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppBrandManifestCacheForTests } from "@/lib/app-brand-assets";
import { AppLogo } from "./AppLogo";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("AppLogo", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    resetAppBrandManifestCacheForTests();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ schemaVersion: 1, providers: [] }),
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders decorative local light and dark provider marks", async () => {
    await act(async () => {
      root.render(
        <AppLogo
          name="Notion"
          logoUrl="/brands/apps/notion.svg"
          darkLogoUrl="/brands/apps/notion-dark.svg"
          size={36}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    const images = Array.from(container.querySelectorAll("img"));
    expect(images).toHaveLength(2);
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "/brands/apps/notion.svg",
      "/brands/apps/notion-dark.svg",
    ]);
    expect(images.every((image) => image.alt === "")).toBe(true);
    expect(images[0]?.className).toContain("dark:hidden");
    expect(images[1]?.className).toContain("dark:block");
  });

  it("uses the deterministic letter tile only after a runtime image failure", async () => {
    await act(async () => {
      root.render(<AppLogo name="Jira" logoUrl="/brands/apps/missing.svg" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const image = container.querySelector("img");
    expect(image).toBeTruthy();

    act(() => image?.dispatchEvent(new Event("error")));

    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toBe("J");
  });
});
