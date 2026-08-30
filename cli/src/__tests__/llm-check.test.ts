import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaperclipConfig } from "../config/schema.js";
import { llmCheck } from "../checks/llm-check.js";

function createConfig(llm?: PaperclipConfig["llm"]): PaperclipConfig {
  return {
    $meta: {
      version: 1,
      updatedAt: new Date("2026-01-01T00:00:00.000Z").toISOString(),
      source: "configure",
    },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/paperclip-db",
      embeddedPostgresPort: 54329,
      backup: {
        enabled: true,
        intervalMinutes: 60,
        retentionDays: 30,
        dir: "/tmp/paperclip-backups",
      },
    },
    logging: {
      mode: "file",
      logDir: "/tmp/paperclip-logs",
    },
    server: {
      deploymentMode: "authenticated",
      exposure: "private",
      host: "0.0.0.0",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: {
      baseUrlMode: "auto",
      disableSignUp: false,
    },
    telemetry: {
      enabled: true,
    },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: "/tmp/paperclip-storage" },
      s3: {
        bucket: "paperclip",
        region: "us-east-1",
        prefix: "",
        forcePathStyle: false,
      },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: "/tmp/paperclip-secrets/master.key" },
    },
    llm,
  };
}

describe("llmCheck", () => {
  const fetchMock = vi.fn();

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("passes when no LLM provider is configured", async () => {
    const result = await llmCheck(createConfig());
    expect(result.status).toBe("pass");
    expect(result.message).toContain("No LLM provider configured");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("passes when configured without an API key", async () => {
    const result = await llmCheck(createConfig({ provider: "deepseek" }));
    expect(result.status).toBe("pass");
    expect(result.message).toContain("configured but no API key set");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["openai", "https://api.openai.com/v1/models", "OpenAI"],
    ["deepseek", "https://api.deepseek.com/v1/models", "DeepSeek"],
    ["glm", "https://open.bigmodel.cn/api/paas/v4/models", "Zhipu GLM"],
    ["kimi", "https://api.moonshot.cn/v1/models", "Moonshot Kimi"],
  ])(
    "validates %s against %s",
    async (provider, expectedUrl, label) => {
      vi.stubGlobal("fetch", fetchMock);
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200 });

      const result = await llmCheck(createConfig({ provider: provider as "deepseek", apiKey: "sk-test" }));
      expect(result.status).toBe("pass");
      expect(result.message).toBe(`${label} API key is valid`);
      expect(fetchMock).toHaveBeenCalledWith(
        expectedUrl,
        expect.objectContaining({ headers: { Authorization: "Bearer sk-test" } }),
      );
    },
  );

  it("fails on 401 with a repair hint", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValueOnce({ ok: false, status: 401 });

    const result = await llmCheck(createConfig({ provider: "deepseek", apiKey: "sk-bad" }));
    expect(result.status).toBe("fail");
    expect(result.message).toBe("DeepSeek API key is invalid (401)");
    expect(result.repairHint).toBe("Run `paperclipai configure --section llm`");
  });

  it("warns when the API cannot be reached", async () => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const result = await llmCheck(createConfig({ provider: "kimi", apiKey: "sk-test" }));
    expect(result.status).toBe("warn");
    expect(result.message).toBe("Could not reach API to validate key");
  });
});