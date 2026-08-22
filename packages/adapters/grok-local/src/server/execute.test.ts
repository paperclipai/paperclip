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
const resolveCommandForLogsMock = vi.hoisted(() => vi.fn(async () => "grok"));
const runProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/execution-target", () => ({
  adapterExecutionTargetIsRemote: () => false,
  adapterExecutionTargetRemoteCwd: (_target: unknown, cwd: string) => cwd,
  overrideAdapterExecutionTargetRemoteCwd: (target: unknown, _cwd: string) => target,
  adapterExecutionTargetSessionIdentity: () => ({ kind: "local" }),
  adapterExecutionTargetSessionMatches: () => true,
  describeAdapterExecutionTarget: () => "local",
  ensureAdapterExecutionTargetCommandResolvable: ensureCommandMock,
  ensureAdapterExecutionTargetRuntimeCommandInstalled: ensureRuntimeInstalledMock,
  prepareAdapterExecutionTargetRuntime: prepareRuntimeMock,
  readAdapterExecutionTarget: ({ executionTarget }: { executionTarget?: unknown }) => executionTarget ?? { kind: "local" },
  resolveAdapterExecutionTargetCommandForLogs: resolveCommandForLogsMock,
  resolveAdapterExecutionTargetTimeoutSec: (_target: unknown, timeoutSec: number) => timeoutSec,
  runAdapterExecutionTargetProcess: runProcessMock,
}));

import { execute } from "./execute.js";

const tempRoots: string[] = [];

async function makeTempRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-grok-local-"));
  tempRoots.push(root);
  return root;
}

async function pathExists(candidate: string): Promise<boolean> {
  return fs.access(candidate).then(() => true).catch(() => false);
}

