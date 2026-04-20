import { afterEach, describe, expect, it, vi } from "vitest";
import {
  resetCopilotModelsCacheForTests,
  setCopilotClientFactoryForTests,
} from "./index.js";
import { DEFAULT_COPILOT_LOCAL_MODEL } from "../index.js";
import { detectCopilotModel, listCopilotModels } from "./models.js";

afterEach(() => {
  setCopilotClientFactoryForTests(null);
  resetCopilotModelsCacheForTests();
  vi.restoreAllMocks();
});

describe("copilot model discovery", () => {
  it("caches discovered models between calls", async () => {
    const listModels = vi.fn(async () => [
      { id: DEFAULT_COPILOT_LOCAL_MODEL, name: "GPT 5.4" },
      { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
    ]);
    const start = vi.fn(async () => {});
    const stop = vi.fn(async () => []);

    setCopilotClientFactoryForTests(() => ({
      start,
      stop,
      forceStop: async () => {},
      ping: async () => ({ message: "ok", timestamp: Date.now() }),
      getStatus: async () => ({ version: "1.0.0", protocolVersion: 1 }),
      getAuthStatus: async () => ({ isAuthenticated: true }),
      listModels,
      createSession: async () => {
        throw new Error("createSession should not be used");
      },
      resumeSession: async () => {
        throw new Error("resumeSession should not be used");
      },
    }) as never);

    const first = await listCopilotModels();
    const second = await listCopilotModels();

    expect(first).toEqual(second);
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("prefers the default Copilot model when detecting a selected model", async () => {
    setCopilotClientFactoryForTests(() => ({
      start: async () => {},
      stop: async () => [],
      forceStop: async () => {},
      ping: async () => ({ message: "ok", timestamp: Date.now() }),
      getStatus: async () => ({ version: "1.0.0", protocolVersion: 1 }),
      getAuthStatus: async () => ({ isAuthenticated: true }),
      listModels: async () => [
        { id: "claude-sonnet-4", name: "Claude Sonnet 4" },
        { id: DEFAULT_COPILOT_LOCAL_MODEL, name: "GPT 5.4" },
      ],
      createSession: async () => {
        throw new Error("createSession should not be used");
      },
      resumeSession: async () => {
        throw new Error("resumeSession should not be used");
      },
    }) as never);

    const detected = await detectCopilotModel();

    expect(detected).toEqual({
      model: DEFAULT_COPILOT_LOCAL_MODEL,
      provider: "github",
      source: "copilot-sdk",
      candidates: ["claude-sonnet-4", DEFAULT_COPILOT_LOCAL_MODEL],
    });
  });
});
