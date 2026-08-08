import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverOpenCodeModelsCached,
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

// Writes a throwaway `opencode`-shaped shell script that records each invocation
// to `counterPath` and prints two provider/model lines after a short sleep (so
// concurrent callers overlap). Returns the script path.
function writeFakeOpenCode(dir: string, counterPath: string, sleepSeconds = 0.2): string {
  const script = path.join(dir, "fake-opencode.sh");
  fs.writeFileSync(
    script,
    [
      "#!/bin/sh",
      `echo x >> "${counterPath}"`,
      `sleep ${sleepSeconds}`,
      'echo "openai/gpt-5"',
      'echo "anthropic/claude-4"',
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  return script;
}

function countInvocations(counterPath: string): number {
  if (!fs.existsSync(counterPath)) return 0;
  return fs.readFileSync(counterPath, "utf8").split("\n").filter(Boolean).length;
}

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.OPENCODE_ALLOW_ALL_MODELS;
    delete process.env.PAPERCLIP_OPENCODE_MODELS_TIMEOUT_MS;
    resetOpenCodeModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("accepts a provider/model id without running discovery", () => {
    expect(requireOpenCodeModelId("openai/gpt-5.2-codex")).toBe("openai/gpt-5.2-codex");
  });

  it("rejects malformed provider/model ids before discovery", () => {
    expect(() => requireOpenCodeModelId("gpt-5.2-codex")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
    expect(() => requireOpenCodeModelId("openai/")).toThrow(
      "OpenCode requires `adapterConfig.model`",
    );
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("Failed to start command");
  });

  it("skips the availability check when OPENCODE_ALLOW_ALL_MODELS is set in the run env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "anthropic/tensorix/deepseek/deepseek-chat-v3.1",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).resolves.toEqual([
      { id: "anthropic/tensorix/deepseek/deepseek-chat-v3.1", label: "anthropic/tensorix/deepseek/deepseek-chat-v3.1" },
    ]);
  });

  it("honours OPENCODE_ALLOW_ALL_MODELS from the process env", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    process.env.OPENCODE_ALLOW_ALL_MODELS = "1";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "anthropic/gateway/some-model" }),
    ).resolves.toEqual([{ id: "anthropic/gateway/some-model", label: "anthropic/gateway/some-model" }]);
  });

  it("still enforces provider/model format when OPENCODE_ALLOW_ALL_MODELS is set", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "not-a-valid-id",
        env: { OPENCODE_ALLOW_ALL_MODELS: "true" },
      }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  // XIP-4907 / XIP-4690: collapse a concurrent discovery herd onto one spawn.
  it("collapses N concurrent discoveries onto a single `opencode models` spawn (single-flight)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-opencode-models-singleflight-"));
    const counter = path.join(dir, "invocations.log");
    try {
      process.env.PAPERCLIP_OPENCODE_COMMAND = writeFakeOpenCode(dir, counter);

      const results = await Promise.all(
        Array.from({ length: 8 }, () => discoverOpenCodeModelsCached()),
      );

      // All 8 callers fired before the cache populated; single-flight must
      // dedupe them to exactly one underlying spawn.
      expect(countInvocations(counter)).toBe(1);
      for (const models of results) {
        expect(models.map((m) => m.id)).toEqual(["anthropic/claude-4", "openai/gpt-5"]);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // XIP-4907 / XIP-4690: the model list is per-binary/per-auth, not per-cwd, so
  // distinct researcher cwds must share one cache entry instead of re-enumerating.
  it("reuses the cache across different cwds (cwd excluded from the cache key)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-opencode-models-cachekey-"));
    const counter = path.join(dir, "invocations.log");
    try {
      process.env.PAPERCLIP_OPENCODE_COMMAND = writeFakeOpenCode(dir, counter, 0);

      const first = await discoverOpenCodeModelsCached({ cwd: dir });
      const second = await discoverOpenCodeModelsCached({ cwd: os.tmpdir() });

      expect(countInvocations(counter)).toBe(1);
      expect(first).toEqual(second);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // XIP-4907 / XIP-4690: the discovery timeout is operator-tunable via env.
  it("honours PAPERCLIP_OPENCODE_MODELS_TIMEOUT_MS for the discovery timeout", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-opencode-models-timeout-"));
    const counter = path.join(dir, "invocations.log");
    try {
      // Script sleeps ~1s; a 50ms timeout must trip before it prints any models.
      process.env.PAPERCLIP_OPENCODE_COMMAND = writeFakeOpenCode(dir, counter, 1);
      process.env.PAPERCLIP_OPENCODE_MODELS_TIMEOUT_MS = "50";

      await expect(
        ensureOpenCodeModelConfiguredAndAvailable({ model: "openai/gpt-5" }),
      ).rejects.toThrow("timed out after 0.05s");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
