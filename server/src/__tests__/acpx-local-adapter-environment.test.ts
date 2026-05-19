import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-acpx-local/server";
import type { AdapterEnvironmentCheck } from "@paperclipai/adapter-utils";

function credentialChecks(checks: AdapterEnvironmentCheck[]): AdapterEnvironmentCheck[] {
  return checks.filter((check) => check.code.startsWith("acpx_claude_") || check.code.startsWith("acpx_codex_"));
}

describe("acpx_local environment credential diagnostics", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "");
    vi.stubEnv("ANTHROPIC_BEDROCK_BASE_URL", "");
    vi.stubEnv("CLAUDE_CODE_USE_BEDROCK", "");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "");
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("CODEX_HOME", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("emits an info-level Claude credential hint when ANTHROPIC_API_KEY is present", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "acpx_local",
      config: {
        agent: "claude",
        env: {
          ANTHROPIC_API_KEY: "sk-ant-test",
        },
      },
    });

    expect(result.checks).toContainEqual(expect.objectContaining({
      code: "acpx_claude_anthropic_api_key_detected",
      level: "info",
    }));
    expect(result.checks.some((check) => check.code.startsWith("acpx_codex_"))).toBe(false);
  });

  it("emits an info-level Claude missing credential hint without changing diagnostic health", async () => {
    const root = path.join(os.tmpdir(), `paperclip-acpx-claude-noauth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const claudeConfigDir = path.join(root, ".claude");

    try {
      await fs.mkdir(claudeConfigDir, { recursive: true });

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "acpx_local",
        config: {
          agent: "claude",
          env: {
            CLAUDE_CONFIG_DIR: claudeConfigDir,
          },
        },
      });

      expect(result.checks).toContainEqual(expect.objectContaining({
        code: "acpx_claude_credentials_missing",
        level: "info",
      }));
      expect(credentialChecks(result.checks).every((check) => check.level === "info")).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits an info-level Codex credential hint when native auth is present", async () => {
    const root = path.join(os.tmpdir(), `paperclip-acpx-codex-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codexHome = path.join(root, ".codex");

    try {
      await fs.mkdir(codexHome, { recursive: true });
      await fs.writeFile(path.join(codexHome, "auth.json"), JSON.stringify({ accessToken: "token" }), "utf8");

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "acpx_local",
        config: {
          agent: "codex",
          env: {
            CODEX_HOME: codexHome,
          },
        },
      });

      expect(result.checks).toContainEqual(expect.objectContaining({
        code: "acpx_codex_native_auth_detected",
        level: "info",
      }));
      expect(result.checks.some((check) => check.code.startsWith("acpx_claude_"))).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits an info-level Codex missing credential hint without changing diagnostic health", async () => {
    const root = path.join(os.tmpdir(), `paperclip-acpx-codex-noauth-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const codexHome = path.join(root, ".codex");

    try {
      await fs.mkdir(codexHome, { recursive: true });

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "acpx_local",
        config: {
          agent: "codex",
          env: {
            CODEX_HOME: codexHome,
          },
        },
      });

      expect(result.checks).toContainEqual(expect.objectContaining({
        code: "acpx_codex_credentials_missing",
        level: "info",
      }));
      expect(credentialChecks(result.checks).every((check) => check.level === "info")).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
