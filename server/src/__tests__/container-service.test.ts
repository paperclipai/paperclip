import { randomUUID } from "node:crypto";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { createContainerService, type ContainerEngineDriver } from "../services/container-service.js";

function makeFakeDriver(): ContainerEngineDriver {
  const engineContainers = new Map<string, { image: string; status: string; labels: Record<string, string>; createdAt: string }>();
  return {
    async start(engineOpts) {
      const engineId = randomUUID();
      engineContainers.set(engineId, {
        image: engineOpts.image,
        status: "running",
        labels: engineOpts.labels ?? {},
        createdAt: new Date().toISOString(),
      });
      return { engineContainerId: engineId };
    },
    async stop(engineContainerId) {
      const c = engineContainers.get(engineContainerId);
      if (c) c.status = "exited";
    },
    async kill(engineContainerId) {
      engineContainers.delete(engineContainerId);
    },
    async exec(_engineContainerId, _cmd, _opts) {
      return { exitCode: 0, stdout: "", stderr: "", truncated: false };
    },
    async list(_opts) {
      return Array.from(engineContainers.entries()).map(([id, c]) => ({
        engineContainerId: id,
        image: c.image,
        status: c.status,
        createdAt: c.createdAt,
        labels: c.labels,
      }));
    },
    async inspect(engineContainerId) {
      const c = engineContainers.get(engineContainerId);
      if (!c) return null;
      return { engineContainerId, ...c };
    },
    async onStartup() {},
    async dispose() {},
  };
}

