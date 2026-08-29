// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppBrandManifestCacheForTests } from "@/lib/app-brand-assets";
import { AppLogo } from "./AppLogo";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

describe("AppLogo local brand assets", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    resetAppBrandManifestCacheForTests();
  });

  afterEach(() => {
    act(() => root?.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("loads the manifest and renders its light and dark provider assets", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        providers: [{
          slug: "github",
          provider: "GitHub",
          localAsset: "/brands/apps/github.svg",
          darkAsset: "/brands/apps/github-dark.svg",
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    root = createRoot(container);

    await act(async () => {
      root.render(<AppLogo name="GitHub" logoUrl="https://remote.example/github.svg" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(fetchMock).toHaveBeenCalledWith("/brands/apps/manifest.json", { credentials: "same-origin" });
    const images = Array.from(container.querySelectorAll("img"));
    expect(images.map((image) => image.getAttribute("src"))).toEqual([
      "/brands/apps/github.svg",
      "/brands/apps/github-dark.svg",
    ]);
    expect(images[0]?.className).toContain("dark:hidden");
    expect(images[1]?.className).toContain("dark:block");
  });

  it.each([
    { failedIndex: 0, survivingAsset: "/brands/apps/github-dark.svg", survivingClass: "dark:block", fallbackClass: "dark:hidden" },
    { failedIndex: 1, survivingAsset: "/brands/apps/github.svg", survivingClass: "dark:hidden", fallbackClass: "dark:flex" },
  ])("keeps the valid theme asset when image $failedIndex fails", async ({
    failedIndex,
    survivingAsset,
    survivingClass,
    fallbackClass,
  }) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        providers: [{
          slug: "github",
          provider: "GitHub",
          localAsset: "/brands/apps/github.svg",
          darkAsset: "/brands/apps/github-dark.svg",
        }],
      }),
    }));
    root = createRoot(container);

    await act(async () => {
      root.render(<AppLogo name="GitHub" />);
      await Promise.resolve();
      await Promise.resolve();
    });
    const failedImage = container.querySelectorAll("img")[failedIndex];
    expect(failedImage).toBeTruthy();

    await act(async () => {
      failedImage!.dispatchEvent(new Event("error", { bubbles: true }));
    });

    const remainingImages = Array.from(container.querySelectorAll("img"));
    expect(remainingImages).toHaveLength(1);
    expect(remainingImages[0]?.getAttribute("src")).toBe(survivingAsset);
    expect(remainingImages[0]?.className).toContain(survivingClass);
    const fallback = container.querySelector("span > span");
    expect(fallback?.textContent).toBe("G");
    expect(fallback?.className).toContain(fallbackClass);
  });

  it("does not request a remote logo while the local manifest lookup is pending", async () => {
    let resolveResponse!: (value: {
      ok: boolean;
      json: () => Promise<unknown>;
    }) => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise((resolve) => {
      resolveResponse = resolve;
    })));
    root = createRoot(container);

    act(() => {
      root.render(<AppLogo name="GitHub" logoUrl="https://remote.example/github.svg" />);
    });

    expect(container.querySelector("img")).toBeNull();

    await act(async () => {
      resolveResponse({
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          providers: [{
            slug: "github",
            provider: "GitHub",
            localAsset: "/brands/apps/github.svg",
          }],
        }),
      });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("img")?.getAttribute("src")).toBe("/brands/apps/github.svg");
  });

  it("uses a stable provider key for owner-qualified display names", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        providers: [{
          slug: "github",
          provider: "GitHub",
          localAsset: "/brands/apps/github.svg",
        }],
      }),
    }));
    root = createRoot(container);

    await act(async () => {
      root.render(
        <AppLogo
          name="Dotta's GitHub"
          brandKey="github"
          logoUrl="https://remote.example/github.svg"
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("img")?.getAttribute("src")).toBe("/brands/apps/github.svg");
  });

  it("does not expose a remote logo before a stable provider key arrives", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        schemaVersion: 1,
        providers: [{
          slug: "github",
          provider: "GitHub",
          localAsset: "/brands/apps/github.svg",
        }],
      }),
    }));
    root = createRoot(container);

    await act(async () => {
      root.render(
        <AppLogo
          name="Dotta's source control"
          logoUrl="https://remote.example/github.svg"
          allowRemoteFallback={false}
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("img")).toBeNull();

    await act(async () => {
      root.render(
        <AppLogo
          name="Dotta's source control"
          brandKey="github"
          logoUrl="https://remote.example/github.svg"
          allowRemoteFallback
        />,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("img")?.getAttribute("src")).toBe("/brands/apps/github.svg");
  });

  it("keeps the caller logo when the manifest has no matching provider", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ schemaVersion: 1, providers: [] }),
    }));
    root = createRoot(container);

    await act(async () => {
      root.render(<AppLogo name="Custom MCP" logoUrl="https://remote.example/custom.svg" />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.querySelector("img")?.getAttribute("src")).toBe("https://remote.example/custom.svg");
  });
});
