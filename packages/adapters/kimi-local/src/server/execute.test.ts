import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { createPromptContextFixture } from "@paperclipai/adapter-utils/test-fixtures/prompt-context";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

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

type RuntimeEvent = Parameters<NonNullable<AdapterExecutionContext["onEvent"]>>[0];

/** Keep Kimi's real caller/forwarder, replacing only its executable with a tiny Node producer. */
function useRealNodeChild(chunks: string[], onResolved?: () => void) {
  const observed = {
    controls: [] as Array<{ stream: "stdout" | "stderr"; records: string }>,
    errors: [] as unknown[],
    result: null as Awaited<ReturnType<typeof runChildProcess>> | null,
  };
  runProcessMock.mockImplementation(async (
    runId: string,
    _target: unknown,
    _command: string,
    _args: string[],
    options: Parameters<typeof runChildProcess>[3],
  ) => {
    const source = `
      const chunks = ${JSON.stringify(chunks)};
      (async () => {
        for (const chunk of chunks) {
          process.stdout.write(chunk);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      })().catch(() => { process.exitCode = 1; });
    `;
    observed.result = await runChildProcess(runId, process.execPath, ["-e", source], {
      ...options,
      timeoutSec: 5,
      graceSec: 1,
      onLogError: (error) => { observed.errors.push(error); },
      onControlOutput: async (stream, records) => {
        observed.controls.push({ stream, records });
        await options.onControlOutput?.(stream, records);
      },
    });
    onResolved?.();
    return observed.result;
  });
  return observed;
}

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

  it("delivers the owned assignment and ordered wake comments through the CLI prompt", async () => {
    const root = await makeTempRoot();
    const fixture = createPromptContextFixture();
    let deliveredPrompt = "";
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      deliveredPrompt = String(args.at(-1) ?? "");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: KIMI_STDOUT,
        stderr: "",
      };
    });

    await execute(makeContext(root, {
      context: fixture,
    }));

    expect(deliveredPrompt).toContain(fixture.paperclipTaskMarkdownAssignment);
    expect(deliveredPrompt.indexOf("Append the same ledger entry.")).toBeLessThan(
      deliveredPrompt.lastIndexOf("Append the same ledger entry."),
    );
    expect(deliveredPrompt.indexOf("comment-first")).toBeLessThan(
      deliveredPrompt.indexOf("comment-second"),
    );
    expect(deliveredPrompt.indexOf("comment-second")).toBeLessThan(
      deliveredPrompt.indexOf("comment-scope"),
    );
    expect(deliveredPrompt).toContain("Change the final scope to the launch checklist.");
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
      // Display chunks are independent from the producer's complete control records.
      await options.onLog("stdout", stream.slice(0, 20));
      await options.onLog("stdout", stream.slice(20));
      expect(events).toEqual([]);
      await options.onControlOutput("stderr", stream);
      expect(events).toEqual([]);
      await options.onControlOutput("stdout", stream);
      expect(events.map((event) => event.eventType)).toEqual(["assistant", "assistant", "tool_call"]);
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
    // The process producer flushes the final complete record at EOF; the
    // forwarder consumes it once even though it has no trailing newline.
    const stream = `${JSON.stringify({
      role: "assistant",
      tool_calls: [{ type: "function", id: "t9", function: { name: "Read", arguments: "{}" } }],
    })}`;
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      await options.onLog("stdout", stream);
      expect(events).toEqual([]);
      await options.onControlOutput("stdout", stream);
      expect(events).toHaveLength(1);
      return { exitCode: 0, signal: null, timedOut: false, stdout: stream, stderr: "" };
    });

    await execute(makeContext(root, { onEvent: async (event) => { events.push(event); } }));

    expect(events).toContainEqual({ eventType: "tool_call", stream: "stdout", payload: { toolName: "Read" } });
  });

  it("does not synthesize live events from a display-only producer or its final capture", async () => {
    const root = await makeTempRoot();
    const events: RuntimeEvent[] = [];
    const display = `${JSON.stringify({ role: "assistant", content: "display only" })}\n`;
    const logs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      await options.onLog("stdout", display);
      return { exitCode: 0, signal: null, timedOut: false, stdout: display, stderr: "" };
    });

    const result = await execute(makeContext(root, {
      onLog: async (stream, chunk) => { if (stream === "stdout") logs.push(chunk); },
      onEvent: async (event) => { events.push(event); },
    }));

    expect(logs.join("")).toBe(display);
    expect(result.summary).toBe("display only");
    expect(events).toEqual([]);
  });

  it("uses real child control records when numeric masking invalidates display JSON; delivers ordered events once before process resolution", async () => {
    const root = await makeTempRoot();
    const secret = "123456";
    const first = JSON.stringify({
      role: "assistant",
      content: "numeric event",
      ignored: Number(secret),
      tool_calls: [{ type: "function", id: "first", function: { name: "Bash", arguments: "{}" } }],
    });
    const second = JSON.stringify({ role: "assistant", content: "unaffected event" });
    const final = JSON.stringify({
      role: "assistant",
      tool_calls: [{ type: "function", id: "last", function: { name: "Read", arguments: "{}" } }],
    });
    const events: RuntimeEvent[] = [];
    const logs: string[] = [];
    let processResolved = false;
    let eventsAtProcessResolution: RuntimeEvent[] = [];
    const child = useRealNodeChild([
      first.slice(0, first.indexOf(secret) + 3),
      first.slice(first.indexOf(secret) + 3) + "\n" + second + "\n" + final.slice(0, 17),
      final.slice(17),
    ], () => {
      eventsAtProcessResolution = [...events];
      processResolved = true;
    });

    const result = await execute(makeContext(root, {
      config: { cwd: root, env: { KIMI_API_KEY: secret } },
      onLog: async (stream, chunk) => { if (stream === "stdout") logs.push(chunk); },
      onEvent: async (event) => {
        expect(processResolved).toBe(false);
        // A slow sink must also finish before the real process promise resolves.
        await new Promise((resolve) => setTimeout(resolve, 5));
        expect(processResolved).toBe(false);
        events.push(event);
      },
    }));

    const expected = [
      { eventType: "assistant", stream: "stdout", message: "numeric event", payload: { content: "numeric event" } },
      { eventType: "tool_call", stream: "stdout", payload: { toolName: "Bash" } },
      { eventType: "assistant", stream: "stdout", message: "unaffected event", payload: { content: "unaffected event" } },
      { eventType: "tool_call", stream: "stdout", payload: { toolName: "Read" } },
    ];
    expect(events).toEqual(expected);
    expect(eventsAtProcessResolution).toEqual(expected);
    expect(processResolved).toBe(true);
    expect(child.errors).toEqual([]);
    expect(result.exitCode).toBe(0);
    const display = logs.join("");
    expect(display).toBe(child.result?.stdout);
    expect(display).toContain('"ignored":***REDACTED***');
    expect(() => JSON.parse(display.split("\n")[0]!)).toThrow();
    const controls = child.controls.map(({ records }) => records).join("");
    expect(controls.split("\n").map((line) => JSON.parse(line))).toEqual([
      { ...JSON.parse(first), ignored: 0 }, JSON.parse(second), JSON.parse(final),
    ]);
    expect(controls.endsWith(final)).toBe(true);
    for (const boundary of [display, controls, JSON.stringify(events), JSON.stringify(result)]) {
      expect(boundary).not.toContain(secret);
    }
  });

  it("masks a whole affected string token in real child control events without changing literal display masking", async () => {
    const root = await makeTempRoot();
    const secret = "synthetic-kimi-string-secret";
    const line = JSON.stringify({ role: "assistant", content: `prefix-${secret}-suffix` });
    const logs: string[] = [];
    const events: RuntimeEvent[] = [];
    const child = useRealNodeChild([line.slice(0, line.indexOf(secret) + 7), line.slice(line.indexOf(secret) + 7) + "\n"]);

    const result = await execute(makeContext(root, {
      config: { cwd: root, env: { KIMI_API_KEY: secret } },
      onLog: async (stream, chunk) => { if (stream === "stdout") logs.push(chunk); },
      onEvent: async (event) => { events.push(event); },
    }));

    expect(logs.join("")).toBe(`${JSON.stringify({ role: "assistant", content: "prefix-***REDACTED***-suffix" })}\n`);
    expect(child.controls.map(({ records }) => records).join("")).toBe(
      `${JSON.stringify({ role: "assistant", content: "***REDACTED***" })}\n`,
    );
    expect(events).toEqual([
      { eventType: "assistant", stream: "stdout", message: "***REDACTED***", payload: { content: "***REDACTED***" } },
    ]);
    expect(result.summary).toBe("***REDACTED***");
    expect(child.errors).toEqual([]);
    for (const boundary of [logs.join(""), JSON.stringify(child.controls), JSON.stringify(events), JSON.stringify(result)]) {
      expect(boundary).not.toContain(secret);
    }
  });

  it("suppresses a malformed quote-bearing original even if literal display masking repairs it into an event, then recovers", async () => {
    const root = await makeTempRoot();
    const secret = 'broken"quotation';
    const malformed = `{"role":"assistant","content":"${secret}"}`;
    const genuine = JSON.stringify({ role: "assistant", content: "genuine following record" });
    expect(() => JSON.parse(malformed)).toThrow();
    const events: RuntimeEvent[] = [];
    const logs: string[] = [];
    const child = useRealNodeChild([malformed.slice(0, 37), malformed.slice(37) + "\n" + genuine]);

    const result = await execute(makeContext(root, {
      config: { cwd: root, env: { KIMI_API_KEY: secret } },
      onLog: async (stream, chunk) => { if (stream === "stdout") logs.push(chunk); },
      onEvent: async (event) => { events.push(event); },
    }));

    expect(JSON.parse(logs.join("").split("\n")[0]!)).toEqual({ role: "assistant", content: "***REDACTED***" });
    expect(child.controls.map(({ records }) => records).join("")).toBe(`***REDACTED***\n${genuine}`);
    expect(events).toEqual([
      { eventType: "assistant", stream: "stdout", message: "genuine following record", payload: { content: "genuine following record" } },
    ]);
    expect(child.errors).toEqual([]);
    expect(result.summary).toBe("genuine following record");
    for (const boundary of [logs.join(""), JSON.stringify(child.controls), JSON.stringify(events), JSON.stringify(result)]) {
      expect(boundary).not.toContain(secret);
    }
  });

  it("runs the real child control-output path harmlessly when onEvent is absent", async () => {
    const root = await makeTempRoot();
    const secret = "123456";
    const line = JSON.stringify({ role: "assistant", content: "no live sink needed", ignored: Number(secret) });
    const child = useRealNodeChild([line]);
    const logs: string[] = [];

    const result = await execute(makeContext(root, {
      config: { cwd: root, env: { KIMI_API_KEY: secret } },
      onLog: async (stream, chunk) => { if (stream === "stdout") logs.push(chunk); },
    }));

    expect(result).toMatchObject({ exitCode: 0, summary: "no live sink needed", errorMessage: null });
    expect(child.errors).toEqual([]);
    expect(child.controls).toEqual([{ stream: "stdout", records: JSON.stringify({ role: "assistant", content: "no live sink needed", ignored: 0 }) }]);
    expect(logs.join("")).toContain('"ignored":***REDACTED***');
    expect(JSON.stringify(child.controls) + logs.join("") + JSON.stringify(result)).not.toContain(secret);
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
    const fixture = createPromptContextFixture();
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
      config: { cwd: root, bootstrapPromptTemplate: "BOOTSTRAP {{run.id}}" },
      context: fixture,
    }));

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    expect(seenArgLists[0]).toContain("-r");
    expect(seenArgLists[1]).not.toContain("-r");
    expect(seenArgLists[1].at(-1)).toContain(fixture.paperclipTaskMarkdownAssignment);
    expect(seenArgLists[1].at(-1)).toContain("BOOTSTRAP run-1");
    expect(seenArgLists[1].at(-1)).toContain("comment-first");
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

  it.each(["kimi-code/k3", "kimi-code/k3-256k", "kimi-code/kimi-for-coding"])("forwards configured effort for %s", async (model) => {
    const root = await makeTempRoot();
    let seenEnv: Record<string, string> = {};
    runProcessMock.mockImplementation(async (_runId, _target, _command, _args, options) => {
      seenEnv = options.env;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, { config: { cwd: root, model, effort: "high" } }));

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
      config: { cwd: root, model: "kimi-code/kimi-for-coding-highspeed", effort: "high" },
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

  it("loads the operational skill when no optional skills are configured", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: KIMI_STDOUT, stderr: "" };
    });

    await execute(makeContext(root, { config: { cwd: root, model: "kimi-code/k3" } }));

    expect(seenArgs).toContain("--skills-dir");
    expect(seenArgs[seenArgs.indexOf("--skills-dir") + 1]).toContain("paperclip-kimi-skills-");
  });
});
