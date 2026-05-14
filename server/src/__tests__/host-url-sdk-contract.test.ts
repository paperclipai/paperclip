import { describe, expect, it } from "vitest";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { createTestHarness } from "../../../packages/plugins/sdk/src/testing.js";
import type { ReachableUrlResult } from "../../../packages/plugins/sdk/src/types.js";

function manifest(capabilities: PaperclipPluginManifestV1["capabilities"]): PaperclipPluginManifestV1 {
  return {
    id: "paperclip.test-url-discovery",
    apiVersion: 1,
    version: "0.1.0",
    displayName: "Test URL Discovery",
    description: "Test plugin",
    author: "Paperclip",
    categories: ["automation"],
    capabilities,
    entrypoints: { worker: "./dist/worker.js" },
  };
}

describe("ctx.host.getReachableUrl SDK contract", () => {
  it("harness default returns loopback_bind null result", async () => {
    const harness = createTestHarness({ manifest: manifest(["host.urls.discover"]) });
    const result = await harness.ctx.host.getReachableUrl({ pathname: "/webhook" });
    expect(result).toEqual({ url: null, reason: "loopback_bind" });
  });

  it("harness accepts injected host service returning url", async () => {
    const harness = createTestHarness({
      manifest: manifest(["host.urls.discover"]),
      host: {
        async getReachableUrl({ pathname }) {
          return { url: `https://example.com${pathname}` };
        },
      },
    });
    const result = await harness.ctx.host.getReachableUrl({ pathname: "/webhook/github" });
    expect(result).toEqual({ url: "https://example.com/webhook/github" });
  });

  it("harness accepts injected host service returning no_public_base_url", async () => {
    const harness = createTestHarness({
      manifest: manifest(["host.urls.discover"]),
      host: {
        async getReachableUrl() {
          return { url: null, reason: "no_public_base_url" };
        },
      },
    });
    const result = await harness.ctx.host.getReachableUrl({ pathname: "/callback" });
    expect(result).toEqual({ url: null, reason: "no_public_base_url" });
  });

  it("result type discriminates correctly — url present means reason absent", async () => {
    const harness = createTestHarness({
      manifest: manifest(["host.urls.discover"]),
      host: {
        async getReachableUrl({ pathname }) {
          return { url: `https://example.com${pathname}` };
        },
      },
    });
    const result: ReachableUrlResult = await harness.ctx.host.getReachableUrl({ pathname: "/x" });
    if (result.url !== null) {
      expect(result.reason).toBeUndefined();
      expect(result.url).toContain("/x");
    }
  });
});
