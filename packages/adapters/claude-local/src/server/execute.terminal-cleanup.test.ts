import { randomUUID } from "node:crypto";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { describe, expect, it } from "vitest";

import { parseClaudeStreamJson } from "./parse.js";

// The predicate the claude-local adapter hands to runChildProcess as
// `terminalResultCleanup.hasTerminalResult` (see execute.ts). Kept identical so
// these tests exercise the shipped arming decision, not a stand-in.
const hasTerminalResult = ({ stdout }: { stdout: string; stderr: string }) =>
  parseClaudeStreamJson(stdout).resultJson !== null;

const CLEANUP_GRACE_MS = 150;
const LIVE_AFTER_RESULT_MS = 900;

const line = (event: Record<string, unknown>) => JSON.stringify(event);

// Observed stream of run 88f17b87 (2026-10-24): two orphaned-background-task
// notices, an init, the resumed session's replayed aggregate, then the real
// init that starts this attempt's work. LAC-5387.
const RESUME_REPLAY_LINES = [
  line({
    type: "system",
    subtype: "task_notification",
    status: "stopped",
    message: "Orphaned by a previous Claude Code process exit",
  }),
  line({ type: "system", subtype: "init", session_id: "832e92dc" }),
  line({
    type: "result",
    subtype: "success",
    is_error: false,
    num_turns: 0,
    duration_ms: 117,
    duration_api_ms: 0,
    stop_reason: null,
    total_cost_usd: 3.91,
    result: "",
    session_id: "832e92dc",
  }),
  line({ type: "system", subtype: "init", session_id: "832e92dc" }),
  line({
    type: "assistant",
    session_id: "832e92dc",
    message: { content: [{ type: "text", text: "Reading the issue." }] },
  }),
];

const REAL_RESULT_LINE = line({
  type: "result",
  subtype: "success",
  is_error: false,
  num_turns: 14,
  duration_ms: 182_344,
  duration_api_ms: 161_902,
  stop_reason: "end_turn",
  total_cost_usd: 1.42,
  result: "Done.",
  session_id: "832e92dc",
});

/** A child that writes the given stream-json lines, then stays alive. */
const emitThenLinger = (lines: string[], lingerMs: number) => [
  "-e",
  [
    `const lines = ${JSON.stringify(lines)};`,
    "for (const l of lines) process.stdout.write(`${l}\\n`);",
    `setTimeout(() => process.exit(0), ${lingerMs});`,
  ].join(" "),
];

const runWithCleanup = (args: string[]) =>
  runChildProcess(randomUUID(), process.execPath, args, {
    cwd: process.cwd(),
    env: {},
    timeoutSec: 0,
    graceSec: 1,
    onLog: async () => {},
    terminalResultCleanup: {
      graceMs: CLEANUP_GRACE_MS,
      hasTerminalResult,
    },
  });

describe("terminal-result cleanup arming for claude-local", () => {
  it.skipIf(process.platform === "win32")(
    "never arms on the aggregate result a resumed session replays before any work",
    async () => {
      // LAC-5387. The child lingers ~6x the grace window after the replayed
      // result, so an armed timer would SIGTERM it before it exits on its own.
      const result = await runWithCleanup(emitThenLinger(RESUME_REPLAY_LINES, LIVE_AFTER_RESULT_MS));

      expect(result.signal).toBeNull();
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "still arms on the attempt's own terminal result after a replayed aggregate",
    async () => {
      // LAC-4514's half: once the real result lands, reaping the lingering
      // process group is the intended behaviour and must survive the fix above.
      const result = await runWithCleanup(
        emitThenLinger([...RESUME_REPLAY_LINES, REAL_RESULT_LINE], 10_000),
      );

      expect(result.signal).toBe("SIGTERM");
      expect(result.timedOut).toBe(false);
    },
  );
});
