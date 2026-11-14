import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { llmCheck } from "../checks/llm-check.js";
import type { PaperclipConfig } from "../config/schema.js";

const ORIGINAL_ENV = { ...process.env };

describe("llmCheck", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.unstubAllGlobals();
  });

  const createMinimalConfig = (llm?: PaperclipConfig["llm"]): PaperclipConfig => ({
    $meta: { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", source: "configure" },
    database: {
      mode: "embedded-postgres",
      embeddedPostgresDataDir: "/tmp/db",
      embeddedPostgresPort: 54329,
      backup: { enabled: false, intervalMinutes: 60, retentionDays: 30, dir: "/tmp/backup" },
    },
    logging: { mode: "file", logDir: "/tmp/logs" },
    server: {
      deploymentMode: "local_trusted",
      exposure: "private",
      host: "127.0.0.1",
      port: 3100,
      allowedHostnames: [],
      serveUi: true,
    },
    auth: { baseUrlMode: "auto", disableSignUp: false },
    telemetry: { enabled: true },
    storage: {
      provider: "local_disk",
      localDisk: { baseDir: "/tmp/storage" },
      s3: { bucket: "", region: "", prefix: "", forcePathStyle: false },
    },
    secrets: {
      provider: "local_encrypted",
      strictMode: false,
      localEncrypted: { keyFilePath: "/tmp/secrets.key" },
    },
    llm,
  });

  it("passes when no LLM provider is configured", async () => {
    const config = createMinimalConfig();
    const result = await llmCheck(config);

    expect(result.status).toBe("pass");
    expect(result.message).toBe("No LLM provider configured (optional)");
  });

  it("passes when LLM provider is configured but no API key is set", async () => {
    const config = createMinimalConfig({ provider: "claude" });
    const result = await llmCheck(config);

    expect(result.status).toBe("pass");
    expect(result.message).toBe("claude configured but no API key set (optional)");
  });

  describe("Claude API key validation", () => {
    it("uses claude-sonnet-4-6 model for the API request", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 200 }),
      );

      const config = createMinimalConfig({
        provider: "claude",
        apiKey: "test-key",
      });

      await llmCheck(config);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.anthropic.com/v1/messages",
        expect.objectContaining({
          method: "POST",
          headers: {
            "x-api-key": "test-key",
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: "claude-sonnet-4-6",
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
        }),
      );
    });

    it("passes when API returns 200", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 200 }),
      );

      const config = createMinimalConfig({
        provider: "claude",
        apiKey: "valid-key",
      });

      const result = await llmCheck(config);

      expect(result.status).toBe("pass");
      expect(result.message).toBe("Claude API key is valid");
    });

    it("passes when API returns 400 (bad request with valid auth)", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 400 }),
      );

      const config = createMinimalConfig({
        provider: "claude",
        apiKey: "valid-key",
      });

      const result = await llmCheck(config);

      expect(result.status).toBe("pass");
      expect(result.message).toBe("Claude API key is valid");
    });

    it("fails when API returns 401 (unauthorized)", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 401 }),
      );

      const config = createMinimalConfig({
        provider: "claude",
        apiKey: "invalid-key",
      });

      const result = await llmCheck(config);

      expect(result.status).toBe("fail");
      expect(result.message).toBe("Claude API key is invalid (401)");
      expect(result.canRepair).toBe(false);
      expect(result.repairHint).toBe("Run `paperclipai configure --section llm`");
    });

    it("warns when API returns other error status", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 500 }),
      );

      const config = createMinimalConfig({
        provider: "claude",
        apiKey: "test-key",
      });

      const result = await llmCheck(config);

      expect(result.status).toBe("warn");
      expect(result.message).toBe("Claude API returned status 500");
    });

    it("warns when network request fails", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockRejectedValueOnce(new Error("Network error"));

      const config = createMinimalConfig({
        provider: "claude",
        apiKey: "test-key",
      });

      const result = await llmCheck(config);

      expect(result.status).toBe("warn");
      expect(result.message).toBe("Could not reach API to validate key");
    });
  });

  describe("OpenAI API key validation", () => {
    it("passes when API returns 200", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 200 }),
      );

      const config = createMinimalConfig({
        provider: "openai",
        apiKey: "valid-key",
      });

      const result = await llmCheck(config);

      expect(result.status).toBe("pass");
      expect(result.message).toBe("OpenAI API key is valid");
    });

    it("fails when API returns 401", async () => {
      const mockFetch = vi.mocked(fetch);
      mockFetch.mockResolvedValueOnce(
        new Response(null, { status: 401 }),
      );

      const config = createMinimalConfig({
        provider: "openai",
        apiKey: "invalid-key",
      });

      const result = await llmCheck(config);

      expect(result.status).toBe("fail");
      expect(result.message).toBe("OpenAI API key is invalid (401)");
    });
  });
});
