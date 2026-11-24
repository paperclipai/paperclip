import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// A native run whose done report outlived a transient provider refusal keeps
// its raw failed terminal in native_run_results (the integrity digest covers
// it) and settles from the saved accepted outcome. Every source line that
// reads a terminal state must be listed here with why it may read it; a new
// reader of the stored result must use native-accepted-outcome instead.
const here = path.dirname(fileURLToPath(import.meta.url));
const sourceRoot = path.resolve(here, "..");
const TERMINAL_STATE_READ = /runTerminalState|turnTerminalState|prp(Run|Turn)TerminalState|\{terminal,|->'terminal'/;

const ALLOWED: ReadonlyArray<readonly [file: string, line: string, reason: string]> = [
  ["services/task-interruption-presentation.ts", "and ${heartbeatRuns.runnerProfileJson}#>>'{sessionCheckpoint,terminal,turnTerminalState}' = 'completed'", "runner session checkpoint, not a stored result"],
  ["services/chat-channels/failed-run-retry.ts", "terminal.turnTerminalState !== \"completed\" ||", "only yielded/blocked results reach here; an accepted outcome only exists for done"],
  ["services/chat-channels/failed-run-retry.ts", "terminal.runTerminalState !== \"succeeded\" ||", "only yielded/blocked results reach here; an accepted outcome only exists for done"],
  ["services/chat-channels/failed-run-retry.ts", "nativeEffectiveTerminal(accepted?.resultJson, { ...(accepted?.resultJson.terminal as Record<string, unknown> | undefined) }).runTerminalState === \"failed\";", "reads the effective outcome (accepted outcome applied)"],
  ["services/recovery/service.ts", "terminal.runTerminalState !== \"succeeded\" ||", "only yielded/blocked results reach here; an accepted outcome only exists for done"],
  ["services/recovery/service.ts", "terminal.turnTerminalState !== \"completed\" ||", "only yielded/blocked results reach here; an accepted outcome only exists for done"],
  ["services/native-runtime/native-task-session-publication.ts", "return snapshot.goal == null && snapshot.semanticResult != null && snapshot.terminal?.runTerminalState === \"succeeded\"", "runner session snapshot; a turn that failed is not published for resume, so the next turn starts from saved context"],
  ["services/native-runtime/status-decision-committer.ts", "terminal.schema !== \"paperclip.prp.terminal.v1\" || terminal.runTerminalState !== \"succeeded\" || terminal.turnTerminalState !== \"completed\" || terminal.reportedWorkDisposition !== \"yielded\") throw new NativeStatusRaceError();", "only yielded/blocked results reach here; an accepted outcome only exists for done"],
  ["services/native-runtime/status-decision-committer.ts", "terminal.runTerminalState !== \"succeeded\" || terminal.turnTerminalState !== \"completed\" ||", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-board-response-wait.ts", "terminal.runTerminalState !== \"succeeded\" ||", "only yielded/blocked results reach here; an accepted outcome only exists for done"],
  ["services/native-runtime/native-board-response-wait.ts", "terminal.turnTerminalState !== \"completed\" ||", "only yielded/blocked results reach here; an accepted outcome only exists for done"],
  ["services/native-runtime/native-session-executor.ts", "terminal.turnTerminalState !== \"completed\" ||", "retained-cleanup proof recomputes the result digest over the raw terminal; an accepted-outcome run takes the conservative cleanup path"],
  ["services/native-runtime/native-session-executor.ts", "terminal.runTerminalState !== \"succeeded\" ||", "retained-cleanup proof recomputes the result digest over the raw terminal; an accepted-outcome run takes the conservative cleanup path"],
  ["services/native-runtime/native-session-executor.ts", "record(checkpointRecord.terminal).runTerminalState !== \"failed\"", "runner session checkpoint, not a stored result"],
  ["services/native-runtime/native-session-executor.ts", "result.terminal.runTerminalState === \"succeeded\" ? \"ok\" : \"failed\",", "runner's own terminal in memory before acceptance"],
  ["services/native-runtime/native-session-executor.ts", "if (native.terminal.runTerminalState === \"succeeded\" || acceptedOutcome) {", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-session-executor.ts", "exitCode: terminal.runTerminalState === \"succeeded\" ? 0 : 1,", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-session-executor.ts", "terminal.runTerminalState === \"succeeded\"", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-session-executor.ts", "?? `Native session ${terminal.runTerminalState}`,", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-session-executor.ts", "terminal.runTerminalState === \"succeeded\" ? \"ok\" : \"failed\",", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-codex-runner.ts", "const succeeded = completed === null || completed.terminal.runTerminalState === \"succeeded\";", "runner's own terminal in memory, before or at acceptance; the accepted outcome does not exist yet"],
  ["services/native-runtime/native-run-coordinator-store.ts", "typeof terminal.turnTerminalState !== \"string\" ||", "checks the stored terminal is well formed, not which outcome it settles"],
  ["services/native-runtime/native-run-coordinator-store.ts", "terminal.turnTerminalState,", "checks the stored terminal is well formed, not which outcome it settles"],
  ["services/native-runtime/native-run-coordinator-store.ts", "typeof terminal.runTerminalState !== \"string\" ||", "checks the stored terminal is well formed, not which outcome it settles"],
  ["services/native-runtime/native-run-coordinator-store.ts", "![\"succeeded\", \"failed\", \"cancelled\"].includes(terminal.runTerminalState) ||", "checks the stored terminal is well formed, not which outcome it settles"],
  ["services/native-runtime/native-plan-wait.ts", "terminal.schema !== \"paperclip.prp.terminal.v1\" || terminal.runTerminalState !== \"succeeded\" || terminal.turnTerminalState !== \"completed\" || terminal.reportedWorkDisposition !== \"yielded\") return false;", "only yielded/blocked results reach here; an accepted outcome only exists for done"],
  ["services/native-runtime/native-provider-failure.ts", "terminal: Pick<PrpTerminalState, \"turnTerminalState\" | \"runTerminalState\" | \"reportedWorkDisposition\">;", "runner's own terminal in memory, before or at acceptance; the accepted outcome does not exist yet"],
  ["services/native-runtime/native-provider-failure.ts", "if (input.terminal.runTerminalState !== \"failed\" || input.terminal.turnTerminalState !== \"failed\" ||", "runner's own terminal in memory, before or at acceptance; the accepted outcome does not exist yet"],
  ["services/native-runtime/native-provider-failure.ts", "if (!turnId || terminal.turnTerminalState !== \"failed\" || terminal.runTerminalState !== \"failed\") return null;", "runner's own terminal in memory, before or at acceptance; the accepted outcome does not exist yet"],
  ["services/native-runtime/native-provider-failure.ts", "if (!turnId || terminal.turnTerminalState !== \"failed\" || terminal.runTerminalState !== \"failed\" ||", "runner's own terminal in memory, before or at acceptance; the accepted outcome does not exist yet"],
  ["services/native-runtime/native-accepted-result-settlement.ts", "if (terminal.schema !== \"paperclip.prp.terminal.v1\" || !RUN_TERMINAL_STATES.has(String(terminal.runTerminalState))) return null;", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-accepted-result-settlement.ts", "const succeeded = nativeTerminal.runTerminalState === \"succeeded\";", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-accepted-result-settlement.ts", "errorMessage: succeeded ? null : `Native session ${nativeTerminal.runTerminalState}`,", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/completed-turn-cleanup-hold-settlement.ts", "and run.runner_profile_json->'sessionCheckpoint'->'terminal'->>'turnTerminalState' = 'completed'`;", "runner session checkpoint, not a stored result"],
  ["services/native-runtime/native-chat-review-presentation.ts", "record(canonical.terminal).runTerminalState !== \"succeeded\" ||", "only yielded/blocked results reach here; an accepted outcome only exists for done"],
  ["services/native-runtime/native-response-presentation-query.ts", "sql`${nativeEffectiveRunTerminalStateSql(nativeRunResults.resultJson, \"turnTerminalState\")} = 'completed'`,", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-response-presentation-query.ts", "sql`${nativeRunResults.resultJson} #>> '{terminal,reportedWorkDisposition}' = 'done'`),", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-response-presentation-query.ts", "sql`${nativeRunResults.resultJson} #>> '{terminal,reportedWorkDisposition}' = 'needs_review'`),", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-response-presentation-query.ts", "sql`${nativeRunResults.resultJson} #>> '{terminal,reportedWorkDisposition}' = 'blocked'`,", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-response-presentation-query.ts", "sql`${nativeRunResults.resultJson} #>> '{terminal,reportedWorkDisposition}' = 'yielded'`),", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-response-presentation-query.ts", "sql`${nativeRunResults.resultJson} #>> '{terminal,reportedWorkDisposition}' = 'yielded'`,", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-finalization-upgrade-readiness.ts", "terminalState: sql<string>`${nativeRunResults.resultJson}->'terminal'->>'runTerminalState'` }).from(nativeRunResults).where(and(eq(nativeRunResults.id, coordinator.resultId),", "checks the stored terminal is well formed, not which outcome it settles"],
  ["services/native-runtime/preserved-native-result-finalization.ts", "terminalDisposition: sql<string>`${nativeRunResults.resultJson}#>>'{terminal,reportedWorkDisposition}'`,", "reported disposition is the same in the raw and effective terminal"],
  ["services/native-runtime/completed-turn-cleanup.ts", "&& terminal.turnTerminalState === \"completed\";", "runner session checkpoint, not a stored result"],
  ["services/native-runtime/native-restart-recovery.ts", "?.runTerminalState === \"failed\" &&", "runner session checkpoint, not a stored result"],
  ["services/native-runtime/paperclip-control-plane-port.ts", "|| ![\"completed\", \"failed\", \"interrupted\", \"cancelled\"].includes(String(terminal.turnTerminalState))", "checks the terminal is well formed, not which outcome it settles"],
  ["services/native-runtime/paperclip-control-plane-port.ts", "|| ![\"succeeded\", \"failed\", \"cancelled\"].includes(String(terminal.runTerminalState))", "checks the terminal is well formed, not which outcome it settles"],
  ["services/native-runtime/paperclip-control-plane-port.ts", "const acceptedOutcome = value.terminal.runTerminalState === \"failed\" && value.terminal.reportedWorkDisposition === \"done\"", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/paperclip-control-plane-port.ts", "prpTurnTerminalState: effectiveTerminal.turnTerminalState,", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/paperclip-control-plane-port.ts", "prpRunTerminalState: effectiveTerminal.runTerminalState,", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-run-finalizer.ts", "const accepted = record(run.resultJson).prpRunTerminalState;", "saved prpRunTerminalState is written effective at acceptance"],
  ["services/native-runtime/native-run-finalizer.ts", ").prpRunTerminalState;", "saved prpRunTerminalState is written effective at acceptance"],
  ["services/native-runtime/native-run-finalizer.ts", "terminal.runTerminalState === \"succeeded\" && terminal.turnTerminalState === \"completed\" &&", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-run-finalizer.ts", "terminal.runTerminalState === \"succeeded\" &&", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-run-finalizer.ts", "terminal.turnTerminalState === \"completed\" &&", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-run-finalizer.ts", "terminal.runTerminalState !== \"succeeded\" ||", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-run-finalizer.ts", "terminal.turnTerminalState !== \"completed\" ||", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-run-finalizer.ts", "if (![\"succeeded\", \"failed\", \"cancelled\"].includes(String(terminal.runTerminalState))) {", "checks the terminal is well formed, not which outcome it settles"],
  ["services/native-runtime/native-run-finalizer.ts", "const terminalState = applyNativeAcceptedOutcome(acceptedOutcome, terminal).runTerminalState;", "reads the effective outcome (accepted outcome applied)"],
  ["services/native-runtime/native-provider-failure-evidence.ts", "terminal.turnTerminalState !== \"failed\" || terminal.runTerminalState !== \"failed\") return null;", "reads the committed turn failure itself, which decides the accepted outcome"],
  ["services/heartbeat/run-completion.ts", "adapterResult.nativeFinalization.terminal.runTerminalState;", "adapter result terminal, already effective (the executor applies the accepted outcome)"],
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "__tests__" || entry.name === "vendor" ? [] : sourceFiles(full);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [full] : [];
  });
}

function terminalStateReads() {
  return sourceFiles(sourceRoot).flatMap(file => {
    const relative = path.relative(sourceRoot, file).split(path.sep).join("/");
    if (relative === "services/native-runtime/native-accepted-outcome.ts") return [];
    return readFileSync(file, "utf8").split("\n").map(line => line.trim())
      .filter(line => TERMINAL_STATE_READ.test(line)).map(line => `${relative} | ${line}`);
  });
}

describe("readers of a stored native terminal state", () => {
  it("lists every terminal-state read with a reason, and nothing stale", () => {
    const allowed = new Set(ALLOWED.map(([file, line]) => `${file} | ${line}`));
    const found = new Set(terminalStateReads());
    expect([...found].filter(read => !allowed.has(read)), "unlisted reads: settle them through native-accepted-outcome or list them with a reason").toEqual([]);
    expect([...allowed].filter(entry => !found.has(entry)), "stale allowlist entries").toEqual([]);
    expect(ALLOWED.every(([, , reason]) => reason.trim().length > 0)).toBe(true);
  });
});
