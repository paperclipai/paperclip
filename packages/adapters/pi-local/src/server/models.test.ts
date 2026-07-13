import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverPiModelsCached,
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  piModelsCacheSizeForTests,
  resetPiModelsCacheForTests,
} from "./models.js";

async function writeExecutable(directory: string, source: string): Promise<string> {
  const command = path.join(directory, "fake-pi");
  await writeFile(command, `#!/bin/sh\n${source}`);
  await chmod(command, 0o755);
  return command;
}

describe("pi models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    resetPiModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });

  it("coalesces concurrent refreshes for the same workspace", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paperclip-pi-models-"));
    try {
      const calls = path.join(directory, "calls");
      const command = await writeExecutable(
        directory,
        `[ -z "$PAPERCLIP_RUN_ID" ] || exit 2\nprintf x >> "${calls}"\nprintf 'provider  model\\nbridge  claude-opus-4-8\\n'\n`,
      );

      await Promise.all([
        discoverPiModelsCached({ command, cwd: directory, env: { PAPERCLIP_RUN_ID: "first" } }),
        discoverPiModelsCached({ command, cwd: directory, env: { PAPERCLIP_RUN_ID: "second" } }),
      ]);

      await expect(readFile(calls, "utf8")).resolves.toBe("x");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("uses the last successful model list when a refresh fails", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paperclip-pi-models-"));
    const now = vi.spyOn(Date, "now");
    try {
      const failureMarker = path.join(directory, "fail");
      const command = await writeExecutable(
        directory,
        `if [ -f "${failureMarker}" ]; then echo refresh-failed >&2; exit 1; fi\ntouch "${failureMarker}"\nprintf 'provider  model\\nbridge  claude-opus-4-8\\n'\n`,
      );
      now.mockReturnValue(1_000);
      await expect(discoverPiModelsCached({ command })).resolves.toEqual([
        { id: "bridge/claude-opus-4-8", label: "bridge/claude-opus-4-8" },
      ]);

      now.mockReturnValue(301_001);
      await expect(discoverPiModelsCached({ command })).resolves.toEqual([
        { id: "bridge/claude-opus-4-8", label: "bridge/claude-opus-4-8" },
      ]);

      now.mockReturnValue(86_401_001);
      await expect(discoverPiModelsCached({ command })).rejects.toThrow("refresh-failed");
    } finally {
      now.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps model registries scoped to their workspace", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paperclip-pi-models-"));
    try {
      const firstWorkspace = path.join(directory, "first");
      const secondWorkspace = path.join(directory, "second");
      await Promise.all([mkdir(firstWorkspace), mkdir(secondWorkspace)]);
      const command = await writeExecutable(
        directory,
        "printf 'provider  model\\nbridge  %s\\n' \"$(basename \"$(pwd)\")\"\n",
      );

      await expect(discoverPiModelsCached({ command, cwd: firstWorkspace })).resolves.toEqual([
        { id: "bridge/first", label: "bridge/first" },
      ]);
      await expect(discoverPiModelsCached({ command, cwd: secondWorkspace })).resolves.toEqual([
        { id: "bridge/second", label: "bridge/second" },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("parses stdout when a successful discovery also emits a warning", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paperclip-pi-models-"));
    try {
      const command = await writeExecutable(
        directory,
        "echo model-load-warning >&2\nprintf 'provider  model\\nbridge  claude-opus-4-8\\n'\n",
      );

      await expect(discoverPiModelsCached({ command })).resolves.toEqual([
        { id: "bridge/claude-opus-4-8", label: "bridge/claude-opus-4-8" },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("separates model registries with different effective environments", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paperclip-pi-models-"));
    const previousProviders = process.env.PAPERCLIP_PI_PROVIDERS;
    try {
      const calls = path.join(directory, "calls");
      const command = await writeExecutable(
        directory,
        `printf x >> "${calls}"\nprintf 'provider  model\\nbridge  claude-opus-4-8\\n'\n`,
      );

      process.env.PAPERCLIP_PI_PROVIDERS = "first";
      await discoverPiModelsCached({ command });
      process.env.PAPERCLIP_PI_PROVIDERS = "second";
      await discoverPiModelsCached({ command });

      await expect(readFile(calls, "utf8")).resolves.toBe("xx");
    } finally {
      if (previousProviders === undefined) delete process.env.PAPERCLIP_PI_PROVIDERS;
      else process.env.PAPERCLIP_PI_PROVIDERS = previousProviders;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("bounds retained discovery environments", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "paperclip-pi-models-"));
    try {
      const command = await writeExecutable(
        directory,
        "printf 'provider  model\\nbridge  claude-opus-4-8\\n'\n",
      );
      for (let index = 0; index < 65; index += 1) {
        await discoverPiModelsCached({ command, env: { PAPERCLIP_PI_PROVIDERS: String(index) } });
      }

      expect(piModelsCacheSizeForTests()).toBe(64);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
