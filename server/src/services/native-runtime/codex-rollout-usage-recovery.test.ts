import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { bindCodexRolloutTurnToNativeRun, findCodexRolloutCandidate, parseCodexRolloutTurnUsage } from "./codex-rollout-usage-recovery.js";

const threadId = "00000000-0000-4000-8000-000000000001";
const rootSessionId = "00000000-0000-4000-8000-000000000002";
const providerTurnId = "00000000-0000-4000-8000-000000000003";
const rootTurnId = "00000000-0000-4000-8000-000000000004";
const nativeTurnId = "native-turn-identity";

function rollout(options: { gap?: boolean; mismatch?: boolean; duplicateResponse?: boolean; complete?: boolean; missingRootTurn?: boolean } = {}) {
  const rows: Array<Record<string, unknown>> = [
    { type: "session_meta", payload: { id: threadId, session_id: rootSessionId } },
    { type: "event_msg", payload: { type: "task_started", turn_id: providerTurnId,
      ...(options.missingRootTurn ? {} : { root_turn_id: rootTurnId }) } },
    { type: "token_usage_record", payload: { thread_id: threadId, session_id: rootSessionId,
      turn_id: providerTurnId, root_turn_id: options.missingRootTurn ? providerTurnId : rootTurnId, response_id: "response-1",
      usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 20, total_tokens: 110 },
      turn_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 20, cache_write_input_tokens: 0, total_tokens: 110 } } },
    { type: "token_usage_record", payload: { thread_id: threadId, session_id: rootSessionId,
      turn_id: providerTurnId, root_turn_id: options.mismatch ? "wrong-root" : (options.missingRootTurn ? providerTurnId : rootTurnId),
      response_id: options.duplicateResponse ? "response-1" : "response-2",
      usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 20, total_tokens: 110 },
      turn_token_usage: { input_tokens: 200, output_tokens: 20, cached_input_tokens: 40, cache_write_input_tokens: 0, total_tokens: 220 } } },
    { type: "event_msg", payload: { type: options.complete ? "task_complete" : "turn_aborted", turn_id: providerTurnId } },
  ];
  return rows.map((row, ordinal) => JSON.stringify({ ...row, ordinal: ordinal + (options.gap && ordinal > 1 ? 1 : 0) })).join("\n") + "\n";
}

describe("parseCodexRolloutTurnUsage", () => {
  it("returns the last cumulative usage only for the matching terminally aborted provider turn", () => {
    expect(parseCodexRolloutTurnUsage(rollout(), { threadId, turnId: providerTurnId })).toEqual({
      inputTokens: 200, outputTokens: 20, cachedInputTokens: 40, cacheWriteTokens: 0,
    });
  });

  it("supports a root session distinct from the thread and an omitted root-turn id", () => {
    expect(parseCodexRolloutTurnUsage(rollout({ missingRootTurn: true }), { threadId, turnId: providerTurnId })).not.toBeNull();
  });

  it("rejects a truncated non-newline-terminated JSONL tail", () => {
    expect(parseCodexRolloutTurnUsage(rollout().trimEnd(), { threadId, turnId: providerTurnId })).toBeNull();
  });

  it.each([
    ["ordinal gaps", { gap: true }],
    ["selected turn identity mismatch", { mismatch: true }],
    ["duplicate response id", { duplicateResponse: true }],
    ["completed instead of aborted terminal", { complete: true }],
  ])("rejects %s", (_label, options) => {
    expect(parseCodexRolloutTurnUsage(rollout(options), { threadId, turnId: providerTurnId })).toBeNull();
  });

  it("ignores usage belonging to other turns in the same thread", () => {
    const other = { type: "token_usage_record", payload: { thread_id: threadId, session_id: rootSessionId,
      turn_id: "other-turn", root_turn_id: "other-turn", response_id: "other-response",
      usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, total_tokens: 2 },
      turn_token_usage: { input_tokens: 1, output_tokens: 1, cached_input_tokens: 0, total_tokens: 2 } } };
    const rows = rollout().trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    rows.splice(2, 0, other);
    const input = rows.map((row, ordinal) => JSON.stringify({ ...row, ordinal })).join("\n") + "\n";
    expect(parseCodexRolloutTurnUsage(input, { threadId, turnId: providerTurnId })?.inputTokens).toBe(200);
  });

  it("rejects response usage that does not sum to the reported turn aggregate", () => {
    const rows = rollout().trimEnd().split("\n").map(line => JSON.parse(line) as Record<string, unknown>);
    const payload = rows[3]!.payload as Record<string, unknown>;
    payload.usage = { input_tokens: 90, output_tokens: 10, cached_input_tokens: 20, total_tokens: 100 };
    const input = rows.map((row, ordinal) => JSON.stringify({ ...row, ordinal })).join("\n") + "\n";
    expect(parseCodexRolloutTurnUsage(input, { threadId, turnId: providerTurnId })).toBeNull();
  });
});

