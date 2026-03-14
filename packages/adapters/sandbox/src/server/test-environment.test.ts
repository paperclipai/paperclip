import { afterEach, describe, expect, it } from "vitest";
import { setSandboxProviderFactoryForTests } from "./execute.js";
import { testEnvironment } from "./test.js";

describe("sandbox adapter environment test", () => {
  afterEach(() => {
    setSandboxProviderFactoryForTests(null);
  });

  it("fails fast when E2B template is missing", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "sandbox",
      config: {
        providerType: "e2b",
        sandboxAgentType: "codex_local",
        env: {
          E2B_API_KEY: "secret",
        },
      },
    });

    expect(result.status).toBe("fail");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "missing_template",
          level: "error",
        }),
      ]),
    );
  });

  it("uses the selected provider for connectivity checks", async () => {
    setSandboxProviderFactoryForTests((config) => ({
      type: String(config.providerType ?? "unknown"),
      async create() {
        throw new Error("not used");
      },
      async reconnect() {
        throw new Error("not used");
      },
      async testConnection() {
        return {
          ok: true,
          detail: "mock reachable",
        };
      },
    }));

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "sandbox",
      config: {
        providerType: "opensandbox",
        sandboxAgentType: "opencode_local",
        providerConfig: {
          image: "ghcr.io/paperclipai/agent-sandbox:latest",
        },
        env: {
          OPEN_SANDBOX_API_KEY: "secret",
        },
      },
    });

    expect(result.status).toBe("pass");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "provider_ok",
          level: "info",
          message: "OpenSandbox reachable",
          detail: "mock reachable",
        }),
      ]),
    );
  });
});
