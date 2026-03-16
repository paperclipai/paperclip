import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-opencode-local/server";

async function writeFakeOpenCodeCommand(binDir: string): Promise<string> {
  const scriptPath = path.join(binDir, "opencode.js");
  const script = [
    'console.error("ProviderModelNotFoundError: ProviderModelNotFoundError");',
    'console.error("data: { providerID: \\\"openai\\\", modelID: \\\"gpt-5.3-codex\\\", suggestions: [] }");',
    'process.exit(1);',
  ].join("\n");
  await fs.writeFile(scriptPath, script, "utf8");
  if (process.platform === "win32") {
    const commandPath = path.join(binDir, "opencode.cmd");
    const scriptWin = scriptPath.replaceAll("/", "\\");
    await fs.writeFile(commandPath, `@echo off\r\n"${process.execPath}" "${scriptWin}" %*\r\n`, "utf8");
    return commandPath;
  }
  const commandPath = path.join(binDir, "opencode");
  await fs.writeFile(commandPath, `#!/usr/bin/env node\n${script}\n`, "utf8");
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("opencode_local environment diagnostics", () => {
  it("reports a missing working directory as an error when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-opencode-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "opencode_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "opencode_cwd_invalid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(true);
    expect(result.status).toBe("fail");
  });

  it("treats an empty OPENAI_API_KEY override as missing", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-empty-key-"));
    const originalOpenAiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "sk-host-value";

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "opencode_local",
        config: {
          command: process.execPath,
          cwd,
          env: {
            OPENAI_API_KEY: "",
          },
        },
      });

      const missingCheck = result.checks.find((check) => check.code === "opencode_openai_api_key_missing");
      expect(missingCheck).toBeTruthy();
      expect(missingCheck?.hint).toContain("empty");
    } finally {
      if (originalOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = originalOpenAiKey;
      }
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });

  it("classifies ProviderModelNotFoundError probe output as model-unavailable warning", async () => {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-probe-cwd-"));
    const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-env-probe-bin-"));
    const fakeOpencode = await writeFakeOpenCodeCommand(binDir);

    try {
      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "opencode_local",
        config: {
          command: fakeOpencode,
          cwd,
        },
      });

      const modelCheck = result.checks.find((check) => check.code === "opencode_hello_probe_model_unavailable");
      expect(modelCheck).toBeTruthy();
      expect(modelCheck?.level).toBe("warn");
      expect(result.status).toBe("warn");
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
      await fs.rm(binDir, { recursive: true, force: true });
    }
  });
});
