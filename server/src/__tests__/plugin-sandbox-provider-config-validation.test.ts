import { beforeEach, describe, expect, it, vi } from "vitest";
import { validatePluginSandboxProviderConfig } from "../services/plugin-environment-driver.ts";
import type { PluginWorkerManager } from "../services/plugin-worker-manager.ts";
import type { Db } from "@paperclipai/db";

const mockList = vi.fn();

vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => ({
    list: mockList,
  }),
}));

const PLUGIN_ID = "22222222-2222-2222-2222-222222222222";
const SECRET_ID = "11111111-1111-1111-1111-111111111111";

function seedProviderPlugin() {
  mockList.mockResolvedValue([
    {
      id: PLUGIN_ID,
      pluginKey: "acme.secure-sandbox-provider",
      status: "ready",
      manifestJson: {
        environmentDrivers: [
          {
            driverKey: "secure-plugin",
            kind: "sandbox_provider",
            displayName: "Secure Sandbox",
            configSchema: {
              type: "object",
              properties: {
                template: { type: "string" },
                apiKey: { type: "string", format: "secret-ref" },
                timeoutMs: { type: "number" },
              },
            },
          },
        ],
      },
    },
  ]);
}

function createWorkerManager() {
  return {
    isRunning: vi.fn(() => true),
    call: vi.fn(async (_pluginId: string, _method: string, params: { config: Record<string, unknown> }) => ({
      ok: true,
      normalizedConfig: { ...params.config },
    })),
  } as unknown as PluginWorkerManager & { call: ReturnType<typeof vi.fn> };
}

describe("validatePluginSandboxProviderConfig secret-ref bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedProviderPlugin();
  });

  it("canonicalizes secret_ref binding objects to bare secret ids before the plugin validates", async () => {
    const workerManager = createWorkerManager();

    const result = await validatePluginSandboxProviderConfig({
      db: {} as Db,
      workerManager,
      provider: "secure-plugin",
      config: {
        template: "base",
        apiKey: { type: "secret_ref", secretId: SECRET_ID, version: "latest" },
        timeoutMs: 1234,
      },
    });

    expect(workerManager.call).toHaveBeenCalledWith(PLUGIN_ID, "environmentValidateConfig", {
      driverKey: "secure-plugin",
      config: {
        template: "base",
        apiKey: SECRET_ID,
        timeoutMs: 1234,
      },
    });
    expect(result.normalizedConfig.apiKey).toBe(SECRET_ID);
  });

  it("rejects pinned secret binding versions before calling the plugin", async () => {
    const workerManager = createWorkerManager();

    await expect(validatePluginSandboxProviderConfig({
      db: {} as Db,
      workerManager,
      provider: "secure-plugin",
      config: {
        apiKey: { type: "secret_ref", secretId: SECRET_ID, version: 3 },
      },
    })).rejects.toThrow(/pins version 3/);
    expect(workerManager.call).not.toHaveBeenCalled();
  });

  it("passes raw strings and bare secret ids through untouched", async () => {
    const workerManager = createWorkerManager();

    await validatePluginSandboxProviderConfig({
      db: {} as Db,
      workerManager,
      provider: "secure-plugin",
      config: {
        template: "base",
        apiKey: "raw-provider-key",
      },
    });

    expect(workerManager.call).toHaveBeenCalledWith(PLUGIN_ID, "environmentValidateConfig", {
      driverKey: "secure-plugin",
      config: {
        template: "base",
        apiKey: "raw-provider-key",
      },
    });
  });
});
