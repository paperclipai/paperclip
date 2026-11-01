import { createHash } from "node:crypto";
import { COPILOT_LAUNCH_ARGUMENTS } from "../../packages/paperclip-runner/src/drivers/acpx/copilot-profile.js";
import { isValidNativePrpEnvelope } from "./native-event-envelope.js";
import { copilotEditOriginForPermission, readCopilotToolEvidence } from "./copilot-evidence.js";
import { readCopilotContextRead } from "./copilot-context-evidence.js";
import { copilotActionNotices } from "./copilot-protection-evidence.js";
import type { BootstrapReadProof } from "./native-bootstrap-read-proof.js";
import type { ActiveStopPending } from "./copilot-active-stop-evidence.js";

/** Closed selector shared by local and remote observers. It accepts no caller PID.
 * Only a live native executable under an already owned run root is eligible. */
export function selectOwnedCopilotProcess<T extends { pid: number; parent: number }>(
  rootPid: number, journal: readonly T[], live: readonly number[], argv: ReadonlyMap<number, readonly string[]>, fixedArguments: readonly string[] = COPILOT_LAUNCH_ARGUMENTS,
): T {
  const owned = new Map(journal.map(row => [row.pid, row]));
  if (!owned.has(rootPid) || !live.includes(rootPid)) throw new Error("Copilot death requires a live owned run root");
  const candidates = journal.filter(row => {
    if (row.pid === rootPid || !live.includes(row.pid)) return false;
    const command = argv.get(row.pid);
    if (!command || command.length !== fixedArguments.length + 1 || !/^\/[^\u0000-\u0020]*\/paperclip-acpx-native-[A-Za-z0-9_-]+\/distribution\/copilot$/u.test(command[0] ?? "") || !fixedArguments.every((arg, i) => command[i + 1] === arg)) return false;
    const seen = new Set<number>(); let parent = row.parent;
    while (parent !== rootPid) {
      if (seen.has(parent) || !live.includes(parent)) return false;
      seen.add(parent); const ancestor = owned.get(parent); if (!ancestor) return false; parent = ancestor.parent;
    }
    return true;
  });
  if (candidates.length !== 1) throw new Error("Copilot death requires exactly one owned native process");
  return candidates[0]!;
}
export const copilotDeathArguments = [...COPILOT_LAUNCH_ARGUMENTS];

/** Linux launches the held, verified executable descriptor rather than reopening
 * its name. Canonicalize only that closed launcher shape, after the observer
 * proves the live executable and inherited descriptor name the same inode. */
export function canonicalRemoteCopilotCommand(
  command: readonly string[], executable: string,
  executableIdentity: { dev: string; ino: string },
  descriptor?: { path: string; dev: string; ino: string },
): readonly string[] {
  if (!/^\/[^\u0000-\u0020]*\/paperclip-acpx-native-[A-Za-z0-9_-]+\/distribution\/copilot$/u.test(executable)) return command;
  if (command[0] === executable) return command;
  if (!/^\/proc\/self\/fd\/(?:3|7)$/u.test(command[0] ?? "") || !descriptor
    || descriptor.path !== executable || descriptor.dev !== executableIdentity.dev || descriptor.ino !== executableIdentity.ino) return command;
  return [executable, ...command.slice(1)];
}
export function copilotDeathCommandDigest(argv: readonly string[]) {
  return `sha256:${createHash("sha256").update(JSON.stringify(argv)).digest("hex")}`;
}

/** A failed run alone is insufficient: the pending callback must expire and its
 * native operation must never complete or appear again after the stale answer. */
export function assertCopilotProviderDeath(input: { pending: ActiveStopPending; run: Record<string, any>; issue: Record<string, any>; events: readonly any[]; bootstrap?: BootstrapReadProof }) {
  const { pending, run, issue } = input;
  if (run.id !== pending.scope.runId || run.companyId !== pending.scope.companyId || issue.id !== pending.scope.issueId || issue.status !== "blocked" || run.nativeIssueId !== pending.scope.issueId || run.runtimeMode !== "native" || run.status !== "failed") throw new Error("Provider death requires one failed unfinished run");
  const rows = input.events.filter(row => row.payload?.prpEvent);
  if (!rows.length || rows.some(row => row.runId !== run.id || row.companyId !== run.companyId || !isValidNativePrpEnvelope(row.payload.prpEvent, row.protocolSchemaVersion))) throw new Error("Provider death requires canonical run evidence");
  const events = rows.map(row => row.payload.prpEvent);
  const expiry = events.filter(event => event.eventType === "runtime_request.expired" && event.payload?.requestId === pending.requestId && event.turnId === pending.turnId && event.normalizedSessionId === pending.normalizedSessionId);
  if (expiry.length !== 1 || events.some(event => event.eventType === "runtime_request.resolved" && event.payload?.requestId === pending.requestId) || events.some(event => event.eventType === "task.completed" || event.eventType === "turn.completed")) throw new Error("Provider death did not expire the unanswered callback");
  const allNotices = readCopilotToolEvidence(input.events, run.id);
  const target = copilotEditOriginForPermission(allNotices, pending.scope.target, pending.toolCallId);
  if (pending.scope.requireContextRead && !target) throw new Error("Provider death lacks the exact mutation origin");
  const context = target ? readCopilotContextRead(input.events, target, pending.scope.requireContextRead) : undefined;
  const notices = target ? copilotActionNotices(allNotices, target, input.bootstrap, context ? input.events : undefined) : allNotices;
  if (notices.filter(n => n.stage === "permission_requested").length !== 1 || notices.some(n => n.stage === "permission_delivered" && ["allow_once", "allow_always"].includes(n.outcome ?? "")) || notices.some(n => n.stage === "tool" && (n.toolCallId !== pending.toolCallId || (n.operation !== undefined && n.operation !== "edit") || n.status === "completed"))) throw new Error("Provider death replayed or completed an operation");
  const expirySeq = rows.find(row => row.payload.prpEvent === expiry[0])!.seq;
  if (allNotices.some(n => n.stage === "tool" && n.seq >= expirySeq && !(n.toolCallId === pending.toolCallId && n.operation === "edit" && n.status === "failed"))) throw new Error("Provider death executed an operation after callback expiry");
  if (!events.some(event => ["turn.failed", "turn.interrupted"].includes(event.eventType) && event.turnId === pending.turnId)) throw new Error("Provider death lacks a failed provider turn");
  return { schema: "paperclip.e2e.copilot-provider-death.v1", runId: run.id, requestId: pending.requestId, expired: true, mutationReplay: false };
}
