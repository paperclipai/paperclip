import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-codex-local/server";

async function writeFakeCodexScript(commandPath: string, body: string): Promise<void> {
  await fs.writeFile(commandPath, `#!/usr/bin/env node\n${body}\n`, "utf8");
  await fs.chmod(commandPath, 0o755);
}

const itWindows = process.platform === "win32" ? it : it.skip;

describe("codex_local environment diagnostics", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  it("creates a missing working directory when cwd is absolute", async () => {
    const cwd = path.join(
      os.tmpdir(),
      `paperclip-codex-local-cwd-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      "workspace",
    );

    await fs.rm(path.dirname(cwd), { recursive: true, force: true });

    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "codex_local",
      config: {
        command: process.execPath,
        cwd,
      },
    });

    expect(result.checks.some((check) => check.code === "codex_cwd_valid")).toBe(true);
    expect(result.checks.some((check) => check.level === "error")).toBe(false);
    const stats = await fs.stat(cwd);
    expect(stats.isDirectory()).toBe(true);
    await fs.rm(path.dirname(cwd), { recursive: true, force: true });
  });

  it("emits codex_native_auth_present when ~/.codex/auth.json exists and OPENAI_API_KEY is unset", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-auth-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const codexHome = path.join(root, ".codex");
    const cwd = path.join(root, "workspace");

    try {
      await fs.mkdir(codexHome, { recursive: true });
      await fs.writeFile(
        path.join(codexHome, "auth.json"),
        JSON.stringify({ accessToken: "fake-token", accountId: "acct-1" }),
      );

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: process.execPath,
          cwd,
          env: { CODEX_HOME: codexHome },
        },
      });

      expect(result.checks.some((check) => check.code === "codex_native_auth_present")).toBe(true);
      expect(result.checks.some((check) => check.code === "codex_openai_api_key_missing")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("emits codex_openai_api_key_missing when neither env var nor native auth exists", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-noauth-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const codexHome = path.join(root, ".codex");
    const cwd = path.join(root, "workspace");

    try {
      await fs.mkdir(codexHome, { recursive: true });
      // No auth.json written

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: process.execPath,
          cwd,
          env: { CODEX_HOME: codexHome },
        },
      });

      expect(result.checks.some((check) => check.code === "codex_openai_api_key_missing")).toBe(true);
      expect(result.checks.some((check) => check.code === "codex_native_auth_present")).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("verifies exec tooling with a dedicated tool probe", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-tool-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const cwd = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");

    try {
      await fs.mkdir(root, { recursive: true });
      await writeFakeCodexScript(commandPath, `
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
console.log(JSON.stringify({ type: "thread.started", thread_id: "tool-probe-thread" }));
if (prompt.includes("exec_command tool")) {
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "tool ok" } }));
} else {
  console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
}
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`);

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: commandPath,
          cwd,
          env: {
            OPENAI_API_KEY: "test-key",
          },
        },
      });

      expect(result.status).toBe("pass");
      expect(result.checks.some((check) => check.code === "codex_hello_probe_passed")).toBe(true);
      expect(result.checks.some((check) => check.code === "codex_tool_probe_passed")).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("surfaces tool runtime failures from the dedicated tool probe", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-tool-runtime-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const cwd = path.join(root, "workspace");
    const commandPath = path.join(root, "codex");

    try {
      await fs.mkdir(root, { recursive: true });
      await writeFakeCodexScript(commandPath, `
const fs = require("node:fs");
const prompt = fs.readFileSync(0, "utf8");
console.log(JSON.stringify({ type: "thread.started", thread_id: "tool-runtime-thread" }));
if (prompt.includes("exec_command tool")) {
  console.error("ERROR codex_core::tools::router: error=exec_command failed: CreateProcess { message: \\"Rejected(\\\\\\"Failed to create unified exec process: No such file or directory (os error 2)\\\\\\")\\" }");
  process.exit(1);
}
console.log(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hello" } }));
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 } }));
`);

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: commandPath,
          cwd,
          env: {
            OPENAI_API_KEY: "test-key",
          },
        },
      });

      expect(result.status).toBe("fail");
      expect(result.checks.some((check) => check.code === "codex_tool_probe_runtime_unavailable")).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  itWindows("runs the hello probe when Codex is available via a Windows .cmd wrapper", async () => {
    const root = path.join(
      os.tmpdir(),
      `paperclip-codex-local-probe-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    const binDir = path.join(root, "bin");
    const cwd = path.join(root, "workspace");
    const fakeCodex = path.join(binDir, "codex.cmd");
    const script = [
      "@echo off",
      "echo {\"type\":\"thread.started\",\"thread_id\":\"test-thread\"}",
      "echo {\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"hello\"}}",
      "echo {\"type\":\"turn.completed\",\"usage\":{\"input_tokens\":1,\"cached_input_tokens\":0,\"output_tokens\":1}}",
      "exit /b 0",
      "",
    ].join("\r\n");

    try {
      await fs.mkdir(binDir, { recursive: true });
      await fs.writeFile(fakeCodex, script, "utf8");

      const result = await testEnvironment({
        companyId: "company-1",
        adapterType: "codex_local",
        config: {
          command: "codex",
          cwd,
          env: {
            OPENAI_API_KEY: "test-key",
            PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ""}`,
          },
        },
      });

      expect(result.status).toBe("pass");
      expect(result.checks.some((check) => check.code === "codex_hello_probe_passed")).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
