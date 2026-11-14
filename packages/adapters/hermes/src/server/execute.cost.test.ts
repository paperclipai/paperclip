import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(),
  };
});

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => ""),
  writeFile: vi.fn(async () => undefined),
  mkdir: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
  access: vi.fn(async () => undefined),
  readdir: vi.fn(async () => []),
  stat: vi.fn(async () => ({ isFile: () => true, isDirectory: () => false })),
}));

import { execute } from "./execute.js";
import * as serverUtils from "@paperclipai/adapter-utils/server-utils";

const SESSION_ID = "20261016_101500_a1b2c3";

const EXIT_SUMMARY = [
  "",
  "Resume this session with:",
  `  hermes --resume ${SESSION_ID} -p worker`,
  '  hermes -c "Q3 cost 2026 review" -p worker',
  "",
  `Session:        ${SESSION_ID}`,
  "Title:          Q3 cost 2026 review",
  "Duration:       2m 5s",
  "Messages:       12 (1 user, 9 tool calls)",
  "",
].join("\n");

const AGENT_PROSE = [
  "Query: Budget note: the planner spent 24000c of 1500c this month.",
  "",
  "Verification finished.",
  "Cost: 240 emit+overlay runs, all green.",
  "Total cost: $29",
  "tokens: 500 in, 200 out per frame",
  "",
].join("\n");

const COST_LINES = "Tokens: 1200 input, 340 output\nCost: $0.42\n";

async function runWithOutput(stdout: string, stderr: string, timedOut: boolean) {
  vi.mocked(serverUtils.runChildProcess).mockResolvedValueOnce({
    exitCode: timedOut ? null : 0,
    signal: timedOut ? "SIGTERM" : null,
    timedOut,
    stdout,
    stderr,
    pid: null,
    startedAt: null,
  });
  return execute({
    runId: "test-run-cost",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { command: "/usr/bin/hermes", timeoutSec: 60, graceSec: 5 },
    context: { issueId: "issue-1", wakeReason: "manual", paperclipWake: null },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
  } as any);
}

describe("hermes-local adapter cost and usage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    ["the prompt echo and the agent answer", AGENT_PROSE + EXIT_SUMMARY, "", false],
    ["the session title in the exit summary", "Done.\n" + EXIT_SUMMARY, "", false],
    ["cost lines after the exit summary", AGENT_PROSE + EXIT_SUMMARY + COST_LINES, "", false],
    ["a quoted exit summary in a run that timed out", AGENT_PROSE + EXIT_SUMMARY + COST_LINES, "", true],
    ["a quoted resume command in a run that timed out", "Run:\n  hermes --resume x\n\nNote: x\nCost: 99\n", "", true],
    ["a session_id line in the agent answer", `Log:\nsession_id: ${SESSION_ID}\n${COST_LINES}`, "", false],
    ["cost lines after the quiet-mode session line", AGENT_PROSE, `\nsession_id: ${SESSION_ID}\n${COST_LINES}`, false],
  ])("does not book cost or usage from %s", async (_source, stdout, stderr, timedOut) => {
    const result = await runWithOutput(stdout, stderr, timedOut);

    expect(serverUtils.runChildProcess).toHaveBeenCalledTimes(1);
    expect(result.costUsd).toBeUndefined();
    expect(result.usage).toBeUndefined();
    expect(result.resultJson).not.toHaveProperty("cost_usd");
    expect(result.resultJson).not.toHaveProperty("usage");
  });
});
