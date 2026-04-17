import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("uses the Paperclip-resolved agent_home workspace before legacy adapter cwd", async () => {
    await execute({
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "OpenCode Agent",
        adapterType: "opencode_local",
        adapterConfig: {},
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
        useDirectOllamaApi: false,
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
        adapterConfig: {},
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
        useDirectOllamaApi: false,
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

  it("uses the direct Ollama API by default for ollama provider models", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          response: "hello",
          prompt_eval_count: 7,
          eval_count: 3,
        }),
    }));
    vi.stubGlobal("fetch", fetchMock);

    const logs: string[] = [];
    const result = await execute({
      runId: "run-3",
      agent: {
        id: "agent-3",
        companyId: "company-1",
        name: "OpenCode Agent",
        adapterType: "opencode_local",
        adapterConfig: {},
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
        ollamaApiBaseUrl: "http://127.0.0.1:11434",
      },
      context: {
        taskId: "issue-3",
        paperclipWorkspace: {
          cwd: "/paperclip/fallback-workspace",
          source: "agent_home",
        },
      },
      onLog: async (_stream, chunk) => {
        logs.push(chunk);
      },
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "token-3",
    });

    expect(lastRunChildProcessCall).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:11434/api/generate",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"model":"glm-4.7:cloud"'),
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.provider).toBe("ollama");
    expect(result.model).toBe("ollama/glm-4.7:cloud");
    expect(result.summary).toBe("hello");
    expect(result.usage).toEqual({ inputTokens: 7, outputTokens: 3, cachedInputTokens: 0 });
    expect(logs.join("")).toContain("hello");
  });

  it("records bound direct Ollama issues as in review for Codex peer review", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/api/generate")) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ response: "security review notes" }),
        };
      }
      if (url.endsWith("/api/issues/issue-4")) {
        return {
          ok: true,
          status: 200,
          text: async () => "{}",
        };
      }
      throw new Error(`unexpected fetch ${url} ${init?.method ?? ""}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await execute({
      runId: "run-4",
      agent: {
        id: "agent-4",
        companyId: "company-1",
        name: "Ollama Agent",
        adapterType: "opencode_local",
        adapterConfig: {},
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
        ollamaApiBaseUrl: "http://127.0.0.1:11434",
        env: {
          PAPERCLIP_API_URL: "http://paperclip.local",
        },
      },
      context: {
        issueId: "issue-4",
        paperclipWorkspace: {
          cwd: "/paperclip/fallback-workspace",
          source: "agent_home",
        },
      },
      onLog: async () => {},
      onMeta: async () => {},
      onSpawn: async () => {},
      authToken: "token-4",
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(
      "http://paperclip.local/api/issues/issue-4",
      expect.objectContaining({
        method: "PATCH",
        body: expect.stringContaining('"status":"in_review"'),
      }),
    );
    const updateBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body ?? "{}"));
    expect(updateBody.comment).toContain("Codex peer review");
  });
});
