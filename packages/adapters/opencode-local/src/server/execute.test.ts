import { beforeEach, describe, expect, it, vi } from "vitest";

let lastRunChildProcessCall: {
  cwd: string;
  env: Record<string, string>;
} | null = null;

vi.mock("@paperclipai/adapter-utils", () => ({
  inferOpenAiCompatibleBiller: () => null,
}));

vi.mock("@paperclipai/adapter-utils/server-utils", () => ({
  asString: (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback),
  asNumber: (value: unknown, fallback = 0) => (typeof value === "number" ? value : fallback),
  asStringArray: (value: unknown) =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [],
  parseObject: (value: unknown) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {},
  buildPaperclipEnv: () => ({}),
  joinPromptSections: (sections: string[]) => sections.filter(Boolean).join("\n\n"),
  buildInvocationEnvForLogs: () => ({}),
  ensureAbsoluteDirectory: vi.fn(async () => {}),
  ensureCommandResolvable: vi.fn(async () => {}),
  ensurePaperclipSkillSymlink: vi.fn(async () => "skipped"),
  ensurePathInEnv: (env: Record<string, string>) => env,
  resolveCommandForLogs: vi.fn(async (command: string) => command),
  renderTemplate: (template: string) => template,
  renderPaperclipWakePrompt: () => "",
  stringifyPaperclipWakePayload: () => "",
  runChildProcess: vi.fn(async (_runId: string, _command: string, _args: string[], opts: {
    cwd: string;
    env: Record<string, string>;
  }) => {
    lastRunChildProcessCall = { cwd: opts.cwd, env: opts.env };
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "",
    };
  }),
  readPaperclipRuntimeSkillEntries: vi.fn(async () => []),
  resolvePaperclipDesiredSkillNames: vi.fn(() => []),
  removeMaintainerOnlySkillSymlinks: vi.fn(async () => []),
}));

vi.mock("./models.js", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: vi.fn(async () => {}),
}));

vi.mock("./runtime-config.js", () => ({
  prepareOpenCodeRuntimeConfig: vi.fn(async ({ env }: { env: Record<string, string> }) => ({
    env,
    notes: [],
    cleanup: async () => {},
  })),
}));

vi.mock("./parse.js", () => ({
  parseOpenCodeJsonl: vi.fn(() => ({
    sessionId: null,
    summary: "",
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
    },
    costUsd: 0,
    errorMessage: null,
  })),
  isOpenCodeUnknownSessionError: vi.fn(() => false),
}));

import { execute } from "./execute.js";

describe("opencode_local execute cwd selection", () => {
  beforeEach(() => {
    lastRunChildProcessCall = null;
  });

  it("uses the Paperclip-resolved agent_home workspace before legacy adapter cwd", async () => {
    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Agent",
        adapterType: "opencode_local",
        adapterConfig: null,
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "opencode",
        model: "ollama/glm-4.7:cloud",
        cwd: "/legacy/home-root",
      },
      context: {
        taskId: "issue-1",
        paperclipWorkspace: {
          cwd: "/paperclip/fallback-workspace",
          source: "agent_home",
        },
      },
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "token-1",
    });

    expect(lastRunChildProcessCall).not.toBeNull();
    expect(lastRunChildProcessCall?.cwd).toBe("/paperclip/fallback-workspace");
    expect(lastRunChildProcessCall?.env.PAPERCLIP_WORKSPACE_CWD).toBe("/paperclip/fallback-workspace");
  });

  it("falls back to adapter cwd when Paperclip did not resolve a workspace", async () => {
    await execute({
      runId: "run-2",
      agent: {
        id: "agent-2",
        companyId: "company-1",
        name: "OpenCode Agent",
        adapterType: "opencode_local",
        adapterConfig: null,
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: {
        command: "opencode",
        model: "ollama/glm-4.7:cloud",
        cwd: "/legacy/home-root",
      },
      context: {
        taskId: "issue-2",
        paperclipWorkspace: {
          source: "agent_home",
        },
      },
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "token-2",
    });

    expect(lastRunChildProcessCall).not.toBeNull();
    expect(lastRunChildProcessCall?.cwd).toBe("/legacy/home-root");
    expect(lastRunChildProcessCall?.env.PAPERCLIP_WORKSPACE_CWD).toBeUndefined();
  });
});
