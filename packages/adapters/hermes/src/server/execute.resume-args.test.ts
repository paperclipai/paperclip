import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@paperclipai/adapter-utils/server-utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@paperclipai/adapter-utils/server-utils")>();
  return {
    ...actual,
    runChildProcess: vi.fn(async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "session_id: local-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n",
      stderr: "",
    })),
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

function makeResumeCtx() {
  return {
    runId: "resume-run",
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Hermes",
      adapterType: "hermes_local",
      adapterConfig: {},
    },
    runtime: {
      sessionId: null,
      sessionParams: { sessionId: "local-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" },
      sessionDisplayId: null,
      taskKey: "issue-1",
    },
    config: {
      command: "/usr/bin/hermes",
      provider: "openrouter",
      model: "fixture-model",
      toolsets: "code",
      maxTurnsPerRun: 17,
      worktreeMode: true,
      checkpoints: true,
      quiet: true,
      timeoutSec: 60,
      graceSec: 5,
    },
    context: {
      issueId: "issue-1",
      wakeReason: "manual",
      paperclipWake: null,
    },
    onLog: vi.fn(async () => undefined),
    onMeta: vi.fn(async () => undefined),
    onSpawn: vi.fn(async () => undefined),
  } as any;
}

describe("hermes-local resume argv", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("omits creation flags when resuming a stored session", async () => {
    await execute(makeResumeCtx());
    const args = vi.mocked(serverUtils.runChildProcess).mock.calls.at(-1)![2] as string[];

    expect(args).toContain("--resume");
    for (const flag of ["-m", "--provider", "-t", "--max-turns", "-w", "--checkpoints", "--source", "--yolo"]) {
      expect(args).not.toContain(flag);
    }
  });
});
