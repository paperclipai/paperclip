import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";

const runChildProcessMock = vi.hoisted(() => vi.fn());

vi.mock("@paperclipai/adapter-utils/server-utils", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/adapter-utils/server-utils")>(
    "@paperclipai/adapter-utils/server-utils",
  );
  return {
    ...actual,
    runChildProcess: runChildProcessMock,
  };
});

import { execute } from "./execute.js";

const tempRoots: string[] = [];
const previousHome = process.env.HOME;
const previousUserProfile = process.env.USERPROFILE;
const previousHermesStateDb = process.env.HERMES_STATE_DB;

async function makeHermesHome(configLines: string[]) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hermes-execute-"));
  const hermesDir = path.join(root, ".hermes");
  await fs.mkdir(hermesDir, { recursive: true });
  await fs.writeFile(path.join(hermesDir, "config.yaml"), `${configLines.join("\n")}\n`, "utf8");
  tempRoots.push(root);
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  return root;
}

afterEach(async () => {
  runChildProcessMock.mockReset();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = previousUserProfile;
  if (previousHermesStateDb === undefined) delete process.env.HERMES_STATE_DB;
  else process.env.HERMES_STATE_DB = previousHermesStateDb;
  await Promise.all(tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("hermes execute", () => {
  it("defaults to quiet mode and preserves matching custom Hermes config providers", async () => {
    const root = await makeHermesHome([
      "model:",
      "  default: grok-4.5",
      "  provider: xai-oauth",
      "  base_url: https://api.x.ai/v1",
    ]);

    runChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: [
        "session_id: sess-1",
        "Warning: Unknown toolsets: messaging",
        "OK",
      ].join("\n"),
      stderr: "",
    });

    const logs: Array<{ stream: "stdout" | "stderr"; chunk: string }> = [];
    const ctx: AdapterExecutionContext = {
      runId: "run-1",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes Agent",
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
        cwd: root,
        model: "grok-4.5",
      },
      context: {},
      authToken: "run-token",
      onLog: async (stream: "stdout" | "stderr", chunk: string) => {
        logs.push({ stream, chunk });
      },
    };

    const result = await execute(ctx);

    expect(runChildProcessMock).toHaveBeenCalledTimes(1);
    const call = runChildProcessMock.mock.calls[0] as [string, string, string[]];
    expect(call[1]).toBe("hermes");
    expect(call[2]).toEqual(expect.arrayContaining([
      "chat",
      "-q",
      "-Q",
      "-m",
      "grok-4.5",
      "--provider",
      "xai-oauth",
      "--source",
      "tool",
      "--yolo",
    ]));

    expect(result).toMatchObject({
      exitCode: 0,
      provider: "xai-oauth",
      model: "grok-4.5",
      summary: "OK",
      sessionDisplayId: "sess-1",
      sessionParams: { sessionId: "sess-1" },
      resultJson: {
        result: "OK",
        session_id: "sess-1",
      },
    });
    expect(logs.some((entry) => entry.chunk.includes("provider=xai-oauth [hermesConfig]"))).toBe(true);
  });

  it("lets adapter config opt out of quiet mode explicitly", async () => {
    const root = await makeHermesHome([
      "model:",
      "  default: grok-4.5",
      "  provider: xai-oauth",
    ]);

    runChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "OK",
      stderr: "",
    });

    const ctx: AdapterExecutionContext = {
      runId: "run-quiet-false",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes Agent",
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
        cwd: root,
        model: "grok-4.5",
        quiet: false,
      },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    };

    await execute(ctx);

    const call = runChildProcessMock.mock.calls[0] as [string, string, string[]];
    expect(call[2]).not.toContain("-Q");
  });

  it("caps recovery-only wakes to two turns and does not inject managed instructions", async () => {
    const root = await makeHermesHome(["model:", "  default: grok-4.5", "  provider: xai-oauth"]);
    const instructionsPath = path.join(root, "AGENTS.md");
    await fs.writeFile(instructionsPath, "# Very large managed instruction bundle", "utf8");
    runChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "session_id: sess-recovery\nRecorded disposition",
      stderr: "",
    });

    const ctx: AdapterExecutionContext = {
      runId: "run-recovery",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes Agent",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root, model: "grok-4.5", maxTurnsPerRun: 10, instructionsFilePath: instructionsPath },
      context: {
        issueId: "issue-1",
        paperclipWake: {
          reason: "source_scoped_recovery_action",
          issue: { id: "issue-1", identifier: "PAP-778", title: "Record state", status: "blocked" },
          recovery: { cause: "successful_run_missing_state", attemptCount: 1, nextAction: "Record state." },
          commentWindow: { requestedCount: 0, includedCount: 0, missingCount: 0 },
          comments: [],
          fallbackFetchNeeded: false,
        },
      },
      authToken: "run-token",
      onLog: async () => {},
    };

    await execute(ctx);

    const call = runChildProcessMock.mock.calls[0] as [string, string, string[]];
    expect(call[2]).toContain("--max-turns");
    expect(call[2][call[2].indexOf("--max-turns") + 1]).toBe("2");
    const prompt = call[2][call[2].indexOf("-q") + 1];
    expect(prompt).toContain("Recovery contract");
    expect(prompt).not.toContain("Very large managed instruction bundle");
  });

  it("records Hermes session usage from the per-model usage ledger", async () => {
    const root = await makeHermesHome(["model:", "  default: grok-4.5", "  provider: xai-oauth"]);
    const stateDbPath = path.join(root, ".hermes", "state.db");
    process.env.HERMES_STATE_DB = stateDbPath;
    execFileSync("sqlite3", [
      stateDbPath,
      [
        "CREATE TABLE sessions (id TEXT PRIMARY KEY);",
        "CREATE TABLE session_model_usage (",
        "session_id TEXT NOT NULL, model TEXT NOT NULL, billing_provider TEXT NOT NULL DEFAULT '',",
        "billing_base_url TEXT NOT NULL DEFAULT '', billing_mode TEXT NOT NULL DEFAULT '', task TEXT NOT NULL DEFAULT '',",
        "input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0",
        ");",
        "INSERT INTO sessions (id) VALUES ('sess-ledger');",
        "INSERT INTO session_model_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens)",
        "VALUES ('sess-ledger', 'grok-4.5', 120, 30, 450);",
        "INSERT INTO session_model_usage (session_id, model, task, input_tokens, output_tokens, cache_read_tokens)",
        "VALUES ('sess-ledger', 'grok-4.5', 'follow-up', 80, 20, 150);",
      ].join(" "),
    ]);
    expect(
      JSON.parse(
        execFileSync("sqlite3", [
          "-readonly",
          "-json",
          stateDbPath,
          "SELECT SUM(input_tokens) AS inputTokens FROM session_model_usage WHERE session_id = 'sess-ledger';",
        ]).toString(),
      ),
    ).toEqual([{ inputTokens: 200 }]);
    runChildProcessMock.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      stdout: "session_id: sess-ledger\nDone",
      stderr: "",
    });

    const result = await execute({
      runId: "run-ledger",
      agent: {
        id: "agent-1",
        companyId: "company-1",
        name: "Hermes Agent",
        adapterType: "hermes_local",
        adapterConfig: {},
      },
      runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
      config: { cwd: root, model: "grok-4.5" },
      context: {},
      authToken: "run-token",
      onLog: async () => {},
    });

    expect(result.resultJson?.session_id).toBe("sess-ledger");
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 50, cachedInputTokens: 600 });
    expect(result.usageBasis).toBe("session_cumulative");
    expect(result.resultJson?.usage).toEqual({ inputTokens: 200, outputTokens: 50, cachedInputTokens: 600 });
  });
});