describe("ContainerService — start + assertOwnership", () => {
  let service: ReturnType<typeof createContainerService>;
  const pluginId = "test-plugin-a";

  beforeEach(() => {
    service = createContainerService({ driver: makeFakeDriver() });
  });

  it("start returns a host-assigned UUID containerId", async () => {
    const { containerId } = await service.start(pluginId, { image: "alpine:latest" });
    expect(typeof containerId).toBe("string");
    expect(containerId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("start strips paperclip.* from plugin-supplied labels — plugin cannot observe them", async () => {
    const { containerId } = await service.start(pluginId, {
      image: "alpine:latest",
      labels: { "paperclip.plugin-id": "spoofed", userLabel: "ok" },
    });
    const detail = await service.inspect(pluginId, containerId);
    // paperclip.* labels are internal and stripped from plugin-visible output
    expect(detail?.labels["paperclip.plugin-id"]).toBeUndefined();
    expect(detail?.labels["userLabel"]).toBe("ok");
  });

  it("inspect returns null for unknown containerId", async () => {
    const result = await service.inspect(pluginId, randomUUID());
    expect(result).toBeNull();
  });

  it("inspect throws not_owned for a container owned by another plugin", async () => {
    const { containerId } = await service.start(pluginId, { image: "alpine:latest" });
    await expect(service.inspect("other-plugin", containerId)).rejects.toMatchObject({
      code: "not_owned",
    });
  });

  it("stop throws not_owned for a container owned by another plugin", async () => {
    const { containerId } = await service.start(pluginId, { image: "alpine:latest" });
    await expect(service.stop("other-plugin", containerId)).rejects.toMatchObject({
      code: "not_owned",
    });
  });

  it("kill removes container from registry", async () => {
    const { containerId } = await service.start(pluginId, { image: "alpine:latest" });
    await service.kill(pluginId, containerId);
    const detail = await service.inspect(pluginId, containerId);
    expect(detail).toBeNull();
  });

  it("list returns only containers owned by the plugin", async () => {
    await service.start(pluginId, { image: "alpine:latest" });
    await service.start(pluginId, { image: "alpine:latest" });
    await service.start("other-plugin", { image: "alpine:latest" });
    const list = await service.list(pluginId, {});
    expect(list).toHaveLength(2);
    // paperclip.* labels are stripped from plugin-visible results
    expect(list.every((c) => c.labels["paperclip.plugin-id"] === undefined)).toBe(true);
  });
});

describe("ContainerService — concurrency cap", () => {
  it("rejects start when plugin exceeds concurrencyPerPlugin limit", async () => {
    const service = createContainerService({ driver: makeFakeDriver(), concurrencyPerPlugin: 2 });
    const pluginId = "cap-test-plugin";
    await service.start(pluginId, { image: "alpine:latest" });
    await service.start(pluginId, { image: "alpine:latest" });
    await expect(service.start(pluginId, { image: "alpine:latest" })).rejects.toMatchObject({
      code: "quota_exceeded",
    });
  });
});

describe("ContainerService — resource limit enforcement", () => {
  it("clamps memoryMb to memoryMbMax when plugin exceeds the cap", async () => {
    const driver = makeFakeDriver();
    const startSpy = vi.spyOn(driver, "start");
    const service = createContainerService({ driver, memoryMbMax: 512 });
    await service.start("plugin-a", { image: "alpine:latest", memoryMb: 65536 });
    const opts = startSpy.mock.calls[0][0];
    expect(opts.memoryMb).toBeLessThanOrEqual(512);
  });

  it("always applies a lifetime timer bounded by maxLifetimeSec even if plugin omits it", async () => {
    const driver = makeFakeDriver();
    const killSpy = vi.spyOn(driver, "kill");
    const service = createContainerService({ driver, maxLifetimeSec: 1 });
    await service.start("plugin-a", { image: "alpine:latest" });
    await new Promise((r) => setTimeout(r, 1100));
    expect(killSpy).toHaveBeenCalledTimes(1);
  });

  it("clamps plugin-supplied maxLifetimeSec to service maxLifetimeSec", async () => {
    const driver = makeFakeDriver();
    const killSpy = vi.spyOn(driver, "kill");
    const service = createContainerService({ driver, maxLifetimeSec: 1 });
    await service.start("plugin-a", { image: "alpine:latest", maxLifetimeSec: 999999 });
    await new Promise((r) => setTimeout(r, 1100));
    expect(killSpy).toHaveBeenCalledTimes(1);
  });
});

describe("ContainerService — non-positive maxLifetimeSec is clamped", () => {
  it("treats maxLifetimeSec=0 as the service default and still applies timer", async () => {
    const driver = makeFakeDriver();
    const killSpy = vi.spyOn(driver, "kill");
    const service = createContainerService({ driver, maxLifetimeSec: 1 });
    await service.start("plugin-a", { image: "alpine:latest", maxLifetimeSec: 0 });
    await new Promise((r) => setTimeout(r, 1100));
    expect(killSpy).toHaveBeenCalledTimes(1);
  });
});

describe("ContainerService — stop unregisters from registry", () => {
  it("stop removes container from registry so it no longer counts against concurrency", async () => {
    const service = createContainerService({ driver: makeFakeDriver(), concurrencyPerPlugin: 1 });
    const pluginId = "stop-test";
    const { containerId } = await service.start(pluginId, { image: "alpine:latest" });
    await service.stop(pluginId, containerId);
    // Should be able to start again since slot is freed
    await expect(service.start(pluginId, { image: "alpine:latest" })).resolves.toBeDefined();
  });
});

describe("ContainerService — paperclip.managed label written on start", () => {
  it("sets paperclip.managed=true on every started container", async () => {
    const driver = makeFakeDriver();
    const startSpy = vi.spyOn(driver, "start");
    const service = createContainerService({ driver });
    await service.start("plugin-a", { image: "alpine:latest" });
    const opts = startSpy.mock.calls[0][0];
    expect(opts.labels?.["paperclip.managed"]).toBe("true");
  });
});

describe("ContainerService — list strips internal labels", () => {
  it("list result does not expose paperclip.* labels to plugin", async () => {
    const service = createContainerService({ driver: makeFakeDriver() });
    await service.start("plugin-a", { image: "alpine:latest", labels: { myLabel: "val" } });
    const results = await service.list("plugin-a", {});
    expect(results[0].labels["paperclip.plugin-id"]).toBeUndefined();
    expect(results[0].labels["paperclip.managed"]).toBeUndefined();
    expect(results[0].labels["myLabel"]).toBe("val");
  });
});

describe("ContainerService — dispose", () => {
  it("dispose kills all containers for a plugin", async () => {
    const driver = makeFakeDriver();
    const killSpy = vi.spyOn(driver, "kill");
    const service = createContainerService({ driver });
    const pluginId = "dispose-test";
    await service.start(pluginId, { image: "alpine:latest" });
    await service.start(pluginId, { image: "alpine:latest" });
    await service.disposePlugin(pluginId);
    expect(killSpy).toHaveBeenCalledTimes(2);
    const remaining = await service.list(pluginId, {});
    expect(remaining).toHaveLength(0);
  });
});
