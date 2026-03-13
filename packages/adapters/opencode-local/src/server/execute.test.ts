import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { defineLocalAdapterExecuteContract } from "@paperclipai/adapter-utils/local-execute-contract-test";

const {
  mockRunChildProcess,
  mockEnsureCommandResolvable,
  mockEnsureOpenCodeModelConfiguredAndAvailable,
} = vi.hoisted(() => ({
  mockRunChildProcess: vi.fn(),
  mockEnsureCommandResolvable: vi.fn(),
  mockEnsureOpenCodeModelConfiguredAndAvailable: vi.fn(),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess: mockRunChildProcess,
    ensureCommandResolvable: mockEnsureCommandResolvable,
  };
});

vi.mock("./parse.js", () => ({
  parseOpenCodeJsonl: () => ({
    sessionId: "opencode-session-123",
    summary: "hello",
    usage: { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 },
    costUsd: 0,
    errorMessage: null,
  }),
  isOpenCodeUnknownSessionError: () => false,
}));

vi.mock("./models.js", () => ({
  ensureOpenCodeModelConfiguredAndAvailable: mockEnsureOpenCodeModelConfiguredAndAvailable,
}));

import { execute } from "./execute.js";

function buildContext(overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "CEO",
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
      model: "openai/gpt-5.4",
    },
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
    authToken: "pcp-test-token",
    ...overrides,
  };
}

describe("opencode execute", () => {
  defineLocalAdapterExecuteContract({
    label: "opencode",
    execute,
    buildContext,
    defaultConfig: {
      command: "opencode",
      model: "openai/gpt-5.4",
    },
    configuredCwdConfig: (configuredCwd) => ({
      command: "opencode",
      model: "openai/gpt-5.4",
      cwd: configuredCwd,
    }),
    prepareMocks: async () => {
      mockEnsureCommandResolvable.mockResolvedValue(undefined);
      mockEnsureOpenCodeModelConfiguredAndAvailable.mockResolvedValue([]);
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

  it("resolves relative instructionsFilePath from cwd for backwards compatibility", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-relative-instructions-"));
    try {
      const instructionsPath = path.join(tempDir, "AGENTS.md");
      await fs.writeFile(instructionsPath, "Follow the AGENTS instructions.", "utf8");
      mockEnsureCommandResolvable.mockResolvedValue(undefined);
      mockEnsureOpenCodeModelConfiguredAndAvailable.mockResolvedValue([]);
      mockRunChildProcess.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "",
      });

      await execute(
        buildContext({
          config: {
            command: "opencode",
            model: "openai/gpt-5.4",
            cwd: tempDir,
            instructionsFilePath: "AGENTS.md",
          },
        }),
      );

      const [, , , runOpts] = mockRunChildProcess.mock.calls[0];
      expect(runOpts.stdin).toContain("Follow the AGENTS instructions.");
      expect(runOpts.stdin).toContain(path.join(tempDir, "AGENTS.md"));
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
