import { describe, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { defineLocalAdapterExecuteContract } from "@paperclipai/adapter-utils/local-execute-contract-test";

const {
  mockRunChildProcess,
  mockEnsureCommandResolvable,
  mockListPaperclipSkillEntries,
  mockRemoveMaintainerOnlySkillSymlinks,
  mockEnsurePaperclipSkillSymlink,
} = vi.hoisted(() => ({
  mockRunChildProcess: vi.fn(),
  mockEnsureCommandResolvable: vi.fn(),
  mockListPaperclipSkillEntries: vi.fn(),
  mockRemoveMaintainerOnlySkillSymlinks: vi.fn(),
  mockEnsurePaperclipSkillSymlink: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess: mockRunChildProcess,
    ensureCommandResolvable: mockEnsureCommandResolvable,
    listPaperclipSkillEntries: mockListPaperclipSkillEntries,
    removeMaintainerOnlySkillSymlinks: mockRemoveMaintainerOnlySkillSymlinks,
    ensurePaperclipSkillSymlink: mockEnsurePaperclipSkillSymlink,
  };
});

vi.mock("./parse.js", () => ({
  parseCodexJsonl: () => ({
    sessionId: "thread-123",
    summary: "hello",
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    errorMessage: null,
  }),
  isCodexUnknownSessionError: () => false,
}));

import { execute } from "./execute.js";

function buildContext(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "CEO",
      adapterType: "codex_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "codex",
      model: "gpt-5.4",
    },
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
    authToken: "pcp-test-token",
    ...overrides,
  };
}

describe("codex execute", () => {
  defineLocalAdapterExecuteContract({
    label: "codex",
    execute,
    buildContext,
    defaultConfig: {
      command: "codex",
      model: "gpt-5.4",
    },
    configuredCwdConfig: (configuredCwd) => ({
      command: "codex",
      model: "gpt-5.4",
      cwd: configuredCwd,
    }),
    prepareMocks: async () => {
      mockEnsureCommandResolvable.mockResolvedValue(undefined);
      mockListPaperclipSkillEntries.mockResolvedValue([]);
      mockRemoveMaintainerOnlySkillSymlinks.mockResolvedValue([]);
      mockEnsurePaperclipSkillSymlink.mockResolvedValue("created");
      mockRunChildProcess.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
      });
    },
    getRunOptions: () => {
      const [, , , runOpts] = mockRunChildProcess.mock.calls[0];
      return runOpts;
    },
    getMeta: (onMeta) => {
      const metaCalls = onMeta.mock.calls as unknown as Array<[unknown]>;
      return metaCalls[0]?.[0] as { cwd?: string } | undefined;
    },
  });
});