describe("grok_local execute", () => {
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

  it("stages Grok-native instructions and skills into the workspace for the run and cleans them up afterward", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    const skillSource = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "You are Grok.\n", "utf8");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\ndescription: test\n---\n", "utf8");

    runProcessMock.mockImplementation(async (_runId, _target, _command, args, options) => {
      expect(args).toEqual(
        expect.arrayContaining([
          "--output-format",
          "streaming-json",
          "--always-approve",
        ]),
      );
      // Grok >= 1.0 enforces `dontAsk` as deny-by-default over --always-approve,
      // so no permission mode may be passed unless explicitly configured.
      expect(args).not.toContain("--permission-mode");
      expect(await fs.readFile(path.join(root, "Agents.md"), "utf8")).toContain("You are Grok.");
      expect(await pathExists(path.join(root, ".claude", "skills", "paperclip", "SKILL.md"))).toBe(true);
      await options.onLog?.("stdout", '{"type":"text","data":"done"}\n');
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "text", data: "done" }),
          JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
        ].join("\n"),
        stderr: "",
      };
    });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const ctx: AdapterExecutionContext = {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
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
        instructionsFilePath: instructionsPath,
        paperclipRuntimeSkills: [{
          key: "paperclip",
          runtimeName: "paperclip",
          source: skillSource,
          required: false,
        }],
        paperclipSkillSync: { desiredSkills: ["paperclip"] },
      },
      context: {},
      authToken: "run-token",
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        logs.push({ stream, chunk });
      },
    };

    const result = await execute(ctx);

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      summary: "done",
      sessionId: "sess-1",
      sessionDisplayId: "sess-1",
    });
    expect(await pathExists(path.join(root, "Agents.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude", "skills", "paperclip"))).toBe(false);
    expect(logs.map((entry) => entry.chunk)).not.toEqual([]);
  });

  it("reports real per-run token usage, marks it as per_run, and only surfaces cost for API billing", async () => {
    runProcessMock.mockImplementation(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "text", data: "done" }),
        JSON.stringify({
          type: "end",
          stopReason: "EndTurn",
          sessionId: "sess-1",
          requestId: "req-1",
          usage: { input_tokens: 2384, output_tokens: 261, cache_read_input_tokens: 23040 },
          total_cost_usd: 0.013246,
        }),
      ].join("\n"),
      stderr: "",
    }));

    const makeCtx = async (runId: string): Promise<AdapterExecutionContext> => ({
      runId,
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: await makeTempRoot() },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    });

    const previousApiKey = process.env.XAI_API_KEY;
    try {
      // Subscription billing (no XAI_API_KEY): token usage is populated, but
      // there is no marginal dollar cost so costUsd stays null. Clear the key
      // explicitly so the ambient environment (dev machine or CI with provider
      // secrets) cannot flip this branch to API billing.
      delete process.env.XAI_API_KEY;
      const subscriptionResult = await execute(await makeCtx("run-subscription"));
      expect(subscriptionResult).toMatchObject({
        usage: { inputTokens: 2384, outputTokens: 261, cachedInputTokens: 23040 },
        usageBasis: "per_run",
        billingType: "subscription",
        costUsd: null,
      });

      // API-key billing: same token usage, plus the real dollar cost.
      process.env.XAI_API_KEY = "test-key";
      const apiResult = await execute(await makeCtx("run-api"));
      expect(apiResult).toMatchObject({
        usage: { inputTokens: 2384, outputTokens: 261, cachedInputTokens: 23040 },
        usageBasis: "per_run",
        billingType: "api",
        costUsd: 0.013246,
      });
    } finally {
      if (previousApiKey === undefined) delete process.env.XAI_API_KEY;
      else process.env.XAI_API_KEY = previousApiKey;
    }
  });

  it("passes an explicitly configured permissionMode through to the CLI", async () => {
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-1", requestId: "req-1" }),
        stderr: "",
      };
    });

    const ctx: AdapterExecutionContext = {
      runId: "run-permission-mode",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: await makeTempRoot(), permissionMode: "bypassPermissions" },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    };

    await execute(ctx);

    const flagIndex = seenArgs.indexOf("--permission-mode");
    expect(flagIndex).toBeGreaterThan(-1);
    expect(seenArgs[flagIndex + 1]).toBe("bypassPermissions");
  });

  it("does not fail a completed turn for noisy Grok auth worker stderr", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "text", data: "done" }),
        JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-noisy-auth", requestId: "req-1" }),
      ].join("\n"),
      stderr: "ERROR worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)\n",
    });

    const result = await execute({
      runId: "run-noisy-auth",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
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
    });

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      summary: "done",
      sessionId: "sess-noisy-auth",
    });
  });

  it("still fails auth-required output when Grok does not complete a turn", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "ERROR worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)\n",
    });

    const result = await execute({
      runId: "run-auth-required",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
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
    });

    expect(result.errorMessage).toContain("AuthorizationRequired");
    expect(result.summary).toBe("");
    expect(result.sessionId).toBeNull();
    // Worker transport death is retried with backoff instead of counting
    // toward the agent's consecutive-failure error state.
    expect(result.errorCode).toBe("grok_transient_upstream");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.resultJson).toMatchObject({ errorFamily: "transient_upstream" });
  });

  it("classifies a cancelled turn with worker transport death as transient upstream", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "thought", data: "thinking" }),
        JSON.stringify({ type: "end", stopReason: "cancelled", sessionId: "sess-cancelled", requestId: "req-1" }),
      ].join("\n"),
      stderr: "\u001B[2m2026-06-10T22:08:50.893501Z\u001B[0m \u001B[31mERROR\u001B[0m worker quit with fatal: Transport channel closed, when Auth(AuthorizationRequired)\n",
    });

    const result = await execute({
      runId: "run-cancelled-transient",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
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
    });

    expect(result.errorCode).toBe("grok_transient_upstream");
    expect(result.errorFamily).toBe("transient_upstream");
    expect(result.errorMessage).toContain("cancelled before producing a final response");
    expect(result.errorMessage).toContain("Transport channel closed");
    // ANSI escapes are stripped from the surfaced error message.
    expect(result.errorMessage).not.toContain("\u001B[");
    expect(result.resultJson).toMatchObject({ errorFamily: "transient_upstream" });
  });

  it("does not fail a completed turn for a recovered mid-stream error event", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValueOnce({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        JSON.stringify({ type: "error", error: { message: "stream hiccup, retrying" } }),
        JSON.stringify({ type: "text", data: "all done" }),
        JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-recovered", requestId: "req-1" }),
      ].join("\n"),
      stderr: "",
    });

    const result = await execute({
      runId: "run-recovered-error",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
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
    });

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      errorCode: null,
      summary: "all done",
      sessionId: "sess-recovered",
    });
  });

  it("retries with a fresh session when the resume id is rejected on an exit-0 run", async () => {
    const root = await makeTempRoot();
    runProcessMock
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Session not found: bogus-session\n",
      })
      .mockResolvedValueOnce({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: [
          JSON.stringify({ type: "text", data: "fresh run done" }),
          JSON.stringify({ type: "end", stopReason: "EndTurn", sessionId: "sess-fresh", requestId: "req-2" }),
        ].join("\n"),
        stderr: "",
      });

    const result = await execute({
      runId: "run-unknown-session-retry",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "bogus-session",
        sessionParams: { sessionId: "bogus-session", cwd: root },
        sessionDisplayId: "bogus-session",
        taskKey: null,
      },
      config: { cwd: root },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    });

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    const firstArgs = runProcessMock.mock.calls[0]?.[3] as string[];
    const secondArgs = runProcessMock.mock.calls[1]?.[3] as string[];
    expect(firstArgs).toEqual(expect.arrayContaining(["--resume", "bogus-session"]));
    expect(secondArgs).not.toContain("--resume");
    expect(result).toMatchObject({
      errorMessage: null,
      summary: "fresh run done",
      sessionId: "sess-fresh",
      clearSession: false,
    });
  });

  it("clears a rejected resume session when the fresh retry yields no new session", async () => {
    const root = await makeTempRoot();
    runProcessMock
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "Session not found: bogus-session\n",
      })
      .mockResolvedValueOnce({
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: "",
        stderr: "some other failure\n",
      });

    const result = await execute({
      runId: "run-unknown-session-clear",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: "bogus-session",
        sessionParams: { sessionId: "bogus-session", cwd: root },
        sessionDisplayId: "bogus-session",
        taskKey: null,
      },
      config: { cwd: root },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    });

    expect(runProcessMock).toHaveBeenCalledTimes(2);
    expect(result.sessionId).toBeNull();
    expect(result.clearSession).toBe(true);
    expect(result.errorMessage).toContain("some other failure");
  });

  it("reports timeout with errorCode and preserves any parsed session id", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockResolvedValueOnce({
      exitCode: null,
      signal: "SIGTERM",
      timedOut: true,
      stdout: [
        JSON.stringify({ type: "text", data: "partial" }),
        JSON.stringify({ type: "end", stopReason: "cancelled", sessionId: "sess-timeout", requestId: "req-1" }),
      ].join("\n"),
      stderr: "",
    });

    const result = await execute({
      runId: "run-timeout",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
        adapterConfig: {},
      },
      runtime: {
        sessionId: null,
        sessionParams: null,
        sessionDisplayId: null,
        taskKey: null,
      },
      config: { cwd: root, timeoutSec: 30 },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    });

    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(result.errorMessage).toContain("Timed out after 30s");
    expect(result.sessionId).toBe("sess-timeout");
  });

  it("cleans up staged assets when setup fails before the Grok process starts", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    const skillSource = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "You are Grok.\n", "utf8");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\ndescription: test\n---\n", "utf8");
    ensureCommandMock.mockRejectedValueOnce(new Error("grok not installed"));

    const ctx: AdapterExecutionContext = {
      runId: "run-setup-fail",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Grok Agent",
        adapterType: "grok_local",
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
        instructionsFilePath: instructionsPath,
        paperclipRuntimeSkills: [{
          key: "paperclip",
          runtimeName: "paperclip",
          source: skillSource,
          required: false,
        }],
        paperclipSkillSync: { desiredSkills: ["paperclip"] },
      },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    };

    await expect(execute(ctx)).rejects.toThrow("grok not installed");
    expect(runProcessMock).not.toHaveBeenCalled();
    expect(await pathExists(path.join(root, "Agents.md"))).toBe(false);
    expect(await pathExists(path.join(root, ".claude", "skills", "paperclip"))).toBe(false);
  });
});
