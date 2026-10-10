import { createHash, randomBytes } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import { canonicalJson } from "../../packages/shared/src/portability-hash.js";
import { pollUntil, type RunnerApi } from "./api.js";
import { isValidNativePrpEnvelope } from "./native-event-envelope.js";
import { observePiPendingNativeInput, type PiRestartPending } from "./pi-native-restart-flow.js";
import { hasPiRemoteRetirement } from "./pi-native-evidence.js";
import type { RemoteNativeFixture, PiProviderDeathReceipt } from "./remote-native-fixtures.js";

type Row = Record<string, any>;
type State = { issue: Row; runs: Row[]; interactions: Row[] };
type Check = { id: string; passed: boolean; detail: string };
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value)).digest("hex");
const demand = (value: unknown, reason: string): void => { if (!value) throw new Error(`pi_provider_death_proof: ${reason}`); };
export const PI_DEATH_MARKER = "pi-provider-death-answer.json";

/** All events are public durable production receipts, never a fault fixture's events. */
export function gradePiProviderDeath(state: State, events: readonly Row[], pending: PiRestartPending, originalQuestion: unknown) {
  demand(state.issue.id === pending.issueId && state.issue.companyId === pending.companyId && state.issue.status === "blocked" && state.runs.length === 1, "foreign issue, wrong blocked disposition or second run");
  const run = state.runs[0]!;
  demand(run.id === pending.runId && run.companyId === pending.companyId && run.nativeIssueId === pending.issueId && run.runtimeMode === "native"
    && run.nativeSessionId === pending.nativeSessionId && run.runnerInstanceId === pending.sourceInstanceId
    && run.status === "failed" && run.resultJson?.nativeCancellation == null && run.resultJson?.startupCancellation == null,
  "original provider did not fail independently of Stop");
  demand(Array.isArray(events) && events.length > 0 && events.length <= 20_000, "missing event history");
  const rows = events.filter(row => row.payload?.prpEvent).sort((a, b) => a.seq - b.seq);
  const ids = new Set<string>(), seqs = new Set<number>(), cursors = new Map<string, number>();
  for (const row of rows) {
    const e = row.payload.prpEvent;
    demand(row.companyId === pending.companyId && row.runId === pending.runId && row.eventType === e.eventType
      && Number.isSafeInteger(row.seq) && row.seq > 0 && !seqs.has(row.seq) && isValidNativePrpEnvelope(e, row.protocolSchemaVersion)
      && e.runId === pending.runId && e.normalizedSessionId === pending.nativeSessionId
      && ((e.sourceKind === "runner" && e.sourceInstanceId === pending.sourceInstanceId)
        || (e.sourceKind === "control_plane" && e.sourceInstanceId === `${pending.sourceInstanceId}:control`))
      && e.sourceEventId === `${e.sourceInstanceId}:${pending.runId}:${e.sourceSeq}` && !ids.has(e.sourceEventId)
      && Number.isSafeInteger(e.sourceSeq) && e.sourceSeq > (cursors.get(e.sourceInstanceId) ?? 0), "foreign, duplicate or reordered event");
    ids.add(e.sourceEventId); seqs.add(row.seq); cursors.set(e.sourceInstanceId, e.sourceSeq);
    if (e.turnId != null) demand(e.turnId === pending.turnId, "replacement native turn");
  }
  const of = (kind: string) => rows.filter(row => row.eventType === kind);
  const created = of("runtime_request.created");
  demand(created.length === 1 && hash(created[0]) === pending.createdRowSha256, "original request changed or replayed");
  const closures = rows.filter(row => ["runtime_request.expired", "runtime_request.resolved", "runtime_request.cancelled"].includes(row.eventType));
  demand(closures.length === 1 && closures[0]!.eventType === "runtime_request.expired", "missing unique production expiry");
  const expired = closures[0]!.payload.prpEvent, p = expired.payload;
  demand(expired.sourceKind === "runner" && expired.sourceSeq > pending.createdSourceSeq && expired.turnId === pending.turnId
    && p.requestId === pending.requestId && p.requestKind === "runtime" && p.requestType === "input" && p.turnId === pending.turnId && p.itemId === pending.itemId
    && p.reason === "provider_process_lost" && p.replayAllowed === false && hash(p.request) === hash(created[0]!.payload.prpEvent.payload.request), "expiry is not the original lost Pi callback");
  const failed = of("turn.failed");
  demand(failed.length === 1 && failed[0]!.seq > closures[0]!.seq && failed[0]!.payload.prpEvent.sourceKind === "runner"
    && failed[0]!.payload.prpEvent.turnId === pending.turnId && !of("turn.completed").length && !of("turn.cancelled").length
    && of("turn.started").length === 1 && !of("run.result.proposed").length, "wrong terminal or replacement turn");
  const card = state.interactions.find(card => card.id === pending.interactionId);
  demand(card?.companyId === pending.companyId && card.issueId === pending.issueId && card.sourceRunId === pending.runId
    && card.idempotencyKey === `paperclip-runner-question:${pending.runId}:${pending.requestId}` && card.continuationPolicy === "none"
    && card.status === "expired" && card.result?.version === 1 && Array.isArray(card.result.answers) && card.result.answers.length === 0
    && card.kind === "ask_user_questions" && card.resolverPolicy === "human_only" && card.payload?.runtimeRequestId === pending.requestId && hash(card.payload.questionSet) === hash(originalQuestion), "original durable card did not expire");
  const fallback = state.interactions.filter(card => card.id !== pending.interactionId);
  demand(fallback.length <= 1, "duplicate fallback interaction");
  if (fallback.length) {
    const next = fallback[0]!;
    demand(next.id !== pending.interactionId && next.companyId === pending.companyId && next.issueId === pending.issueId && next.sourceRunId === pending.runId
      && next.kind === "ask_user_questions" && next.status === "pending" && next.result == null && next.continuationPolicy === "wake_assignee"
      && next.idempotencyKey === `runtime-input-durable:v1:${pending.runId}:${pending.requestId}`
      && card!.result.expirationReason === "superseded_by_newer_interaction" && card!.result.supersededByInteractionId === next.id
      && next.payload?.runtimeRequestId === pending.requestId && hash(next.payload.questionSet) === hash(originalQuestion), "fallback was mistaken for restored input");
  }
  return { originalCardExpired: true, replayAllowed: false, originalProviderRestored: false, fallbackInteractionId: fallback[0]?.id ?? null };
}

