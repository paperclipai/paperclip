import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { defineLocalAdapterExecuteContract } from "@paperclipai/adapter-utils/local-execute-contract-test";

const {
  mockRunChildProcess,
  mockEnsureCommandResolvable,
  mockListPaperclipSkillEntries,
  mockRemoveMaintainerOnlySkillSymlinks,
  mockEnsurePiModelConfiguredAndAvailable,
} = vi.hoisted(() => ({
  mockRunChildProcess: vi.fn(),
  mockEnsureCommandResolvable: vi.fn(),
  mockListPaperclipSkillEntries: vi.fn(),
  mockRemoveMaintainerOnlySkillSymlinks: vi.fn(),
  mockEnsurePiModelConfiguredAndAvailable: vi.fn(),
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
  };
});

vi.mock("./models.js", () => ({
  ensurePiModelConfiguredAndAvailable: mockEnsurePiModelConfiguredAndAvailable,
}));

import { execute } from "./execute.js";

function buildContext(
  overrides: Partial<AdapterExecutionContext> = {},
): AdapterExecutionContext {
  return {
    runId: "run-123",
    agent: {
      id: "agent-123",
      companyId: "company-123",
      name: "CEO",
      adapterType: "pi_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "pi",
      model: "openai-codex/gpt-5.4",
    },
    context: {},
    onLog: async () => {},
    onMeta: async () => {},
    authToken: "pcp-test-token",
    ...overrides,
  };
}

describe("pi execute", () => {
  defineLocalAdapterExecuteContract({
    label: "pi",
    execute,
    buildContext,
    defaultConfig: {
      command: "pi",
      model: "openai-codex/gpt-5.4",
    },
    configuredCwdConfig: (configuredCwd) => ({
      command: "pi",
      model: "openai-codex/gpt-5.4",
      cwd: configuredCwd,
    }),
    prepareMocks: async () => {
      mockEnsureCommandResolvable.mockResolvedValue(undefined);
      mockListPaperclipSkillEntries.mockResolvedValue([]);
      mockRemoveMaintainerOnlySkillSymlinks.mockResolvedValue([]);
      mockEnsurePiModelConfiguredAndAvailable.mockResolvedValue([]);
      mockRunChildProcess.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "agent_start" }),
          JSON.stringify({
            type: "turn_end",
            message: { role: "assistant", content: "hello" },
          }),
          JSON.stringify({ type: "agent_end", messages: [] }),
        ].join("\n"),
        stderr: "",
      });
    },
    getRunOptions: () => {
      const [, , , runOpts] = mockRunChildProcess.mock.calls[0];
      return runOpts;
    },
    getMeta: (onMeta) => {
      const metaCalls = onMeta.mock.calls as unknown as Array<[unknown]>;
      const meta = (metaCalls[0]?.[0] ?? undefined) as
        | { cwd?: string; commandArgs?: string[] }
        | undefined;
      return meta;
    },
  });

  it("stores new session files under the active workspace instead of the home directory", async () => {
    const cwd = path.join(process.cwd(), ".tmp-pi-session-test");
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.mkdir(cwd, { recursive: true });
    try {
      mockEnsureCommandResolvable.mockResolvedValue(undefined);
      mockListPaperclipSkillEntries.mockResolvedValue([]);
      mockRemoveMaintainerOnlySkillSymlinks.mockResolvedValue([]);
      mockEnsurePiModelConfiguredAndAvailable.mockResolvedValue([]);
      mockRunChildProcess.mockResolvedValue({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "agent_start" }),
          JSON.stringify({ type: "turn_end", message: { role: "assistant", content: "hello" } }),
          JSON.stringify({ type: "agent_end", messages: [] }),
        ].join("\n"),
        stderr: "",
      });

      await execute(
        buildContext({
          config: {
            command: "pi",
            model: "openai-codex/gpt-5.4",
            cwd,
          },
        }),
      );

      const [, , args] = mockRunChildProcess.mock.calls[0];
      const sessionFlagIndex = args.indexOf("--session");
      expect(sessionFlagIndex).toBeGreaterThanOrEqual(0);
      const sessionPath = args[sessionFlagIndex + 1] as string;
      expect(sessionPath.startsWith(path.join(cwd, ".paperclip", "pi", "sessions"))).toBe(true);
      expect(sessionPath.includes(`${path.sep}.pi${path.sep}paperclips${path.sep}`)).toBe(false);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});
