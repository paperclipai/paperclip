import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  resetOpenCodeModelsCacheForTests,
} from "./models.js";

async function createOpenCodeFixture(scriptBody: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-models-"));
  const commandPath = path.join(dir, "opencode-fixture");
  await fs.writeFile(
    commandPath,
    `#!/usr/bin/env bash
set -euo pipefail
${scriptBody}
`,
    { mode: 0o755 },
  );
  await fs.chmod(commandPath, 0o755);
  return commandPath;
}

describe("openCode models", () => {
  const tempDirs = new Set<string>();
  let currentTime = new Date("2026-03-31T00:00:00.000Z").valueOf();

  beforeEach(() => {
    currentTime = new Date("2026-03-31T00:00:00.000Z").valueOf();
    vi.spyOn(Date, "now").mockImplementation(() => currentTime);
  });

  afterEach(async () => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    delete process.env.PAPERCLIP_SKIP_MODEL_VALIDATION;
    resetOpenCodeModelsCacheForTests();
    vi.doUnmock("@paperclipai/adapter-utils/server-utils");
    vi.resetModules();
    vi.restoreAllMocks();

    await Promise.all(
      Array.from(tempDirs, (dir) => fs.rm(dir, { recursive: true, force: true })),
    );
    tempDirs.clear();
  });

  async function registerFixture(scriptBody: string): Promise<string> {
    const commandPath = await createOpenCodeFixture(scriptBody);
    tempDirs.add(path.dirname(commandPath));
    return commandPath;
  }

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(listOpenCodeModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("OpenCode requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("Failed to start command");
  });

  it("skips validation when PAPERCLIP_SKIP_MODEL_VALIDATION is set", async () => {
    process.env.PAPERCLIP_SKIP_MODEL_VALIDATION = "true";
    process.env.PAPERCLIP_OPENCODE_COMMAND = "__paperclip_missing_opencode_command__";

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).resolves.toEqual([]);
  });

  it("caches successful validations for 24 hours and expires them", async () => {
    const command = await registerFixture(`
if [[ "\${1:-}" != "models" ]]; then
  exit 1
fi
printf 'openai/gpt-5\\n'
`);

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
        command,
      }),
    ).resolves.toEqual([{ id: "openai/gpt-5", label: "openai/gpt-5" }]);

    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
        command: "__paperclip_missing_opencode_command__",
      }),
    ).resolves.toEqual([]);

    currentTime = new Date("2026-03-31T23:59:59.999Z").valueOf();
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
        command: "__paperclip_missing_opencode_command__",
      }),
    ).resolves.toEqual([]);

    currentTime = new Date("2026-04-01T00:00:00.000Z").valueOf();
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
        command: "__paperclip_missing_opencode_command__",
      }),
    ).rejects.toThrow("Failed to start command");
  });

  it("clears both caches on reset", async () => {
    const command = await registerFixture(`
if [[ "\${1:-}" != "models" ]]; then
  exit 1
fi
printf 'openai/gpt-5\\n'
`);
    process.env.PAPERCLIP_OPENCODE_COMMAND = command;

    await expect(listOpenCodeModels()).resolves.toEqual([
      { id: "openai/gpt-5", label: "openai/gpt-5" },
    ]);
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).resolves.toEqual([{ id: "openai/gpt-5", label: "openai/gpt-5" }]);

    await fs.rm(command, { force: true });

    await expect(listOpenCodeModels()).resolves.toEqual([
      { id: "openai/gpt-5", label: "openai/gpt-5" },
    ]);
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).resolves.toEqual([]);

    resetOpenCodeModelsCacheForTests();

    await expect(listOpenCodeModels()).resolves.toEqual([]);
    await expect(
      ensureOpenCodeModelConfiguredAndAvailable({
        model: "openai/gpt-5",
      }),
    ).rejects.toThrow("Failed to start command");
  });

  it("surfaces a timeout instead of model unavailable when discovery is partial", async () => {
    vi.doMock("@paperclipai/adapter-utils/server-utils", async () => {
      const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
        "@paperclipai/adapter-utils/server-utils",
      );
      return {
        ...actual,
        runChildProcess: vi.fn().mockResolvedValue({
          exitCode: null,
          signal: "SIGTERM",
          timedOut: true,
          stdout: "anthropic/claude-sonnet-4\nopenai/gpt-5\n",
          stderr: "",
          pid: 123,
          startedAt: new Date().toISOString(),
        }),
      };
    });

    const { ensureOpenCodeModelConfiguredAndAvailable: ensureModel } = await import("./models.js");

    await expect(
      ensureModel({
        model: "openrouter/xiaomi/mimo-v2-pro",
      }),
    ).rejects.toThrow(
      "timed out after 60s before confirming availability of openrouter/xiaomi/mimo-v2-pro",
    );
  });
});
