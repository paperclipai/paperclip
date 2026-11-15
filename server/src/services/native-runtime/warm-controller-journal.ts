import type { Db } from "@paperclipai/db";
import { RUNNERD_CONTROL_PLANE_STATE_SCHEMAS } from "./native-bootstrap-proof.js";
import { loadNativeRunnerCheckpoint } from "./native-runner-checkpoint.js";

type Binding = { companyId: string; issueId: string; runId: string };
type JournalEntry = { commandId: string; controllerSeq: number };

const IDENTITY_FIELDS = ["runId", "runnerInstanceId", "environmentLeaseId", "normalizedSessionId", "turnId", "itemId"] as const;
const CLOSE_COMMAND_ID = /^command_close_(drain|suspend)_[0-9a-f]{32}$/;
export const CONTROLLER_JOURNAL_BEHIND_RUNNER = "native_controller_recovery_missing_evidence:controller_journal_behind_runner";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function parseFullControlState(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const state = record(JSON.parse(text));
    return RUNNERD_CONTROL_PLANE_STATE_SCHEMAS.has(String(state.schema)) && Array.isArray(state.commands) ? state : null;
  } catch {
    return null;
  }
}

function journal(state: Record<string, unknown>): JournalEntry[] {
  return (state.commands as unknown[]).map(record).map(command => ({
    commandId: String(command.commandId), controllerSeq: Number(command.controllerSeq),
  }));
}

function highestSeq(entries: readonly JournalEntry[]): number {
  return entries.reduce((highest, entry) => Math.max(highest, entry.controllerSeq), 0);
}

function sameIdentity(left: unknown, right: unknown): boolean {
  const a = record(left), b = record(right);
  return IDENTITY_FIELDS.every(field => typeof a[field] === "string" && a[field] === b[field]);
}

export function controllerJournalExtends(saved: readonly JournalEntry[], projected: readonly JournalEntry[]): boolean {
  return saved.length >= projected.length && projected.every((entry, index) =>
    saved[index]?.commandId === entry.commandId && saved[index]?.controllerSeq === entry.controllerSeq);
}

async function readCanonicalControlState(db: Db, binding: Binding, normalizedSessionId: string) {
  const checkpoint = await loadNativeRunnerCheckpoint(db, binding);
  if (!checkpoint || checkpoint.recoveryEvidence.normalizedSessionId !== normalizedSessionId) return null;
  try {
    const header = record(JSON.parse(checkpoint.records.get("header") ?? "null"));
    const commands = [...checkpoint.records].filter(([part]) => /^command:\d+$/.test(part))
      .map(([, contents]) => record(JSON.parse(contents)))
      .sort((left, right) => Number(left.controllerSeq) - Number(right.controllerSeq));
    return { checkpoint, state: { identity: record(header.state).identity, commands } as Record<string, unknown> };
  } catch {
    return null;
  }
}

export type ControllerProjectionInput = {
  db: Db;
  binding: Binding;
  normalizedSessionId: string;
  root: string;
  readControlState: () => string | null;
};

export async function refreshRetiredWarmOwnerProjection(input: ControllerProjectionInput): Promise<"refreshed" | "unchanged"> {
  const projectedText = input.readControlState();
  const projected = parseFullControlState(projectedText);
  if (!projected || record(projected.identity).runId !== input.binding.runId) return "unchanged";
  const canonical = await readCanonicalControlState(input.db, input.binding, input.normalizedSessionId);
  if (!canonical) return "unchanged";
  if (!sameIdentity(canonical.state.identity, projected.identity)
    || !controllerJournalExtends(journal(canonical.state), journal(projected))) {
    throw new Error("native_runner_checkpoint_projection_held:retired_owner_journal_diverged");
  }
  if (journal(canonical.state).length === journal(projected).length) return "unchanged";
  if (input.readControlState() !== projectedText) throw new Error("native_runner_checkpoint_projection_held:journal_changed");
  canonical.checkpoint.restoreSessionDirectory(input.root);
  return "refreshed";
}

function settledCloseAhead(runnerState: Record<string, unknown>, journalSeq: number, runnerSeq: number): JournalEntry[] | null {
  const processed = Object.values(record(runnerState.processedCommands)).map(record);
  const last = processed.find(command => command.controllerSeq === runnerSeq);
  if (last?.commandType !== "runner.suspend" || last.status !== "completed") return null;
  const missing = processed.filter(command => Number(command.controllerSeq) > journalSeq)
    .sort((left, right) => Number(left.controllerSeq) - Number(right.controllerSeq));
  const provable = missing.length === runnerSeq - journalSeq && missing.every((command, index) =>
    command.controllerSeq === journalSeq + index + 1 && command.status === "completed"
    && (command.commandType === "runner.drain" || command.commandType === "runner.suspend")
    && CLOSE_COMMAND_ID.test(String(command.commandId)));
  if (!provable) throw new Error(CONTROLLER_JOURNAL_BEHIND_RUNNER);
  return missing.map(command => ({ commandId: String(command.commandId), controllerSeq: Number(command.controllerSeq) }));
}

export async function reconcileControllerJournalWithRunner(input: ControllerProjectionInput & {
  runnerState: Record<string, unknown>;
}): Promise<"reconciled" | "unchanged"> {
  const projectedText = input.readControlState();
  const projected = parseFullControlState(projectedText);
  if (!projected || !sameIdentity(projected.identity, input.runnerState)) return "unchanged";
  const projectedJournal = journal(projected);
  const journalSeq = highestSeq(projectedJournal);
  const runnerSeq = Number(input.runnerState.lastControllerCommandSeq);
  if (!Number.isSafeInteger(runnerSeq) || runnerSeq <= journalSeq) return "unchanged";
  const missing = settledCloseAhead(input.runnerState, journalSeq, runnerSeq);
  if (!missing) return "unchanged";
  const canonical = await readCanonicalControlState(input.db, input.binding, input.normalizedSessionId);
  if (!canonical || !sameIdentity(canonical.state.identity, projected.identity)
    || !controllerJournalExtends(journal(canonical.state), [...projectedJournal, ...missing])
    || highestSeq(journal(canonical.state)) !== runnerSeq) {
    throw new Error(CONTROLLER_JOURNAL_BEHIND_RUNNER);
  }
  if (input.readControlState() !== projectedText) throw new Error("native_runner_checkpoint_projection_held:journal_changed");
  canonical.checkpoint.restoreSessionDirectory(input.root);
  return "reconciled";
}
