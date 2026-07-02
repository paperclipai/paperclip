import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const ensureRuntimeInstalledMock = vi.hoisted(() => vi.fn(async () => {}));
const ensureCommandMock = vi.hoisted(() => vi.fn(async () => {}));
const prepareRuntimeMock = vi.hoisted(() => vi.fn(async () => ({
  workspaceRemoteDir: null,
  restoreWorkspace: async () => {},
})));
const resolveCommandForLogsMock = vi.hoisted(() => vi.fn(async () => "agy"));
const runProcessMock = vi.hoisted(() => vi.fn());
const startBridgeMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock("@paperclipai/adapter-utils/execution-target", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/execution-target")>(
    "@paperclipai/adapter-utils/execution-target",
  );
  return {
    ...actual,
    adapterExecutionTargetIsRemote: () => false,
    adapterExecutionTargetRemoteCwd: (_target: unknown, cwd: string) => cwd,
    overrideAdapterExecutionTargetRemoteCwd: (target: unknown, _cwd: string) => target,
    adapterExecutionTargetSessionIdentity: () => ({ transport: "local" }),
    adapterExecutionTargetSessionMatches: () => true,
    describeAdapterExecutionTarget: () => "local",
    ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
    ensureAdapterExecutionTargetRuntimeCommandInstalled: ensureRuntimeInstalledMock,
    prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
    readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) => executionTarget ?? { kind: "local" },
    resolveAdapterExecutionTargetCommandForLogs: resolveCommandForLogsMock,
    resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
    runAdapterExecutionTargetProcess: runProcessMock,
    startAdapterExecutionTargetPaperclipBridge: startBridgeMock,
  };
});

import { execute } from "./execute.js";

const tempRoots: string[] = [];
const oldApiUrl = process.env.PAPERCLIP_API_URL;

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-antigravity-local-"));
  tempRoots.push(root);
  return root;
}

function buildContext(root: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  return {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Antigravity Agent",
      adapterType: "antigravity_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      cwd: root,
      model: "Gemini 3.5 Flash (Low)",
    },
    context: {
      taskId: "issue-1",
      wakeReason: "issue_assigned",
      paperclipWorkspace: {
        cwd: root,
        source: "project_primary",
        workspaceId: "workspace-1",
      },
    },
    authToken: "run-token",
    onLog: async () => {},
    ...overrides,
  } as AdapterExecutionContext;
}

describe("antigravity_local execute", () => {
  beforeEach(() => {
    process.env.PAPERCLIP_API_URL = "http://127.0.0.1:3100";
    ensureRuntimeInstalledMock.mockClear();
    ensureCommandMock.mockClear();
    prepareRuntimeMock.mockClear();
    resolveCommandForLogsMock.mockClear();
    startBridgeMock.mockClear();
    runProcessMock.mockReset();
  });

  afterEach(async () => {
    if (oldApiUrl === undefined) {
      delete process.env.PAPERCLIP_API_URL;
    } else {
      process.env.PAPERCLIP_API_URL = oldApiUrl;
    }
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("runs agy in print mode, includes Paperclip API guidance, and persists the log-derived session id", async () => {
    const root = await makeTempRoot();
    const conversationId = "55555555-5555-4555-8555-555555555555";

    runProcessMock.mockImplementation(async (_runId, _target, command, args) => {
      expect(command).toBe("agy");
      expect(args[0]).toBe("--print");
      const prompt = args[1] as string;
      expect(prompt).toContain("Paperclip runtime note:");
      expect(prompt).toContain("PAPERCLIP_TASK_ID");
      expect(prompt).toContain("Paperclip API access note:");
      expect(prompt).toContain("PAPERCLIP_API_BASE");
      expect(prompt).toContain("$PAPERCLIP_API_BASE/api/issues/$PAPERCLIP_TASK_ID/comments");
      expect(args).toEqual(expect.arrayContaining([
        "--dangerously-skip-permissions",
        "--model",
        "Gemini 3.5 Flash (Low)",
        "--log-file",
      ]));
      const logPath = args[args.indexOf("--log-file") + 1] as string;
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.writeFile(
        logPath,
        `I0702 printmode.go:179] Print mode: conversation=${conversationId}, sending message\n`,
        "utf8",
      );
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "done\n",
        stderr: "",
      };
    });

    const result = await execute(buildContext(root));

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      provider: "google",
      biller: "google",
      model: "Gemini 3.5 Flash (Low)",
      sessionId: conversationId,
      sessionDisplayId: conversationId,
      summary: "done",
    });
    expect(result.sessionParams).toMatchObject({
      sessionId: conversationId,
      cwd: root,
      workspaceId: "workspace-1",
    });
  });

  it("retries without a stale conversation id and stores the fresh session", async () => {
    const root = await makeTempRoot();
    const freshConversationId = "66666666-6666-4666-8666-666666666666";

    runProcessMock
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "unknown conversation old-session",
      })
      .mockImplementationOnce(async (_runId, _target, _command, args) => {
        expect(args).not.toContain("old-session");
        const logPath = args[args.indexOf("--log-file") + 1] as string;
        await fs.mkdir(path.dirname(logPath), { recursive: true });
        await fs.writeFile(
          logPath,
          `I0702 server.go:807] Created conversation ${freshConversationId}\n`,
          "utf8",
        );
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdout: "fresh\n",
          stderr: "",
        };
      });

    const result = await execute(buildContext(root, {
      runtime: {
        sessionId: "old-session",
        sessionParams: { sessionId: "old-session", cwd: root },
        sessionDisplayId: "old-session",
        taskKey: null,
      },
    }));

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    const firstArgs = runProcessMock.mock.calls[0]?.[3] as string[];
    expect(firstArgs).toEqual(expect.arrayContaining(["--conversation", "old-session"]));
    expect(result.sessionId).toBe(freshConversationId);
    expect(result.summary).toBe("fresh");
  });
});
