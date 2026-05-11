import { describe, expect, it, vi } from "vitest";
import { createHostClientHandlers, type HostServices } from "./host-client-factory.js";
import { createTestHarness } from "./testing.js";

const minimalManifest = {
  name: "test-plugin",
  displayName: "Test",
  version: "0.0.1",
  description: "test",
  capabilities: ["containers.manage"] as const,
  permissions: [],
};

function makeContainerServices(): HostServices["containers"] {
  return {
    start: vi.fn().mockResolvedValue({ containerId: "host-uuid-1" }),
    stop: vi.fn().mockResolvedValue(undefined),
    kill: vi.fn().mockResolvedValue(undefined),
    exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: "", stderr: "", truncated: false }),
    list: vi.fn().mockResolvedValue([]),
    inspect: vi.fn().mockResolvedValue(null),
  };
}

describe("createHostClientHandlers — containers capability gating", () => {
  it("handlers include all 6 container RPC methods", () => {
    const handlers = createHostClientHandlers({
      pluginId: "test",
      capabilities: ["containers.manage"],
      services: {
        containers: makeContainerServices(),
      } as unknown as HostServices,
    });
    expect(typeof handlers["containers.start"]).toBe("function");
    expect(typeof handlers["containers.stop"]).toBe("function");
    expect(typeof handlers["containers.kill"]).toBe("function");
    expect(typeof handlers["containers.exec"]).toBe("function");
    expect(typeof handlers["containers.list"]).toBe("function");
    expect(typeof handlers["containers.inspect"]).toBe("function");
  });

  it.each([
    ["containers.start", { image: "alpine:latest" }],
    ["containers.stop", { containerId: "x" }],
    ["containers.kill", { containerId: "x" }],
    ["containers.exec", { containerId: "x", cmd: ["echo"] }],
    ["containers.list", {}],
    ["containers.inspect", { containerId: "x" }],
  ] as const)("%s is blocked without containers.manage capability", async (method, params) => {
    const handlers = createHostClientHandlers({
      pluginId: "test",
      capabilities: [],
      services: {
        containers: makeContainerServices(),
      } as unknown as HostServices,
    });
    await expect(
      (handlers as Record<string, (p: unknown) => Promise<unknown>>)[method](params),
    ).rejects.toThrow(/capability/i);
  });

  it("containers.start delegates to service when capability present", async () => {
    const containers = makeContainerServices();
    const handlers = createHostClientHandlers({
      pluginId: "test",
      capabilities: ["containers.manage"],
      services: { containers } as unknown as HostServices,
    });
    const result = await handlers["containers.start"]({ image: "alpine:latest" });
    expect(result).toEqual({ containerId: "host-uuid-1" });
    expect(containers.start).toHaveBeenCalledWith({ image: "alpine:latest" });
  });

  it("containers.list returns [] when no containers", async () => {
    const containers = makeContainerServices();
    const handlers = createHostClientHandlers({
      pluginId: "test",
      capabilities: ["containers.manage"],
      services: { containers } as unknown as HostServices,
    });
    const result = await handlers["containers.list"]({});
    expect(result).toEqual([]);
  });

  it("containers.inspect returns null for unknown container", async () => {
    const containers = makeContainerServices();
    const handlers = createHostClientHandlers({
      pluginId: "test",
      capabilities: ["containers.manage"],
      services: { containers } as unknown as HostServices,
    });
    const result = await handlers["containers.inspect"]({ containerId: "unknown" });
    expect(result).toBeNull();
  });
});

describe("createTestHarness — ctx.containers", () => {
  it("ctx.containers exists when capability declared", () => {
    const { ctx } = createTestHarness({ manifest: minimalManifest });
    expect(ctx.containers).toBeDefined();
  });

  it("ctx.containers.start returns containerId", async () => {
    const { ctx } = createTestHarness({ manifest: minimalManifest });
    const result = await ctx.containers.start({ image: "alpine:latest" });
    expect(result.containerId).toBeDefined();
  });

  it("ctx.containers.list returns empty array", async () => {
    const { ctx } = createTestHarness({ manifest: minimalManifest });
    const result = await ctx.containers.list();
    expect(Array.isArray(result)).toBe(true);
  });

  it("ctx.containers.inspect returns null for unknown container", async () => {
    const { ctx } = createTestHarness({ manifest: minimalManifest });
    const result = await ctx.containers.inspect("unknown-id");
    expect(result).toBeNull();
  });

  it("ctx.containers.exec returns exit code and output", async () => {
    const { ctx } = createTestHarness({ manifest: minimalManifest });
    const { containerId } = await ctx.containers.start({ image: "alpine:latest" });
    const result = await ctx.containers.exec(containerId, ["echo", "hello"]);
    expect(typeof result.exitCode).toBe("number");
    expect(typeof result.stdout).toBe("string");
  });

  it("ctx.containers.start strips paperclip.* labels so plugin cannot observe them", async () => {
    const { ctx } = createTestHarness({ manifest: minimalManifest });
    const { containerId } = await ctx.containers.start({
      image: "alpine:latest",
      labels: { "paperclip.plugin-id": "spoofed", userLabel: "ok" },
    });
    const detail = await ctx.containers.inspect(containerId);
    expect(detail?.labels["paperclip.plugin-id"]).toBeUndefined();
    expect(detail?.labels["userLabel"]).toBe("ok");
  });
});