export async function runPiPendingProviderDeath(input: {
  page: Page; api: RunnerApi; companyId: string; deadlineAt: number; fixture: RemoteNativeFixture;
  load(): Promise<State>; events(runId: string): Promise<Row[]>;
  capture(id: string, label: string, file: string): Promise<void>; evidence(name: string, value: unknown): Promise<void>;
}): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (id: string, passed: boolean, detail: string) => { checks.push({ id, passed, detail }); demand(passed, detail); };
  let fault: PiProviderDeathReceipt | undefined;
  const snapshot = async (name: string) => {
    const state = await input.load(), events = state.runs.length === 1 ? await input.events(state.runs[0]!.id) : [];
    await input.evidence(name, { ...state, events, fault }); return { state, events };
  };
  try {
    await pollUntil({ label: "Pi native input before provider death", deadlineAt: input.deadlineAt, load: input.load,
      accept: s => s.interactions.some(c => c.status === "pending"), reject: s => s.runs.length > 1 || s.runs.some(r => ["succeeded", "failed", "cancelled", "timed_out"].includes(r.status)) ? "Provider ended before fault admission" : undefined });
    const before = await snapshot("pi-provider-death-before.json");
    const pending = observePiPendingNativeInput(before.state, before.events, input.companyId, "Pi native provider death");
    const run = before.state.runs[0]!, question = before.state.interactions[0]!.payload.questionSet;
    demand(input.fixture.binding.runId === pending.runId && input.fixture.binding.companyId === pending.companyId && input.fixture.terminatePiProvider,
      "missing exact owned Daytona fault capability");
    // createRunnerdBackend's default PRP lease is the execution workspace ID;
    // reject alternate/recovered authority instead of guessing that identity.
    const workspaceId = run.contextSnapshot?.executionWorkspaceId;
    demand(typeof workspaceId === "string" && workspaceId.length > 0
      && run.runnerProfileJson?.nativeExecutionInput?.binding?.executionWorkspaceId === workspaceId
      && run.contextSnapshot?.paperclipEnvironment?.leaseId === input.fixture.binding.leaseId
      && input.fixture.baseline.scope.observedPrpEnvironmentLeaseId === workspaceId, "native run/lease/workspace binding unavailable");
    await expect(input.page.getByTestId("question-text-answer-composer").filter({ visible: true })).toHaveCount(1);
    await input.capture("pi-provider-death-pending", "Unanswered native Pi input before provider loss", "pi-provider-death-pending.png");
    // Refresh immediately before the one-shot irreversible fault.
    const fresh = await snapshot("pi-provider-death-admission.json");
    check("death-original-pending-input", hash(observePiPendingNativeInput(fresh.state, fresh.events, input.companyId, "Pi native provider death")) === hash(pending), "Fault admits only the unchanged original native input");
    fault = await input.fixture.terminatePiProvider!(workspaceId);
    await input.evidence("pi-provider-death-fault.json", fault);
    await pollUntil({ label: "production expiry after Pi provider loss", deadlineAt: input.deadlineAt, load: input.load,
      accept: s => s.issue.status === "blocked" && s.runs[0]?.status === "failed" && s.interactions.some(c => c.id === pending.interactionId && c.status === "expired"),
      reject: s => s.runs.length !== 1 || s.runs.some(r => ["succeeded", "cancelled", "timed_out"].includes(r.status)) ? "Unexpected run after provider fault" : undefined });
    const retired = await input.fixture.finish();
    check("death-owned-retirement-no-effect", hasPiRemoteRetirement(retired) && retired.targets[PI_DEATH_MARKER]?.absent === true
      && retired.targets[PI_DEATH_MARKER]?.complete === true && retired.targets[PI_DEATH_MARKER]?.mutationCount === 0,
    "Exact owned process tree retired while the unanswered continuation marker remained absent");
    await input.evidence("pi-provider-death-retirement.json", retired);
    await input.page.reload();
    const final = await snapshot("pi-provider-death-expired.json"), result = gradePiProviderDeath(final.state, final.events, pending, question);
    // Failed native terminals are permanent on the first attempt; the
    // controller's nativeSessionRecoveryProjection projects Blocked while this
    // run still owns the task (native-session-executor.ts).
    await expect(input.page.getByTestId("issue-detail-header").getByRole("button", { name: "Change status (current: Blocked", exact: false })).toBeVisible();
    const oldCard = input.page.locator(`#interaction-${pending.interactionId}`);
    await expect(oldCard).toHaveCount(1);
    await expect(oldCard.locator('textarea,[contenteditable="true"],button[type="submit"]')).toHaveCount(0);
    await input.capture("pi-provider-death-expired", "Expired original input and any separate durable fallback", "pi-provider-death-expired.png");
    const answer = `STALE-${randomBytes(16).toString("hex")}`;
    const original = await input.api.request.post(`/api/issues/${pending.issueId}/interactions/${pending.interactionId}/respond`,
      { data: { answers: [{ questionId: pending.questionId, optionIds: [], otherText: answer }] } });
    const runtime = await input.api.request.post(`/api/heartbeat-runs/${pending.runId}/runtime-requests/${encodeURIComponent(pending.requestId)}/resolve`,
      { data: { resolution: { action: "submit", response: { schema: "paperclip.question_response.v1", answers: { [pending.questionId]: { text: answer } } } } } });
    check("death-stale-original-responses-rejected", original.status() === 409 && runtime.status() === 409, "Both original durable-card and native-runtime response APIs reject the stale answer");
    const after = await snapshot("pi-provider-death-after-stale.json");
    check("death-expiry-not-restoration", hash(gradePiProviderDeath(after.state, after.events, pending, question)) === hash(result)
      && hash(after.state.interactions) === hash(final.state.interactions), "Stale answers neither resolve/replay the original request nor start a new run; any fallback remains a separate unanswered interaction");
    await input.evidence("pi-provider-death-result.json", { ...result, staleCardStatus: original.status(), staleRuntimeStatus: runtime.status(), paidProviderDeath: true });
    return checks;
  } finally { await input.evidence("pi-provider-death-checks.json", checks); }
}
