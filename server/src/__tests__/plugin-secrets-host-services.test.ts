import { describe, expect, it, vi } from "vitest";
import { createHostClientHandlers } from "../../../packages/plugins/sdk/src/host-client-factory.js";
import { buildHostServices } from "../services/plugin-host-services.js";

const resolveSecretValue = vi.hoisted(() => vi.fn());

vi.mock("../services/secrets.js", () => ({
  secretService: vi.fn(() => ({ resolveSecretValue })),
}));

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

describe("plugin secrets host services bridge", () => {
  it("forwards worker invocation scope to the plugin secrets handler", async () => {
    resolveSecretValue.mockResolvedValue("resolved-value");

    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "acme.secrets",
      createEventBusStub(),
    );
    const handlers = createHostClientHandlers({
      pluginId: "acme.secrets",
      capabilities: ["secrets.read-ref"],
      services,
    });

    const result = await handlers["secrets.resolve"](
      { secretRef: "77777777-7777-4777-8777-777777777777" },
      { invocationScope: { companyId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" } },
    );

    expect(result).toBe("resolved-value");
    expect(resolveSecretValue).toHaveBeenCalledWith(
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "77777777-7777-4777-8777-777777777777",
      "latest",
    );

    services.dispose();
  });
});