describe("findCodexRolloutCandidate", () => {
  it("finds one rollout in the native YYYY/MM/DD history layout", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "codex-rollout-locator-"));
    try {
      const day = path.join(root, "codex-home", "sessions", "2026", "10", "24");
      await mkdir(day, { recursive: true });
      const rollout = path.join(day, `rollout-2026-10-24T00-00-00-${threadId}.jsonl`);
      await writeFile(rollout, "{}\n");
      expect(findCodexRolloutCandidate(root, threadId)).toBe(rollout);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("bindCodexRolloutTurnToNativeRun", () => {
  const expected = { runId: "run-1", runnerInstanceId: "runner-1", normalizedSessionId: "session-1",
  };
  function controlEvents(options: { omitAccepted?: boolean; wrongNativeTurn?: boolean } = {}) {
    const events = [
      ...(options.omitAccepted ? [] : [{ eventType: "turn.accepted", turnId: "native-turn" }]),
      { eventType: "turn.started", turnId: "native-turn", payload: { providerTurnId } },
      { eventType: "usage.reported", turnId: options.wrongNativeTurn ? "other-native-turn" : "native-turn" },
    ];
    const committedEvents = events.map((payload, index) => ({ envelope: { runnerInstanceId: expected.runnerInstanceId, payload: {
      runId: expected.runId, sourceInstanceId: expected.runnerInstanceId, normalizedSessionId: expected.normalizedSessionId,
      sourceSeq: index + 1, ...payload,
    } } }));
    return { control: { committedEvents, commands }, runner: { ackedSourceSeq: committedEvents.length, nextSourceSeq: committedEvents.length + 1 } };
  }
  const commands = [{ type: "turn.start", status: "completed", result: { result: { providerTurnId } } }];

  it.each([false, true])("binds the provider turn independently from the native PRP turn (accepted=%s)", omitAccepted => {
    const bound = bindCodexRolloutTurnToNativeRun(controlEvents({ omitAccepted }), expected);
    expect(bound).toEqual({ providerTurnId, nativeTurnId: "native-turn" });
  });

  it("rejects a native-turn mismatch or an incomplete acknowledged source boundary", () => {
    expect(bindCodexRolloutTurnToNativeRun(controlEvents({ wrongNativeTurn: true }), expected)).toBeNull();
    const truncated = controlEvents();
    truncated.runner.ackedSourceSeq = 2;
    expect(bindCodexRolloutTurnToNativeRun(truncated, expected)).toBeNull();
    const advanced = controlEvents();
    advanced.runner.nextSourceSeq = 5;
    expect(bindCodexRolloutTurnToNativeRun(advanced, expected)).toBeNull();
    const commandMismatch = controlEvents();
    (commandMismatch.control.commands[0]!.result as Record<string, unknown>).result = { providerTurnId: "wrong" };
    expect(bindCodexRolloutTurnToNativeRun(commandMismatch, expected)).toBeNull();
  });
});
