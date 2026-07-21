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
const resolveCommandForLogsMock = vi.hoisted(() => vi.fn(async () => "kimi"));
const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: () => false,
  adapterExecutionTargetRemoteCwd: (_target: unknown, cwd: string) => cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown, _cwd: string) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  adapterExecutionTargetUsesManagedHome: () => false,
  adapterExecutionTargetUsesPaperclipBridge: () => false,
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetRuntimeCommandInstalled: ensureRuntimeInstalledMock,
  prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) => executionTarget ?? { kind: "local" },
  readAdapterExecutionTargetHomeDir: async () => null,
  resolveAdapterExecutionTargetCommandForLogs: resolveCommandForLogsMock,
  resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: runProcessMock,
  runAdapterExecutionTargetShellCommand: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
  startAdapterExecutionTargetPaperclipBridge: async () => null,
}));

import { execute } from "./execute.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-kimi-local-"));
  tempRoots.push(root);
  return root;
}

function makeContext(root: string, overrides: Partial<AdapterExecutionContext> = {}): AdapterExecutionContext {
  const ctx: AdapterExecutionContext = {
    runId: "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Kimi Agent",
      adapterType: "kimi_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: { cwd: root },
    context: {},
    authToken: "run-token",
    onLog: async () => {},
    ...overrides,
  };
  // Default these CLI-lane tests to the CLI engine so they never depend on
  // whether `kimi` is resolvable on PATH (ACP is the runtime default). Tests
  // that need ACP can set engine explicitly in their config override.
  ctx.config = { engine: "cli", ...ctx.config };
  return ctx;
}

const KIMI_STDOUT = [
  JSON.stringify({ role: "assistant", content: "done" }),
  JSON.stringify({
    role: "meta",
    type: "session.resume_hint",
    session_id: "session_abc-123",
    command: "kimi -r session_abc-123",
  }),
].join("\n");

