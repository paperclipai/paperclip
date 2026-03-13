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
  parseGeminiJsonl: () => ({
    sessionId: "gemini-session-123",
    summary: "hello",
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    errorMessage: null,
    resultJson: null,
    question: null,
  }),
  detectGeminiAuthRequired: () => ({ authRequired: false, authUrl: null }),
  isGeminiTurnLimitResult: () => false,
  isGeminiUnknownSessionError: () => false,
  describeGeminiFailure: () => "Gemini failed",
}));

import { execute } from "./execute.js";

function buildContext(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "CEO",
      adapterType: "gemini_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "gemini",
      model: "gemini-2.5-pro",
    },
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
    authToken: "pcp-test-token",
    ...overrides,
  };
}

describe("gemini execute", () => {
  defineLocalAdapterExecuteContract({
    label: "gemini",
    execute,
    buildContext,
    defaultConfig: {
      command: "gemini",
      model: "gemini-2.5-pro",
    },
    configuredCwdConfig: (configuredCwd) => ({
      command: "gemini",
      model: "gemini-2.5-pro",
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
