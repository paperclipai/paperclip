import { createHash, randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { canonicalJson } from "../../packages/shared/src/portability-hash.js";
import { validatePrpStructuredRunResult } from "../../packages/paperclip-runner/src/protocol/replay-contract.js";
import { pollUntil } from "./api.js";
import { hasAcpxNativeOrigin } from "./acpx-native-origin.js";
import { isValidNativePrpEnvelope } from "./native-event-envelope.js";

type Row = Record<string, any>;
type State = { issue: Row; runs: Row[]; interactions: Row[] };
type Check = { id: string; passed: boolean; detail: string };
const rec = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const id = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 240 && !/[\u0000-\u001f\u007f]/u.test(value) && !value.includes("[REDACTED]");
const digest = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const closures = new Set(["runtime_request.resolved", "runtime_request.cancelled", "runtime_request.expired"]);
const terminals = new Set(["turn.completed", "turn.failed", "turn.cancelled", "turn.interrupted"]);
function requireProof(value: unknown, reason: string): asserts value { if (!value) throw new Error(`Pi native restart: ${reason}`); }

export interface PiRestartPending {
  companyId: string; issueId: string; runId: string; interactionId: string; requestId: string;
  turnId: string; itemId: string; nativeSessionId: string; sourceInstanceId: string; questionId: string;
  createdSourceSeq: number; createdRowSha256: string; interactionBindingSha256: string;
}

function interactionBinding(card: Row) {
  return { id: card.id, companyId: card.companyId, issueId: card.issueId, kind: card.kind,
    sourceRunId: card.sourceRunId, idempotencyKey: card.idempotencyKey,
    continuationPolicy: card.continuationPolicy, resolverPolicy: card.resolverPolicy, payload: card.payload };
}

function inspect(state: State, events: readonly Row[], companyId: string, header = "Pi native restart") {
  requireProof(id(companyId) && id(state.issue.id) && state.issue.companyId === companyId && state.runs.length === 1 && state.interactions.length === 1,
    "one company-scoped task, run and question required");
  const run = state.runs[0]!, card = state.interactions[0]!;
  requireProof(id(run.id) && run.companyId === companyId && run.nativeIssueId === state.issue.id && run.runtimeMode === "native"
    && id(run.nativeSessionId) && id(run.runnerInstanceId), "native run/session identity missing");
  requireProof(id(card.id) && card.companyId === companyId && card.issueId === state.issue.id && card.kind === "ask_user_questions"
    && card.sourceRunId === run.id && card.continuationPolicy === "none" && card.resolverPolicy === "human_only", "question is not the native callback");
  requireProof(Array.isArray(events) && events.length > 0 && events.length <= 20_000, "bounded durable events required");
  const rows = events.filter(row => rec(row.payload).prpEvent !== undefined).map(row => ({ row, event: rec(rec(row.payload).prpEvent) })).sort((a, b) => a.row.seq - b.row.seq);
  const seenRows = new Set<number>(), seenSources = new Set<string>(), cursors = new Map<string, number>();
  for (const { row, event } of rows) {
    requireProof(row.companyId === companyId && row.runId === run.id && isValidNativePrpEnvelope(event, row.protocolSchemaVersion)
      && event.runId === run.id && event.eventType === row.eventType && ["runner", "control_plane"].includes(event.sourceKind)
      && Number.isSafeInteger(row.seq) && row.seq > 0 && !seenRows.has(row.seq)
      && id(event.sourceInstanceId) && Number.isSafeInteger(event.sourceSeq) && event.sourceSeq > (cursors.get(event.sourceInstanceId) ?? 0)
      && event.sourceEventId === `${event.sourceInstanceId}:${run.id}:${event.sourceSeq}` && !seenSources.has(event.sourceEventId),
    "foreign, duplicate or reordered durable event");
    // The production finalizer owns this separate, stable two-event stream.
    // It cannot impersonate a native request/turn, nor can a runner accept itself.
    if (event.sourceKind === "control_plane") {
      requireProof(event.sourceInstanceId === `${run.runnerInstanceId}:control` && event.normalizedSessionId === run.nativeSessionId
        && row.sourceInstanceId === event.sourceInstanceId && row.sourceSeq === event.sourceSeq && row.sourceEventId === event.sourceEventId
        && ((event.eventType === "run.result.accepted" && event.sourceSeq === 1) || (event.eventType === "run.terminal" && event.sourceSeq === 2)),
      "foreign or unexpected control-plane completion receipt");
    } else requireProof(!["run.result.accepted", "run.terminal"].includes(event.eventType), "runner cannot claim control-plane completion");
    seenRows.add(row.seq); seenSources.add(event.sourceEventId); cursors.set(event.sourceInstanceId, event.sourceSeq);
  }
  const created = rows.filter(x => x.event.eventType === "runtime_request.created");
  requireProof(created.length === 1, "exactly one native request creation required");
  const opening = created[0]!, request = rec(opening.event.payload?.request), questionSet = rec(request.input);
  const question = Array.isArray(questionSet.questions) && questionSet.questions.length === 1 ? rec(questionSet.questions[0]) : {};
  requireProof(request.schema === "paperclip.runtime_request.v2" && request.requestKind === "runtime" && request.type === "input" && request.status === "pending"
    && id(request.requestId) && id(request.itemId) && id(request.turnId) && request.turnId === opening.event.turnId && request.itemId === opening.event.itemId
    && hasAcpxNativeOrigin(request.origin, "pi", "elicitation/create") && questionSet.schema === "paperclip.question_set.v1"
    && id(question.id) && question.answerMode === "text" && question.header === header
    && card.payload?.runtimeRequestId === request.requestId && digest(card.payload.questionSet) === digest(questionSet)
    && card.idempotencyKey === `paperclip-runner-question:${run.id}:${request.requestId}`, "canonical Pi input request identity missing");
  requireProof(rows.filter(x => x.event.turnId != null || x.event.eventType.startsWith("turn.") || x.event.eventType.startsWith("runtime_request.")).every(({ event }) => event.turnId === request.turnId
    && event.normalizedSessionId === run.nativeSessionId
    && event.sourceInstanceId === (event.sourceKind === "runner" ? run.runnerInstanceId : `${run.runnerInstanceId}:control`)), "turn, native session or producer was replaced");
  requireProof(rows.filter(x => x.event.sourceKind === "control_plane").every(x => x.event.turnId === request.turnId), "control-plane result belongs to another turn");
  const binding: PiRestartPending = { companyId, issueId: state.issue.id, runId: run.id, interactionId: card.id, requestId: request.requestId,
    turnId: request.turnId, itemId: request.itemId, nativeSessionId: run.nativeSessionId, sourceInstanceId: run.runnerInstanceId, questionId: question.id,
    createdSourceSeq: opening.event.sourceSeq, createdRowSha256: digest(opening.row), interactionBindingSha256: digest(interactionBinding(card)) };
  return { run, card, rows, binding };
}

/** Grade public state and PRP receipts; assistant prose is never restart proof. */
export function observePiPendingNativeInput(state: State, events: readonly Row[], companyId: string, header: string): PiRestartPending {
  const { run, card, rows, binding } = inspect(state, events, companyId, header);
  requireProof(state.issue.status === "in_progress" && run.status === "running" && card.status === "pending" && card.result == null
    && run.resultJson?.nativeCancellation == null && run.resultJson?.startupCancellation == null
    && !rows.some(x => closures.has(x.event.eventType) || terminals.has(x.event.eventType) || x.event.sourceKind === "control_plane"), "question is no longer unanswered in a live run");
  return binding;
}

export function observePiRestartPending(state: State, events: readonly Row[], companyId: string): PiRestartPending {
  return observePiPendingNativeInput(state, events, companyId, "Pi native restart");
}

export function gradePiRestartCompletion(state: State, events: readonly Row[], pending: PiRestartPending, answer: string, proof: unknown): boolean {
  const { run, card, rows, binding } = inspect(state, events, pending.companyId);
  requireProof(digest(binding) === digest(pending), "original request/run/source identity changed");
  const resolved = rows.filter(x => closures.has(x.event.eventType)), terminal = rows.filter(x => terminals.has(x.event.eventType));
  requireProof(resolved.length === 1 && resolved[0]!.event.eventType === "runtime_request.resolved", "exactly one durable native resolution required");
  const delivered = resolved[0]!.event, response = rec(delivered.payload);
  requireProof(response.requestId === pending.requestId && response.turnId === pending.turnId && response.itemId === pending.itemId
    && response.action === "submit" && delivered.itemId === pending.itemId && delivered.sourceSeq > pending.createdSourceSeq
    && digest(response.response) === digest({ schema: "paperclip.question_response.v1", answers: { [pending.questionId]: { text: answer } } }),
  "hidden browser answer was not delivered to the original native request");
  requireProof(terminal.length === 1 && terminal[0]!.event.eventType === "turn.completed" && terminal[0]!.event.payload?.status === "completed"
    && terminal[0]!.event.payload?.error == null && terminal[0]!.event.sourceSeq > delivered.sourceSeq
    && state.issue.status === "done" && run.status === "succeeded" && run.resultJson?.nativeCancellation == null && run.resultJson?.startupCancellation == null,
  "original native turn did not finish exactly once");
  const proposed = rows.filter(x => x.event.eventType === "run.result.proposed"), accepted = rows.filter(x => x.event.eventType === "run.result.accepted"), runTerminal = rows.filter(x => x.event.eventType === "run.terminal");
  requireProof(proposed.length === 1 && accepted.length === 1 && runTerminal.length === 1, "unique proposed and control-plane accepted completion required");
  const result = rec(accepted[0]!.event.payload?.result), validation = validatePrpStructuredRunResult(result);
  requireProof(validation.ok && digest(validation.result) === digest(result) && result.reportedWorkDisposition === "done"
    && digest(proposed[0]!.event.payload) === digest(result)
    && proposed[0]!.row.seq > resolved[0]!.row.seq && proposed[0]!.row.seq < terminal[0]!.row.seq
    && accepted[0]!.row.seq > terminal[0]!.row.seq && runTerminal[0]!.row.seq > accepted[0]!.row.seq
    && digest(runTerminal[0]!.event.payload) === digest({ schema: "paperclip.prp.terminal.v1", turnTerminalState: "completed", runTerminalState: "succeeded", reportedWorkDisposition: "done" }),
  "control-plane completion does not accept the original successful native result");
  requireProof(card.status === "answered" && Array.isArray(card.result?.answers) && card.result.answers.length === 1
    && card.result.answers[0].questionId === pending.questionId && card.result.answers[0].otherText === answer, "durable interaction answer missing or wrong");
  requireProof(digest(proof) === digest({ status: "answered", value: answer }), "independent workspace proof is missing or wrong");
  return true;
}

export async function runPiPendingControllerRestart(input: {
  page: Page; companyId: string; deadlineAt: number; load(): Promise<State>; events(runId: string): Promise<Row[]>;
  restart(): Promise<void>; settle(): Promise<State>; readProof(): Promise<unknown>;
  capture(id: string, label: string, file: string): Promise<void>; evidence(name: string, data: unknown): Promise<void>;
}): Promise<Check[]> {
  const checks: Check[] = [], answer = `PI-RESTART-${randomBytes(16).toString("hex")}`;
  const check = (id: string, passed: boolean, detail: string) => { checks.push({ id, passed, detail }); requireProof(passed, detail); };
  const snapshot = async (name: string) => {
    const state = await input.load(), events = state.runs.length === 1 ? await input.events(state.runs[0]!.id) : [];
    await input.evidence(name, { ...state, events }); return { state, events };
  };
  try {
    await pollUntil({ label: "Pi pending native restart question", deadlineAt: input.deadlineAt, load: input.load,
      accept: state => state.interactions.some(card => card.status === "pending"),
      reject: state => state.runs.length > 1 || state.runs.some(run => ["failed", "cancelled", "timed_out", "succeeded"].includes(run.status)) ? "Pi ended or created another run before the pending restart boundary" : undefined });
    const before = await snapshot("pi-native-restart-before.json"), pending = observePiRestartPending(before.state, before.events, input.companyId);
    check("restart-pending-native-identity", true, "One unanswered native Pi callback belongs to the original running turn and session");
    const composer = () => input.page.getByTestId("question-text-answer-composer").filter({ visible: true });
    await expect(composer()).toHaveCount(1);
    await input.capture("pi-restart-pending", "Pi native question before controller restart", "pi-restart-pending.png");
    await input.restart();
    await input.page.reload();
    const after = await snapshot("pi-native-restart-after.json"), resumed = observePiRestartPending(after.state, after.events, input.companyId);
    check("restart-same-pending-native-request", digest(resumed) === digest(pending), "Controller restart retained the same unanswered request, run, turn, native session and producer");
    await expect(composer()).toHaveCount(1);
    await input.capture("pi-restart-reconnected", "Same Pi question after controller restart", "pi-restart-reconnected.png");
    await composer().locator('[contenteditable="true"],textarea').first().fill(answer);
    const route = `/api/issues/${pending.issueId}/interactions/${pending.interactionId}/respond`;
    const submitted = input.page.waitForRequest(request => new URL(request.url()).pathname === route && request.method() === "POST",
      { timeout: Math.max(1, input.deadlineAt - Date.now()) });
    const button = input.page.getByRole("button", { name: after.state.interactions[0]!.payload.questionSet.submitLabel ?? "Submit answers", exact: true }).filter({ visible: true });
    await expect(button).toHaveCount(1); await button.click();
    const posted = (await submitted).postDataJSON();
    check("restart-exact-browser-answer", Array.isArray(posted?.answers) && posted.answers.length === 1
      && posted.answers[0].questionId === pending.questionId && posted.answers[0].otherText === answer, "Actual browser POST answered the retained question with previously undisclosed text");
    const final = await input.settle(), events = await input.events(pending.runId), proof = await input.readProof();
    await input.evidence("pi-native-restart-final.json", { ...final, events, pending, posted, proof });
    check("restart-native-answer-delivered-once", gradePiRestartCompletion(final, events, pending, answer, proof),
      "One durable answer and one successful original native turn delivered the exact typed result after restart");
    return checks;
  } finally { await input.evidence("pi-native-restart-checks.json", checks); }
}
