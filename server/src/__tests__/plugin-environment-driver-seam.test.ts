import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  PLUGIN_RPC_ERROR_CODES,
  createRequest,
  isJsonRpcErrorResponse,
  isJsonRpcSuccessResponse,
  parseMessage,
  serializeMessage,
} from "../../../packages/plugins/sdk/src/protocol.js";
import { definePlugin } from "../../../packages/plugins/sdk/src/define-plugin.js";
import { startWorkerRpcHost } from "../../../packages/plugins/sdk/src/worker-rpc-host.js";
import { pluginManifestV1Schema, type PaperclipPluginManifestV1 } from "@paperclipai/shared";
import { pluginCapabilityValidator } from "../services/plugin-capability-validator.js";

const baseManifest: PaperclipPluginManifestV1 = {
  id: "test.environment-driver",
  apiVersion: 1,
  version: "1.0.0",
  displayName: "Environment Driver",
  description: "Test environment driver plugin",
  author: "Paperclip",
  categories: ["automation"],
  capabilities: ["environment.drivers.register"],
  entrypoints: { worker: "dist/worker.js" },
  environmentDrivers: [
    {
      driverKey: "fake-plugin",
      displayName: "Fake plugin",
      configSchema: {
        type: "object",
        properties: {
          template: { type: "string" },
        },
        required: ["template"],
      },
    },
  ],
};

describe("plugin environment driver seam", () => {
  it("validates environment driver manifest declarations", () => {
    expect(pluginManifestV1Schema.safeParse(baseManifest).success).toBe(true);

    const missingCapability = pluginManifestV1Schema.safeParse({
      ...baseManifest,
      capabilities: ["http.outbound"],
    });
    expect(missingCapability.success).toBe(false);
    expect(JSON.stringify(missingCapability.error?.issues)).toContain(
      "environment.drivers.register",
    );

    const duplicateDriver = pluginManifestV1Schema.safeParse({
      ...baseManifest,
      environmentDrivers: [
        baseManifest.environmentDrivers![0],
        { ...baseManifest.environmentDrivers![0], displayName: "Duplicate" },
      ],
    });
    expect(duplicateDriver.success).toBe(false);
    expect(JSON.stringify(duplicateDriver.error?.issues)).toContain(
      "Duplicate environment driver keys",
    );
  });

  it("enforces environment driver capability requirements", () => {
    const validator = pluginCapabilityValidator();
    expect(validator.getRequiredCapabilities("environment.acquireLease")).toEqual([
      "environment.drivers.register",
    ]);
    expect(validator.checkOperation(baseManifest, "environment.execute").allowed).toBe(true);

    const withoutCapability = {
      ...baseManifest,
      capabilities: ["http.outbound"],
    } satisfies PaperclipPluginManifestV1;

    expect(validator.checkOperation(withoutCapability, "environment.execute")).toMatchObject({
      allowed: false,
      missing: ["environment.drivers.register"],
    });
    expect(validator.validateManifestCapabilities(withoutCapability)).toMatchObject({
      allowed: false,
      missing: ["environment.drivers.register"],
    });
  });

  it("dispatches environment driver worker hooks and reports support", async () => {
    const plugin = definePlugin({
      async setup() {},
      async onEnvironmentProbe(params) {
        return {
          ok: true,
          summary: `probed ${params.driverKey}`,
          metadata: { environmentId: params.environmentId },
        };
      },
    });

    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const host = startWorkerRpcHost({ plugin, stdin, stdout });
    const responses: unknown[] = [];
    stdout.on("data", (chunk) => {
      const lines = String(chunk).split("\n").filter(Boolean);
      for (const line of lines) {
        responses.push(parseMessage(line));
      }
    });

    stdin.write(serializeMessage(createRequest("initialize", {
      manifest: baseManifest,
      config: {},
      instanceInfo: { instanceId: "instance-1", hostVersion: "1.0.0" },
      apiVersion: 1,
    }, 1)));
    await waitForResponses(responses, 1);

    const initializeResponse = responses[0];
    expect(isJsonRpcSuccessResponse(initializeResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(initializeResponse)) return;
    expect(initializeResponse.result.supportedMethods).toContain("environmentProbe");

    stdin.write(serializeMessage(createRequest("environmentProbe", {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "environment-1",
      config: { template: "base" },
    }, 2)));
    await waitForResponses(responses, 2);

    const probeResponse = responses[1];
    expect(isJsonRpcSuccessResponse(probeResponse)).toBe(true);
    if (!isJsonRpcSuccessResponse(probeResponse)) return;
    expect(probeResponse.result).toMatchObject({
      ok: true,
      summary: "probed fake-plugin",
      metadata: { environmentId: "environment-1" },
    });

    stdin.write(serializeMessage(createRequest("environmentExecute", {
      driverKey: "fake-plugin",
      companyId: "company-1",
      environmentId: "environment-1",
      config: { template: "base" },
      lease: { providerLeaseId: "lease-1" },
      command: "echo",
    }, 3)));
    await waitForResponses(responses, 3);

    const executeResponse = responses[2];
    expect(isJsonRpcErrorResponse(executeResponse)).toBe(true);
    if (!isJsonRpcErrorResponse(executeResponse)) return;
    expect(executeResponse.error.code).toBe(PLUGIN_RPC_ERROR_CODES.METHOD_NOT_IMPLEMENTED);
    expect(executeResponse.error.message).toContain("environmentExecute");

    host.stop();
  });
});

async function waitForResponses(responses: unknown[], count: number): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (responses.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  expect(responses.length).toBeGreaterThanOrEqual(count);
}
