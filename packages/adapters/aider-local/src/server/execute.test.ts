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
const resolveCommandForLogsMock = vi.hoisted(() => vi.fn(async () => "aider"));
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-aider-local-"));
  tempRoots.push(root);
  return root;
}

function makeCtx(overrides: {
  runId?: string;
  config: Record<string, unknown>;
  runtime?: AdapterExecutionContext["runtime"];
}): AdapterExecutionContext {
  return {
    runId: overrides.runId ?? "run-1",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Aider Agent",
      adapterType: "aider_local",
      adapterConfig: {},
    },
    runtime: overrides.runtime ?? {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: overrides.config,
    context: {},
    authToken: "run-token",
    onLog: async () => {},
  };
}

function okRun(stdout: string) {
  return async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdout,
    stderr: "",
  });
}

describe("aider_local execute", () => {
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

  it("runs one-shot with unattended defaults and passes the prompt last", async () => {
    const root = await makeTempRoot();
    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: "done\n", stderr: "" };
    });

    const result = await execute(makeCtx({ config: { cwd: root } }));

    expect(seenArgs).toEqual(
      expect.arrayContaining(["--no-check-update", "--no-pretty", "--no-auto-commits", "--yes-always"]),
    );
    // The default model is a sentinel meaning "use Aider's own config".
    expect(seenArgs).not.toContain("--model");
    expect(seenArgs).not.toContain("--restore-chat-history");
    expect(seenArgs[seenArgs.length - 2]).toBe("--message");
    expect(seenArgs[seenArgs.length - 1]).toEqual(expect.any(String));

    const historyIndex = seenArgs.indexOf("--chat-history-file");
    expect(historyIndex).toBeGreaterThan(-1);
    expect(seenArgs[historyIndex + 1]).toBe(path.join(root, ".aider.chat.history.md"));

    expect(result).toMatchObject({
      exitCode: 0,
      errorMessage: null,
      provider: "aider",
      model: null,
      billingType: "api",
      usageBasis: "per_run",
      sessionParams: { chatHistoryFile: path.join(root, ".aider.chat.history.md"), cwd: root },
    });
  });

  it("attaches instructions and desired skills as read-only context files", async () => {
    const root = await makeTempRoot();
    const instructionsPath = path.join(root, "managed", "AGENTS.md");
    const skillSource = path.join(root, "runtime-skills", "paperclip");
    await fs.mkdir(path.dirname(instructionsPath), { recursive: true });
    await fs.writeFile(instructionsPath, "You are an Aider agent.\n", "utf8");
    await fs.mkdir(skillSource, { recursive: true });
    await fs.writeFile(path.join(skillSource, "SKILL.md"), "---\nname: paperclip\n---\n", "utf8");

    let seenArgs: string[] = [];
    runProcessMock.mockImplementation(async (_runId, _target, _command, args) => {
      seenArgs = args;
      return { exitCode: 0, signal: null, timedOut: false, stdout: "done\n", stderr: "" };
    });

    await execute(makeCtx({
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
    }));

    const readValues = seenArgs.reduce<string[]>((acc, value, index) => {
      if (value === "--read" && seenArgs[index + 1]) acc.push(seenArgs[index + 1]!);
      return acc;
    }, []);
    expect(readValues).toContain(instructionsPath);
    expect(readValues).toContain(path.join(skillSource, "SKILL.md"));

    // Nothing is copied into the workspace — Aider reads the sources in place.
    await expect(fs.access(path.join(root, "AGENTS.md"))).rejects.toThrow();
  });

  it("restores the chat history only when the saved transcript still exists in the same cwd", async () => {
    const root = await makeTempRoot();
    const historyPath = path.join(root, ".aider.chat.history.md");
    runProcessMock.mockImplementation(okRun("done\n"));

    const runtime = {
      sessionId: null,
      sessionParams: { chatHistoryFile: historyPath, cwd: root },
      sessionDisplayId: historyPath,
      taskKey: null,
    } as AdapterExecutionContext["runtime"];

    await execute(makeCtx({ runId: "run-missing-history", config: { cwd: root }, runtime }));
    expect(runProcessMock.mock.calls[0]?.[3]).not.toContain("--restore-chat-history");

    await fs.writeFile(historyPath, "# aider chat started\n", "utf8");
    await execute(makeCtx({ runId: "run-existing-history", config: { cwd: root }, runtime }));
    expect(runProcessMock.mock.calls[1]?.[3]).toContain("--restore-chat-history");
  });

  it("maps the tokens/cost footer onto usage and flags a quota failure", async () => {
    const root = await makeTempRoot();
    runProcessMock.mockImplementation(okRun(
      [
        "Applied edit to src/app.ts",
        "Tokens: 2.4k sent, 261 received. Cost: $0.0132 message, $0.0410 session.",
      ].join("\n"),
    ));

    const result = await execute(makeCtx({ config: { cwd: root, model: "sonnet" } }));

    expect(result).toMatchObject({
      usage: { inputTokens: 2400, outputTokens: 261 },
      usageBasis: "per_run",
      model: "sonnet",
      costUsd: 0.0132,
    });
    expect(result.resultJson).toMatchObject({
      editedFiles: ["src/app.ts"],
      sessionCostUsd: 0.041,
      resumedChatHistory: false,
    });

    runProcessMock.mockImplementation(async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "litellm.RateLimitError: 429 rate limit exceeded",
    }));

    const failed = await execute(makeCtx({ runId: "run-quota", config: { cwd: root } }));
    expect(failed.errorFamily).toBe("provider_quota");
    expect(failed.errorMessage).toContain("RateLimitError");
  });
});
