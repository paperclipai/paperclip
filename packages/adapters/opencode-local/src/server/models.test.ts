import { mkdtempSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  discoverOpenCodeModels,
  discoverOpenCodeModelsCached,
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

// Creates a fake `opencode` executable that records each invocation (one line
// per spawn appended to `counterFile`), optionally sleeps `sleepSec`, then
// prints a fixed two-model listing. Returns the script path.
function makeFakeOpenCode(opts: { counterFile: string; sleepSec?: number }): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "fake-opencode-"));
  const script = path.join(dir, "opencode");
  const sleep = opts.sleepSec ? `sleep ${opts.sleepSec}` : "true";
  writeFileSync(
    script,
    `#!/usr/bin/env bash\necho "$$" >> "${opts.counterFile}"\n${sleep}\n` +
      `echo "anthropic/claude-x"\necho "openai/gpt-x"\n`,
    "utf8",
  );
  chmodSync(script, 0o755);
  return script;
}

function spawnCount(counterFile: string): number {
  if (!existsSync(counterFile)) return 0;
  return readFileSync(counterFile, "utf8").split("\n").filter((l) => l.trim()).length;
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

  // XIP-4690 Fix 2a: single-flight collapses concurrent cold-cache lookups to one spawn.
  it("single-flights concurrent discovery into a single `opencode models` spawn", async () => {
    const counterFile = path.join(mkdtempSync(path.join(os.tmpdir(), "oc-count-")), "count");
    const cmd = makeFakeOpenCode({ counterFile, sleepSec: 1 });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => discoverOpenCodeModelsCached({ command: cmd })),
    );

    expect(spawnCount(counterFile)).toBe(1);
    for (const r of results) {
      expect(r).toEqual([
        { id: "anthropic/claude-x", label: "anthropic/claude-x" },
        { id: "openai/gpt-x", label: "openai/gpt-x" },
      ]);
    }
  }, 20_000);

  // XIP-4690 Fix 2b: cache key ignores cwd, so different researcher cwds share a cached result.
  it("reuses the cached model list across different cwds (cwd not part of cache key)", async () => {
    const counterFile = path.join(mkdtempSync(path.join(os.tmpdir(), "oc-count-")), "count");
    const cmd = makeFakeOpenCode({ counterFile });

    const a = await discoverOpenCodeModelsCached({ command: cmd, cwd: os.tmpdir() });
    const b = await discoverOpenCodeModelsCached({ command: cmd, cwd: process.cwd() });

    expect(spawnCount(counterFile)).toBe(1);
    expect(a).toEqual(b);
  }, 20_000);

  // XIP-4690 Fix 2c: the enumeration timeout is configurable via env.
  it("honours PAPERCLIP_OPENCODE_MODELS_TIMEOUT_MS for the enumeration timeout", async () => {
    const counterFile = path.join(mkdtempSync(path.join(os.tmpdir(), "oc-count-")), "count");
    const cmd = makeFakeOpenCode({ counterFile, sleepSec: 5 });
    process.env.PAPERCLIP_OPENCODE_MODELS_TIMEOUT_MS = "1000";

    await expect(discoverOpenCodeModels({ command: cmd })).rejects.toThrow(
      "`opencode models` timed out after 1s.",
    );
  }, 20_000);
});
