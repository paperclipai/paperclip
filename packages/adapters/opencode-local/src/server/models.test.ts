import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ensureOpenCodeModelConfiguredAndAvailable,
  listOpenCodeModels,
  requireOpenCodeModelId,
  resetOpenCodeModelsCacheForTests,
  discoverOpenCodeModelsCached,
} from "./models.js";

const runChildProcess = vi.hoisted(() =>
  vi.fn(async (_runId: string, command: string, args: string[], opts: { cwd: string; env: Record<string, string> }) => {
    if (command === "__paperclip_missing_opencode_command__") {
      const pathValue = opts.env.PATH ?? "";
      throw new Error(
        `Failed to start command "${command}" in "${opts.cwd}". Verify adapter command, working directory, and PATH (${pathValue}).`,
      );
    }
    if (args.includes("models")) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "openai/gpt-5.2-codex\n",
        stderr: "",
        pid: 123,
        startedAt: new Date().toISOString(),
      };
    }
    throw new Error("Unexpected command");
  }),
);

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual("@paperclipai/adapter-utils/server-utils");
  return {
    ...actual,
    runChildProcess,
  };
});

describe("openCode models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_OPENCODE_COMMAND;
    resetOpenCodeModelsCacheForTests();
    runChildProcess.mockClear();
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

  it("deduplicates concurrent discovery calls for the same cache key", async () => {
    runChildProcess.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "openai/gpt-5.2-codex\n",
      stderr: "",
      pid: 123,
      startedAt: new Date().toISOString(),
    });

    const [result1, result2] = await Promise.all([
      discoverOpenCodeModelsCached(),
      discoverOpenCodeModelsCached(),
    ]);

    expect(runChildProcess).toHaveBeenCalledTimes(1);
    expect(result1).toEqual([{ id: "openai/gpt-5.2-codex", label: "openai/gpt-5.2-codex" }]);
    expect(result2).toEqual(result1);
  });
});
