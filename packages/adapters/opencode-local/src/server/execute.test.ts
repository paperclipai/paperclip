import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const {
  runChildProcessMock,
  ensureOpenCodeAgentConfiguredAndAvailableMock,
  ensureOpenCodeModelConfiguredAndAvailableMock,
  resolveConfiguredOpenCodeAgentModelMock,
  hydrateLiteLlmApiKeyMock,
} = vi.hoisted(() => ({
  runChildProcessMock: vi.fn(),
  ensureOpenCodeAgentConfiguredAndAvailableMock: vi.fn(),
  ensureOpenCodeModelConfiguredAndAvailableMock: vi.fn(),
  resolveConfiguredOpenCodeAgentModelMock: vi.fn(async (): Promise<string | null> => null),
  hydrateLiteLlmApiKeyMock: vi.fn(async (env: Record<string, string>) => ({
    env,
    source: "existing_litellm_env" as const,
  })),
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    ensureAbsoluteDirectory: vi.fn().mockResolvedValue(undefined),
    ensureCommandResolvable: vi.fn().mockResolvedValue(undefined),
    runChildProcess: runChildProcessMock,
  };
});

vi.mock("./models.js", () => ({
  ensureOpenCodeAgentConfiguredAndAvailable: ensureOpenCodeAgentConfiguredAndAvailableMock,
  ensureOpenCodeModelConfiguredAndAvailable: ensureOpenCodeModelConfiguredAndAvailableMock,
  resolveConfiguredOpenCodeAgentModel: resolveConfiguredOpenCodeAgentModelMock,
  resolveOpenCodeCommand: vi.fn((input: unknown) =>
    typeof input === "string" && input.trim().length > 0 ? input.trim() : "opencode"
  ),
}));

vi.mock("./auth.js", async () => {
  const actual = await vi.importActual<typeof import("./auth.js")>("./auth.js");
  return {
    ...actual,
    hydrateLiteLlmApiKey: hydrateLiteLlmApiKeyMock,
  };
});

import { execute } from "./execute.js";

function buildStdout(sessionId: string) {
  return [
    JSON.stringify({
      type: "text",
      sessionID: sessionId,
      part: { text: "completed task" },
    }),
    JSON.stringify({
      type: "step_finish",
      sessionID: sessionId,
      part: {
        cost: 0,
        tokens: {
          input: 12,
          output: 4,
          reasoning: 0,
          cache: { read: 0 },
        },
      },
    }),
  ].join("\n");
}

describe("execute", () => {
  let tempRoot: string;
  let instructionsPath: string;

  beforeEach(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-execute-"));
    instructionsPath = path.join(tempRoot, "AGENTS.md");
    await fs.writeFile(instructionsPath, "# Test Agent\n\nFollow the task.\n", "utf8");
    vi.spyOn(os, "homedir").mockReturnValue(tempRoot);
    runChildProcessMock.mockReset();
    ensureOpenCodeAgentConfiguredAndAvailableMock.mockReset();
    ensureOpenCodeModelConfiguredAndAvailableMock.mockReset();
    resolveConfiguredOpenCodeAgentModelMock.mockReset();
    hydrateLiteLlmApiKeyMock.mockClear();
    ensureOpenCodeAgentConfiguredAndAvailableMock.mockResolvedValue(undefined);
    ensureOpenCodeModelConfiguredAndAvailableMock.mockResolvedValue(undefined);
    resolveConfiguredOpenCodeAgentModelMock.mockResolvedValue(null);
    runChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: buildStdout("ses_fresh"),
      stderr: "",
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  function createContext(
    overrides: Partial<AdapterExecutionContext> = {},
  ): AdapterExecutionContext {
    return {
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
        cwd: tempRoot,
        model: "litellm/devstral-small-2-24b",
        instructionsFilePath: instructionsPath,
      },
      context: {},
      onLog: vi.fn(async () => {}),
      onMeta: vi.fn(async () => {}),
      authToken: "paperclip-token",
      ...overrides,
    };
  }

  it("passes the Paperclip prompt via stdin", async () => {
    const ctx = createContext();

    const result = await execute(ctx);

    expect(runChildProcessMock).toHaveBeenCalledTimes(1);
    const [, , args, options] = runChildProcessMock.mock.calls[0];
    expect(args.slice(0, 5)).toEqual([
      "run",
      "--format",
      "json",
      "--model",
      "litellm/devstral-small-2-24b",
    ]);
    expect(options.stdin).toContain("Continue your Paperclip work.");
    expect(options.stdin).toContain("The above agent instructions were loaded from");
    expect(result.sessionParams).toMatchObject({
      sessionId: "ses_fresh",
      cwd: tempRoot,
    });
  });

  it("does not resume sessions saved for a different cwd", async () => {
    const onLog = vi.fn(async () => {});
    const ctx = createContext({
      runtime: {
        sessionId: "ses_other",
        sessionParams: {
          sessionId: "ses_other",
          cwd: path.join(tempRoot, "other"),
        },
        sessionDisplayId: null,
        taskKey: null,
      },
      onLog,
    });

    await execute(ctx);

    const [, , args] = runChildProcessMock.mock.calls[0];
    expect(args).not.toContain("--session");
    expect(onLog).toHaveBeenCalledWith(
      "stderr",
      expect.stringContaining("will not be resumed"),
    );
  });

  it("resumes compatible sessions that already use run_message_v1", async () => {
    const ctx = createContext({
      runtime: {
        sessionId: "ses_saved",
        sessionParams: {
          sessionId: "ses_saved",
          cwd: tempRoot,
        },
        sessionDisplayId: null,
        taskKey: null,
      },
    });

    await execute(ctx);

    const [, , args] = runChildProcessMock.mock.calls[0];
    expect(args).toContain("--session");
    expect(args).toContain("ses_saved");
  });

  it("passes an OpenCode agent profile when configured without requiring an explicit model", async () => {
    resolveConfiguredOpenCodeAgentModelMock.mockResolvedValue(
      "litellm/devstral-small-2-24b",
    );
    const ctx = createContext({
      config: {
        command: "opencode",
        cwd: tempRoot,
        agent: "plan",
        instructionsFilePath: instructionsPath,
      },
    });

    await execute(ctx);

    const [, , args] = runChildProcessMock.mock.calls[0];
    expect(args.slice(0, 5)).toEqual([
      "run",
      "--format",
      "json",
      "--agent",
      "plan",
    ]);
    expect(args).not.toContain("--model");
    expect(ensureOpenCodeAgentConfiguredAndAvailableMock).toHaveBeenCalledWith(
      expect.objectContaining({
        agent: "plan",
        command: "opencode",
        cwd: tempRoot,
      }),
    );
    expect(ensureOpenCodeModelConfiguredAndAvailableMock).not.toHaveBeenCalled();
    expect(resolveConfiguredOpenCodeAgentModelMock).toHaveBeenCalledWith({
      agent: "plan",
    });
    expect(hydrateLiteLlmApiKeyMock).toHaveBeenCalledTimes(1);
  });
});
