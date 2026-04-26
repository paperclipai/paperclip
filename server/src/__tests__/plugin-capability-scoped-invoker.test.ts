import { describe, it, expect, vi } from "vitest";
import {
  createCapabilityScopedInvoker,
  PluginSandboxError,
} from "../services/plugin-runtime-sandbox.js";
import { pluginManifestValidator } from "../services/plugin-manifest-validator.js";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";
import { PLUGIN_API_VERSION } from "@paperclipai/shared";
import type { PaperclipPluginManifestV1 } from "@paperclipai/shared";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mv = pluginManifestValidator();
const cv = pluginCapabilityValidator();

function makeManifest(capabilities: string[]): PaperclipPluginManifestV1 {
  return mv.parseOrThrow({
    id: "test-plugin",
    apiVersion: PLUGIN_API_VERSION,
    version: "1.0.0",
    displayName: "Test",
    description: "test",
    author: "Acme",
    categories: ["connector"],
    capabilities,
    entrypoints: { worker: "dist/worker.js" },
  });
}

// ---------------------------------------------------------------------------
// PluginSandboxError
// ---------------------------------------------------------------------------

describe("PluginSandboxError", () => {
  it("is an instance of Error", () => {
    const err = new PluginSandboxError("oops");
    expect(err).toBeInstanceOf(Error);
  });

  it("has the correct name and message", () => {
    const err = new PluginSandboxError("sandbox violation");
    expect(err.name).toBe("PluginSandboxError");
    expect(err.message).toBe("sandbox violation");
  });
});

// ---------------------------------------------------------------------------
// createCapabilityScopedInvoker
// ---------------------------------------------------------------------------

describe("createCapabilityScopedInvoker", () => {
  it("invokes the function and returns its result when the capability check passes", async () => {
    const manifest = makeManifest(["issues.read"]);
    const invoker = createCapabilityScopedInvoker(manifest, cv);
    const result = await invoker.invoke("issues.list", () => Promise.resolve("ok"));
    expect(result).toBe("ok");
  });

  it("works with synchronous functions", async () => {
    const manifest = makeManifest(["issues.read"]);
    const invoker = createCapabilityScopedInvoker(manifest, cv);
    const result = await invoker.invoke("issues.list", () => 42);
    expect(result).toBe(42);
  });

  it("throws (403) when the plugin lacks the required capability", async () => {
    const manifest = makeManifest(["issues.read"]);
    const invoker = createCapabilityScopedInvoker(manifest, cv);
    await expect(invoker.invoke("issues.create", () => Promise.resolve("never"))).rejects.toThrow();
  });

  it("throws for an unknown operation (rejected by default)", async () => {
    const manifest = makeManifest(["issues.read"]);
    const invoker = createCapabilityScopedInvoker(manifest, cv);
    await expect(invoker.invoke("unknown.operation", () => Promise.resolve("x"))).rejects.toThrow();
  });

  it("calls the function exactly once when it passes", async () => {
    const manifest = makeManifest(["issues.read"]);
    const invoker = createCapabilityScopedInvoker(manifest, cv);
    const fn = vi.fn().mockResolvedValue("result");
    await invoker.invoke("issues.list", fn);
    expect(fn).toHaveBeenCalledOnce();
  });

  it("does NOT call the function when the capability check fails", async () => {
    const manifest = makeManifest(["issues.read"]);
    const invoker = createCapabilityScopedInvoker(manifest, cv);
    const fn = vi.fn().mockResolvedValue("result");
    await expect(invoker.invoke("issues.create", fn)).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});
