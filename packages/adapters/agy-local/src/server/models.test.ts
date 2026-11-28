import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";
import {
  listAgyModels,
  parseAgyModelsOutput,
  refreshAgyModels,
  resetAgyModelsCacheForTests,
} from "./models.js";

describe("parseAgyModelsOutput", () => {
  it("parses model id and label correctly", () => {
    const rawOutput = `
⠋ Fetching available models...⠙ Fetching available models...gemini-3.7-flash-high     Gemini 3.7 Flash (High)
gemini-3.7-flash-medium   Gemini 3.7 Flash (Medium)
gemini-3.7-flash-low      Gemini 3.7 Flash (Low)
gemini-3.6-flash-high     Gemini 3.6 Flash (High)
claude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)
gpt-oss-120b-medium       GPT-OSS 120B (Medium)
`;
    const models = parseAgyModelsOutput(rawOutput);
    expect(models).toEqual([
      { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
      { id: "gemini-3.7-flash-medium", label: "Gemini 3.7 Flash (Medium)" },
      { id: "gemini-3.7-flash-low", label: "Gemini 3.7 Flash (Low)" },
      { id: "gemini-3.6-flash-high", label: "Gemini 3.6 Flash (High)" },
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
      { id: "gpt-oss-120b-medium", label: "GPT-OSS 120B (Medium)" },
    ]);
  });
});

describe("listAgyModels caching", () => {
  afterEach(() => {
    resetAgyModelsCacheForTests();
    vi.restoreAllMocks();
  });

  async function fakeAgyCommand(delaySec = 0): Promise<{ directory: string; command: string }> {
    const directory = await mkdtemp(join(tmpdir(), "paperclip-agy-models-"));
    const command = join(directory, "agy");
    await writeFile(
      command,
      `#!/bin/sh\n${delaySec > 0 ? `sleep ${delaySec}\n` : ""}printf 'gemini-3.7-flash-high     Gemini 3.7 Flash (High)\\nclaude-sonnet-4-6         Claude Sonnet 4.6 (Thinking)\\n'\n`,
    );
    await chmod(command, 0o755);
    return { directory, command };
  }

  it("serves repeated reads from the cache without spawning again", async () => {
    const { directory, command } = await fakeAgyCommand();
    const spy = vi.spyOn(serverUtils, "runChildProcess");
    try {
      const first = await listAgyModels(command);
      const second = await listAgyModels(command);
      expect(first).toEqual([
        { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
      ]);
      expect(second).toEqual(first);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("shares one spawn across concurrent reads", async () => {
    const { directory, command } = await fakeAgyCommand();
    const spy = vi.spyOn(serverUtils, "runChildProcess");
    try {
      const [first, second] = await Promise.all([listAgyModels(command), listAgyModels(command)]);
      expect(first).toEqual(second);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refresh shares the in-flight lookup instead of starting a second spawn", async () => {
    const { directory, command } = await fakeAgyCommand(0.3);
    const spy = vi.spyOn(serverUtils, "runChildProcess");
    try {
      const listPromise = listAgyModels(command);
      const refreshPromise = refreshAgyModels(command);
      const [listed, refreshed] = await Promise.all([listPromise, refreshPromise]);
      expect(listed).toEqual(refreshed);
      expect(listed).toEqual([
        { id: "gemini-3.7-flash-high", label: "Gemini 3.7 Flash (High)" },
        { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (Thinking)" },
      ]);
      // One spawn total: the refresh joined the lookup already in flight
      // instead of starting its own, so the slower older lookup cannot
      // finish afterward and overwrite the refreshed list.
      expect(spy).toHaveBeenCalledTimes(1);
      await listAgyModels(command);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("re-discovers after the TTL expires", async () => {
    const { directory, command } = await fakeAgyCommand();
    const spy = vi.spyOn(serverUtils, "runChildProcess");
    vi.useFakeTimers();
    try {
      await listAgyModels(command);
      expect(spy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(61_000);
      await listAgyModels(command);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("refresh re-runs discovery and repopulates the cache", async () => {
    const { directory, command } = await fakeAgyCommand();
    const spy = vi.spyOn(serverUtils, "runChildProcess");
    try {
      await listAgyModels(command);
      expect(spy).toHaveBeenCalledTimes(1);
      await refreshAgyModels(command);
      expect(spy).toHaveBeenCalledTimes(2);
      await listAgyModels(command);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
