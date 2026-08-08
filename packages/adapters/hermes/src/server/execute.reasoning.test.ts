import { beforeEach, describe, expect, it, vi } from "vitest";

const hermesTestState = vi.hoisted(() => ({
  responses: [] as Array<{
    exitCode: number | null;
    signal: string | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
  }>,
}));

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => hermesTestState.responses.shift() ?? {
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Recovered final answer.\nsession_id: recovered-session\n",
      stderr: "",
    }),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

// Captured Laguna-shaped completion: the model emitted an interleaved
// reasoning block but never reached a final answer or a tool call.
const LAGUNA_REASONING_ONLY_COMPLETION = [
  "<think>",
  "Wait — let me reconsider. Am I truly unable to use curl?",
  "I should inspect the available tools before deciding what to do.",
  "</think>",
  "session_id: laguna-reasoning-only",
].join("\n");

const LAGUNA_PLAIN_REASONING_ONLY_COMPLETION = [
  "Wait — let me reconsider. Am I truly unable to use curl?",
  "I should inspect the available tools before deciding what to do.",
  "session_id: laguna-plain-reasoning-only",
].join("\n");

function makeCtx() {
  return {
    runId: "test-run-reasoning",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: null,
      sessionDisplayId: null,
      taskKey: null,
    },
    config: {
      command: "/usr/bin/hermes",
      model: "laguna-s-2.1:q4_K_M",
      provider: "ollama-launch",
      timeoutSec: 1800,
      graceSec: 5,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: null,
    },
    onLog: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  };
}

describe("hermes-local Laguna reasoning recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hermesTestState.responses = [];
  });

  it("reprompts once after a reasoning-only completion and resumes the session", async () => {
    hermesTestState.responses.push(
      {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: LAGUNA_REASONING_ONLY_COMPLETION,
        stderr: "",
      },
      {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "I inspected the repository and completed the requested action.\nsession_id: laguna-recovered\n",
        stderr: "",
      },
    );

    const result = await execute(makeCtx() as never);

    const calls = vi.mocked(serverUtils.runChildProcess).mock.calls;
    expect(calls).toHaveLength(2);
    expect(calls[1]?.[2]).toContain("--resume");
    expect(calls[1]?.[2]).toContain("laguna-reasoning-only");
    const retryArgs = calls[1]?.[2] as string[];
    expect(retryArgs[retryArgs.indexOf("-q") + 1]).toContain("exactly one final answer or one parseable tool call");
    expect(result.exitCode).toBe(0);
    expect(result.summary).toContain("completed the requested action");
    expect(result.summary).not.toContain("Wait — let me reconsider");
  });

  it("fails cleanly after the single reprompt without leaking reasoning into the error", async () => {
    hermesTestState.responses.push(
      {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: LAGUNA_REASONING_ONLY_COMPLETION,
        stderr: "",
      },
      {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: LAGUNA_REASONING_ONLY_COMPLETION,
        stderr: "",
      },
    );

    const result = await execute(makeCtx() as never);

    expect(vi.mocked(serverUtils.runChildProcess)).toHaveBeenCalledTimes(2);
    expect(result.errorCode).toBe("hermes_local_unparseable_response");
    expect(result.errorMessage).toBe("Hermes returned reasoning without a final answer or tool call after one recovery attempt.");
    expect(result.errorMessage).not.toContain("Wait — let me reconsider");
    expect(result.resultJson?.result).toBe("");
    expect(result.summary).toBeUndefined();
  });

  it("recognizes untagged leaked reasoning and keeps it out of the recovery result", async () => {
    hermesTestState.responses.push(
      {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: LAGUNA_PLAIN_REASONING_ONLY_COMPLETION,
        stderr: "",
      },
      {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: LAGUNA_PLAIN_REASONING_ONLY_COMPLETION,
        stderr: "",
      },
    );

    const result = await execute(makeCtx() as never);

    expect(vi.mocked(serverUtils.runChildProcess)).toHaveBeenCalledTimes(2);
    expect(result.errorCode).toBe("hermes_local_unparseable_response");
    expect(result.errorMessage).not.toContain("Am I truly unable to use curl");
  });

  it("separates a parseable tool call from reasoning without leaking the reasoning", async () => {
    hermesTestState.responses.push({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        "<think>Inspect the repository before choosing a tool.</think>",
        "<tool_call>shell<arg_key>command</arg_key><arg_value>pwd</arg_value></tool_call>",
        "session_id: laguna-tool-call",
      ].join("\n"),
      stderr: "",
    });

    const result = await execute(makeCtx() as never);

    expect(vi.mocked(serverUtils.runChildProcess)).toHaveBeenCalledTimes(1);
    expect(result.errorMessage).toBeUndefined();
    expect(result.summary).toBeUndefined();
    expect(result.resultJson?.result).toBe("");
  });

  it("reprompts when a tool-call block is present but malformed", async () => {
    hermesTestState.responses.push(
      {
        exitCode: 1,
        signal: null,
        timedOut: false,
        stdout: [
          "<think>Choose a tool and emit its arguments.</think>",
          "<tool_call>not a valid Hermes tool call</tool_call>",
          "session_id: laguna-malformed-tool-call",
        ].join("\n"),
        stderr: "",
      },
      {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: "The tool call completed successfully.\nsession_id: laguna-tool-recovered\n",
        stderr: "",
      },
    );

    const result = await execute(makeCtx() as never);

    const calls = vi.mocked(serverUtils.runChildProcess).mock.calls;
    expect(calls).toHaveLength(2);
    const retryArgs = calls[1]?.[2] as string[];
    expect(retryArgs[retryArgs.indexOf("-q") + 1]).toContain(
      "exactly one final answer or one parseable tool call",
    );
    expect(result.summary).toContain("tool call completed successfully");
  });

  it("passes the configured timeoutSec through to Hermes inference", async () => {
    hermesTestState.responses.push({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "Completed within the configured headroom.\nsession_id: timeout-session\n",
      stderr: "",
    });

    const ctx = makeCtx();
    ctx.config.timeoutSec = 321;
    await execute(ctx as never);

    const options = vi.mocked(serverUtils.runChildProcess).mock.calls[0]?.[3] as { timeoutSec: number };
    expect(options.timeoutSec).toBe(321);
  });
});
