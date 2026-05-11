import { describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { buildHostServices } from "../services/plugin-host-services.js";
import { createContainerService, type ContainerEngineDriver } from "../services/container-service.js";

function createEventBusStub() {
  return {
    forPlugin() {
      return {
        emit: vi.fn(),
        subscribe: vi.fn(),
        clear: vi.fn(),
      };
    },
  } as any;
}

function makeFakeDriver(): ContainerEngineDriver {
  return {
    async start(_opts) { return { engineContainerId: "engine-id-1" }; },
    async stop(_id) {},
    async kill(_id) {},
    async exec(_id, _cmd, _opts) { return { exitCode: 0, stdout: "hello", stderr: "", truncated: false }; },
    async list(_opts) { return []; },
    async inspect(_id) { return null; },
    async onStartup() {},
    async dispose() {},
  };
}

describe("plugin container bridge — buildHostServices wiring", () => {
  it("containers.start handler delegates to ContainerService when capability present", async () => {
    const containerService = createContainerService({ driver: makeFakeDriver() });
    const startSpy = vi.spyOn(containerService, "start");

    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "test.plugin",
      createEventBusStub(),
      undefined,
      { containerService },
    );

    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["containers.manage"],
      services,
    });

    const result = await handlers["containers.start"]({ image: "alpine:latest" });
    expect(result.containerId).toBeDefined();
    expect(startSpy).toHaveBeenCalledOnce();
  });

  it("containers.start rejects with capability error when capability missing", async () => {
    const containerService = createContainerService({ driver: makeFakeDriver() });
    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "test.plugin",
      createEventBusStub(),
      undefined,
      { containerService },
    );

    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: [],
      services,
    });

    await expect(handlers["containers.start"]({ image: "alpine:latest" })).rejects.toThrow(/capability/i);
  });

  it("containers.start passes pluginId (UUID) not pluginKey (manifest key) to ContainerService", async () => {
    const containerService = createContainerService({ driver: makeFakeDriver() });
    const startSpy = vi.spyOn(containerService, "start");

    const services = buildHostServices(
      {} as never,
      "plugin-record-uuid-1234",
      "test.plugin",
      createEventBusStub(),
      undefined,
      { containerService },
    );

    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["containers.manage"],
      services,
    });

    await handlers["containers.start"]({ image: "alpine:latest" });
    // First arg to ContainerService.start must be the pluginId (UUID), not the pluginKey
    expect(startSpy.mock.calls[0][0]).toBe("plugin-record-uuid-1234");
    expect(startSpy.mock.calls[0][0]).not.toBe("test.plugin");
  });

  it("containers.list returns empty array via service", async () => {
    const containerService = createContainerService({ driver: makeFakeDriver() });
    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "test.plugin",
      createEventBusStub(),
      undefined,
      { containerService },
    );

    const handlers = createHostClientHandlers({
      pluginId: "test.plugin",
      capabilities: ["containers.manage"],
      services,
    });

    const result = await handlers["containers.list"]({});
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(0);
  });
});
