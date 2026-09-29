import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { testEnvironment } from "@paperclipai/adapter-codex-local/server";

const itWindows = process.platform === "win32" ? it : it.skip;
const itPosix = process.platform === "win32" ? it.skip : it;

async function runProbeFixture(options: { failCleanup?: boolean; error?: string } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-probe-result-"));
  const capture = path.join(root, "capture.json");
  const command = path.join(root, "codex");
  await fs.writeFile(command, `#!${process.execPath}
const fs = require('node:fs');
fs.writeFileSync(process.env.PROBE_CAPTURE, JSON.stringify({ args: process.argv.slice(2), home: process.env.CODEX_HOME }));
console.error('WARN codex_core_plugins::manager: remote installed plugin bundle sync failed error=chatgpt authentication required for remote plugin catalog');
const error = process.env.PROBE_ERROR;
if (error) { console.error(error); process.exit(1); }
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'hello'}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`, { mode: 0o755 });
  if (options.failCleanup) {
    // Deterministic equivalent of rm observing a concurrent plugin writer.
    await fs.writeFile(path.join(root, "rm"), '#!/bin/sh\nif [ "$1" = "-rf" ]; then echo "rm: Directory not empty" >&2; exit 1; fi\nexec /bin/rm "$@"\n', { mode: 0o755 });
  }
  try {
    const result = await testEnvironment({
      companyId: "company-1", adapterType: "codex_local",
      config: { engine: "cli", command, cwd: root, env: {
        OPENAI_API_KEY: "fixture-key", PROBE_CAPTURE: capture,
        PROBE_ERROR: options.error ?? "", PATH: `${root}${path.delimiter}${process.env.PATH ?? ""}`,
      } },
    });
    return { result, capture: JSON.parse(await fs.readFile(capture, "utf8")) as { args: string[]; home: string } };
  } finally {
    const recorded = await fs.readFile(capture, "utf8").then(JSON.parse).catch(() => null);
    if (recorded?.home) await fs.rm(recorded.home, { recursive: true, force: true });
    await fs.rm(root, { recursive: true, force: true });
  }
}

describe("codex_local environment diagnostics", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_API_KEY", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
  itPosix("preserves a successful hello when probe cleanup races a background writer", async () => {
    const { result } = await runProbeFixture({ failCleanup: true });
    expect(result.status).toBe("pass");
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "codex_hello_probe_passed" }));
    expect(result.checks).not.toContainEqual(expect.objectContaining({ code: "codex_hello_probe_auth_required" }));
  });

  itPosix("does not diagnose an unrelated plugin login warning as model authentication failure", async () => {
    const { result } = await runProbeFixture({ error: "Unable to start turn: disk is full" });
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "codex_hello_probe_failed", detail: "Unable to start turn: disk is full" }));
    expect(result.checks).not.toContainEqual(expect.objectContaining({ code: "codex_hello_probe_auth_required" }));
  });

  itPosix("still reports genuine provider authentication failures", async () => {
    const { result } = await runProbeFixture({ error: "Invalid API key" });
    expect(result.checks).toContainEqual(expect.objectContaining({ code: "codex_hello_probe_auth_required" }));
  });

  itPosix("keeps hello probes free of plugin synchronization and repository instructions", async () => {
    const { capture } = await runProbeFixture();
    expect(capture.args).toContain("features.plugins=false");
    expect(capture.args).toContain("features.remote_plugin=false");
    expect(capture.args).toContain("project_doc_max_bytes=0");
    expect(capture.args).toContain("--ephemeral");
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
        engine: "cli",
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
          engine: "cli",
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
          engine: "cli",
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
          engine: "cli",
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