describe("kimi_local execute", () => {
  beforeEach(() => {
    ensureRuntimeInstalledMock.mockClear();
    ensureCommandMock.mockClear();
    prepareRuntimeMock.mockClear();
    resolveCommandForLogsMock.mockClear();
    runProcessMock.mockReset();
  });

  afterEach(async () => {
    await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
  });

  it("runs kimi headless with stream-json and captures the session id from the meta event", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    let seenEnv: Record<string, string> = {};
    runProcessMock.mockImplementation(async (_runId, _target, _command, args, options) => {
      seenArgs = args;
      seenEnv = options.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    const result = await execute(makeContext(root));

    expect(seenArgs[0]).toBe("--output-format");
    expect(seenArgs[1]).toBe("stream-json");
    expect(seenArgs).not.toContain("-m");
    expect(seenArgs).not.toContain("-r");
    expect(seenArgs[seenArgs.length - 2]).toBe("-p");
    expect(seenEnv.CI).toBe("1");
    expect(seenEnv.NO_COLOR).toBe("1");
    expect(seenEnv.KIMI_CODE_NO_AUTO_UPDATE).toBe("1");
    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      summary: "done",
      sessionId: "session_abc-123",
      sessionDisplayId: "session_abc-123",
    });
    expect(result.sessionParams).toMatchObject({
      sessionId: "session_abc-123",
      cwd: root,
    });
  });

  it("forwards streamed stdout lines to onEvent as assistant + tool_call runtime events", async () => {
    const root = await makeTempRoot();
    const events: Array<{ eventType: string; message?: string; payload?: Record<string, unknown> }> = [];
    const stream =
      `${JSON.stringify({ role: "assistant", content: "Here is my plan" })}\n` +
      `${JSON.stringify({
        role: "assistant",
        content: "running",
        tool_calls: [{ type: "function", id: "t1", function: { name: "Bash", arguments: "{}" } }],
      })}\n`;
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      // Split mid-line so the wrapper's newline buffering is exercised across chunks.
      await options.onLog("stdout", stream.slice(0, 20));
      await options.onLog("stdout", stream.slice(20));
      return { exitCode: 0, signal: null, timedOut: false, stdout: stream, stderr: "" };
    });

    await execute(makeContext(root, { onEvent: async (event) => { events.push(event); } }));

    expect(events).toContainEqual({
      eventType: "assistant",
      stream: "stdout",
      message: "Here is my plan",
      payload: { content: "Here is my plan" },
    });
    expect(events).toContainEqual({ eventType: "tool_call", stream: "stdout", payload: { toolName: "Bash" } });
  });

  it("forwards the final stdout line to onEvent even without a trailing newline", async () => {
    const root = await makeTempRoot();
    const events: Array<{ eventType: string; payload?: Record<string, unknown> }> = [];
    // Kimi can close stdout after a valid event with no trailing newline; the
    // forwarder must flush it so the last tool call reaches live status.
    const stream = `${JSON.stringify({
      role: "assistant",
      tool_calls: [{ type: "function", id: "t9", function: { name: "Read", arguments: "{}" } }],
    })}`;
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      await options.onLog("stdout", stream);
      return { exitCode: 0, signal: null, timedOut: false, stdout: stream, stderr: "" };
    });

    await execute(makeContext(root, { onEvent: async (event) => { events.push(event); } }));

    expect(events).toContainEqual({ eventType: "tool_call", stream: "stdout", payload: { toolName: "Read" } });
  });

  it("passes -m only when a model is configured", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, { config: { cwd: root, model: "kimi-code/k3" } }));

    expect(seenArgs).toContain("-m");
    expect(seenArgs[seenArgs.indexOf("-m") + 1]).toBe("kimi-code/k3");
  });

  it("resumes with -r when the stored session cwd matches the run cwd", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, {
      runtime: {
        sessionId: "session_abc-123",
        sessionParams: { sessionId: "session_abc-123", cwd: root },
        sessionDisplayId: "session_abc-123",
        taskKey: null,
      },
    }));

    expect(seenArgs).toContain("-r");
    expect(seenArgs[seenArgs.indexOf("-r") + 1]).toBe("session_abc-123");
  });

  it("starts a fresh session when the stored session cwd differs", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, {
      runtime: {
        sessionId: "session_abc-123",
        sessionParams: { sessionId: "session_abc-123", cwd: "/some/other/dir" },
        sessionDisplayId: "session_abc-123",
        taskKey: null,
      },
    }));

    expect(seenArgs).not.toContain("-r");
  });

  it("retries fresh when the resume session is unrecoverable", async () => {
    const root = await makeTempRoot();
    const seenArgLists: string[][] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgLists.push(args);
      if (seenArgLists.length === 1) {
        return { exitCode: 1, signal: null, timedOut: false, stdout: "", stderr: "Error: unknown session 'session_stale'" };
      }
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    const result = await execute(makeContext(root, {
      runtime: {
        sessionId: "session_stale",
        sessionParams: { sessionId: "session_stale", cwd: root },
        sessionDisplayId: "session_stale",
        taskKey: null,
      },
    }));

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    expect(seenArgLists[0]).toContain("-r");
    expect(seenArgLists[1]).not.toContain("-r");
    expect(result).toMatchObject({ exitCode: 0, sessionId: "session_abc-123" });
  });

  it("maps auth failures to the kimi_auth_required error code", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockImplementation(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "Error: 401 Unauthorized — run kimi login to authenticate",
    }));

    const result = await execute(makeContext(root));

    expect(result.exitCode).toBe(1);
    expect(result.errorCode).toBe("kimi_auth_required");
    expect(result.errorMessage).toBeTruthy();
  });

  it("reports a timeout when the process exceeds timeoutSec", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockImplementation(async () => ({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: "",
      stderr: "",
    }));

    const result = await execute(makeContext(root, { config: { cwd: root, timeoutSec: 5 } }));

    expect(result.timedOut).toBe(true);
    expect(result.errorMessage).toContain("5s");
  });

  it("reports failure when the process is killed by a signal without timing out", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockImplementation(async () => ({
      exitCode: null,
      signal: "SIGKILL",
      timedOut: false,
      stdout: "",
      stderr: "",
    }));

    const result = await execute(makeContext(root));

    expect(result.timedOut).toBe(false);
    expect(result.errorMessage).toContain("SIGKILL");
    expect(result.errorMessage).not.toBeNull();
  });

  it("preserves user-configured headless env values", async () => {
    const root = await makeTempRoot();
    let seenEnv: Record<string, string> = {};
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      seenEnv = options.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, {
      config: {
        cwd: root,
        env: {
          CI: "0",
          NO_COLOR: "0",
          KIMI_CODE_NO_AUTO_UPDATE: "0",
          TERM: "xterm-256color",
        },
      },
    }));

    expect(seenEnv.CI).toBe("0");
    expect(seenEnv.NO_COLOR).toBe("0");
    expect(seenEnv.KIMI_CODE_NO_AUTO_UPDATE).toBe("0");
    expect(seenEnv.TERM).toBe("xterm-256color");
  });

  it("forwards configured effort as KIMI_MODEL_THINKING_EFFORT for effort-capable models", async () => {
    const root = await makeTempRoot();
    let seenEnv: Record<string, string> = {};
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      seenEnv = options.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, { config: { cwd: root, model: "kimi-code/k3", effort: "high" } }));

    expect(seenEnv.KIMI_MODEL_THINKING_EFFORT).toBe("high");
  });

  it("maps the medium effort tier onto high since Kimi has no medium", async () => {
    const root = await makeTempRoot();
    let seenEnv: Record<string, string> = {};
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      seenEnv = options.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, { config: { cwd: root, model: "kimi-code/k3", effort: "medium" } }));

    expect(seenEnv.KIMI_MODEL_THINKING_EFFORT).toBe("high");
  });

  it("does not forward effort for models without support_efforts", async () => {
    const root = await makeTempRoot();
    let seenEnv: Record<string, string> = {};
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      seenEnv = options.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, {
      config: { cwd: root, model: "kimi-code/kimi-for-coding", effort: "high" },
    }));

    expect(seenEnv.KIMI_MODEL_THINKING_EFFORT).toBeUndefined();
  });

  it("adds --add-dir for the instructions directory and names sibling files in the prompt", async () => {
    const root = await makeTempRoot();
    const instructionsDir = path.join(root, "instructions");
    await fs.mkdir(instructionsDir, { recursive: true });
    const instructionsFilePath = path.join(instructionsDir, "AGENTS.md");
    await fs.writeFile(instructionsFilePath, "# Role\nYou are the lead agent.\n");

    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, { config: { cwd: root, instructionsFilePath } }));

    expect(seenArgs).toContain("--add-dir");
    expect(seenArgs[seenArgs.indexOf("--add-dir") + 1]).toBe(instructionsDir);
    const prompt = seenArgs[seenArgs.length - 1];
    expect(prompt).toContain("./HEARTBEAT.md");
    expect(prompt).toContain("./SOUL.md");
    expect(prompt).toContain("./TOOLS.md");
  });

  it("does not pass --skills-dir when no skills are desired", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, { config: { cwd: root, model: "kimi-code/k3" } }));

    expect(seenArgs).not.toContain("--skills-dir");
  });
});
