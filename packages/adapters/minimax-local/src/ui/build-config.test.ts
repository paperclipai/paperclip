import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { DEFAULT_MINIMAX_SECRET_ID } from "../index.js";
import { buildMiniMaxLocalConfig } from "./build-config.js";

function makeValues(overrides: Partial<CreateConfigValues> = {}): CreateConfigValues {
  return {
    adapterType: "minimax_local",
    cwd: "/paperclip/instances/default/workspaces/agent-1",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: true,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {
      MINIMAX_API_KEY: { type: "secret_ref", secretId: DEFAULT_MINIMAX_SECRET_ID, version: "latest" },
    },
    url: "",
    bootstrapPrompt: "",
    maxTurnsPerRun: 1000,
    heartbeatEnabled: false,
    intervalSec: 300,
    ...overrides,
  };
}

describe("buildMiniMaxLocalConfig", () => {
  it("applies defaults and preserves secret refs", () => {
    const config = buildMiniMaxLocalConfig(makeValues());

    expect(config).toMatchObject({
      model: "MiniMax-M3",
      primaryModel: "MiniMax-M3",
      baseUrl: "https://api.minimax.io/v1",
      temperature: 0.2,
      max_completion_tokens: 2048,
      stripThink: true,
      cwd: "/paperclip/instances/default/workspaces/agent-1",
      workingDirectory: "/paperclip/instances/default/workspaces/agent-1",
    });
    expect(config.env).toEqual({
      MINIMAX_API_KEY: {
        type: "secret_ref",
        secretId: DEFAULT_MINIMAX_SECRET_ID,
        version: "latest",
      },
    });
  });
});
