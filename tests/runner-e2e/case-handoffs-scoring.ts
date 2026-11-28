import { isValidNativePrpEnvelope } from "./native-event-envelope.js";
type Row = Record<string, any>;
export function caseHandoffRunFailure(runs: Row[]): string | undefined {
  const failed = runs.find(run => ["failed", "cancelled", "timed_out"].includes(run.status));
  if (!failed) return undefined;
  const provider = failed.resultJson?.nativeTurnFailure;
  if (typeof provider?.httpStatus === "number") {
    return `Native workflow provider rejected run ${failed.id} (HTTP ${provider.httpStatus}, ${provider.codexErrorInfo ?? provider.category ?? "provider_error"})`;
  }
  return `Native workflow run ${failed.id} failed (${failed.errorCode ?? failed.status})`;
}
export interface CaseHandoffObservation {
  nonce: string; companyId: string; taskId: string; caseId: string;
  agents: { triage: string; implementation: string; verification: string };
  workflowIds: { a: string; b: string };
  issue: Row; caseRecord: Row; cases: Row[]; tasks: Row[]; handoffs: Row[]; runs: Row[];
  documents: Record<string, Row>; handoffToolRunIds: string[]; workflowReadRunIds: string[]; pendingInteractions: number;
}
export function hasNativeHandoffReceipt(events: Row[]): boolean {
  const valid = events.map(event => ({ event, envelope: event.payload?.prpEvent }))
    .filter(({ event, envelope }) => envelope && envelope.sourceKind === "runner" && isValidNativePrpEnvelope(envelope, event.protocolSchemaVersion));
  const named = (name: unknown) => typeof name === "string" && (name === "handoff_case" || name.endsWith(".handoff_case"));
  return valid.some(({ event, envelope }) => {
    const payload = envelope.payload ?? {}, item = payload.item ?? {};
    if (event.eventType === "tool.execution.completed" && payload.status === "completed" && named(payload.name)) {
      return valid.some(({ event: started, envelope: before }) => started.seq < event.seq && started.eventType === "tool.execution.started"
        && before.payload?.executionId === payload.executionId && typeof payload.executionId === "string" && named(before.payload?.name));
    }
    const appliedHandoff = item.type === "tool_result" && typeof item.result?.handoffId === "string"
      && typeof item.result?.taskId === "string" && (item.result?.callerMustYield === true
        || (item.result?.callerMustYield === false && item.result?.destinationKind === "done"
          && ["awaiting_completion", "completed"].includes(item.result?.state)));
    if (event.eventType === "item.completed" && (item.status === "completed" || appliedHandoff) && typeof item.id === "string") {
      return valid.some(({ event: started, envelope: before }) => started.seq < event.seq && started.eventType === "item.started"
        && ["tool_call", "dynamicToolCall"].includes(before.payload?.kind) && before.payload?.item?.id === item.id && named(before.payload?.item?.name));
    }
    return false;
  });
}
function body(doc: Row | undefined) {
  try { return JSON.parse(doc?.body ?? doc?.latestBody ?? doc?.document?.body ?? doc?.document?.latestBody ?? ""); } catch { return null; }
}
export function gradeCaseHandoffs(input: CaseHandoffObservation) {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const add = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const phases = ["triage", "implementation", "verification", "revision"];
  const agents = [input.agents.triage, input.agents.implementation, input.agents.verification, input.agents.implementation];
  const all = [...input.handoffs].sort((a, b) => a.version - b.version);
  const ordered = all.filter(handoff => handoff.destinationKind !== "done");
  const terminal = all.find(handoff => handoff.destinationKind === "done");
  const workflowIds = [input.workflowIds.a, input.workflowIds.b, input.workflowIds.a, input.workflowIds.a];
  add("reusable-workflow-movement", Boolean(input.workflowIds.a && input.workflowIds.b && input.workflowIds.a !== input.workflowIds.b)
    && input.caseRecord.workflowId === input.workflowIds.a && ordered.length === 4 && ordered.every((handoff, index) =>
      handoff.workflowTransition?.to.workflowId === workflowIds[index]
      && handoff.workflowTransition?.from.workflowId === (workflowIds[index - 1] ?? null)
      && typeof handoff.workflowTransition?.documentRevisionId === "string"),
  "The same case adopts A → B → A and then preserves A, with effective document revisions in every transition.");
  add("effective-procedure-read", input.runs.length >= 4 && input.runs.every(run => input.workflowReadRunIds.includes(run.id)),
    "Every receiving run has an observed production read of the task's adopted workflow document.");
  add("one-primary-task", input.tasks.length === 1 && input.tasks[0]?.id === input.taskId && input.cases.length === 1
    && input.caseRecord.id === input.caseId && input.caseRecord.workIssueId === input.taskId && input.cases[0]?.workIssueId === input.taskId,
  "The public company lists and case detail retain exactly one workflow case and task.");
  add("ordered-durable-handoffs", ordered.length === 4 && ordered.every((h, i) => h.caseId === input.caseId && h.issueId === input.taskId
    && h.version === i + 1 && h.phase === phases[i] && h.toAgentId === agents[i] && h.state === "delivered"),
  "Four delivered handoffs preserve the task through triage, implementation, verification and revision.");
  add("terminal-case-completion", all.length === 5 && terminal?.version === 5 && terminal.state === "completed"
    && terminal.phase === "done" && terminal.caseId === input.caseId && terminal.issueId === input.taskId
    && terminal.fromAgentId === input.agents.implementation && terminal.toAgentId === null
    && terminal.workflowTransition?.from.workflowId === input.workflowIds.a
    && terminal.workflowTransition?.to.workflowId === input.workflowIds.a
    && terminal.workflowTransition?.documentRevisionId === ordered[3]?.workflowTransition?.documentRevisionId
    && input.handoffToolRunIds.includes(terminal.sourceRunId)
    && input.runs.some(run => run.id === terminal.sourceRunId && run.agentId === input.agents.implementation),
  "The final agent records one terminal intent that completes with the task and retains the effective procedure.");
  add("real-native-handoff-tools", ordered.slice(1).length === 3 && ordered.slice(1).every(h => typeof h.sourceRunId === "string"
    && input.handoffToolRunIds.includes(h.sourceRunId) && input.runs.some(r => r.id === h.sourceRunId && r.agentId === h.fromAgentId)),
  "Every agent-originated transfer has a completed production native handoff tool and matching run provenance.");
  add("fresh-phase-context", phases.every((phase, i) => {
    const saved = body(input.documents[`phase-${phase}`]);
    const document = input.documents[`phase-${phase}`];
    return saved?.nonce === input.nonce && saved.phase === phase && saved.caseId === input.caseId
      && saved.taskId === input.taskId && saved.handoffVersion === i + 1 && saved.result === 5
      && saved.workflowMarker === `procedure-${i === 1 ? "B" : "A"}-${input.nonce}`
      && document?.createdByAgentId === agents[i] && document?.updatedByAgentId === agents[i];
  }), "Each recipient persisted its actual new phase/version and unchanged case/task identities.");
  const answer = body(input.documents.answer);
  add("independently-verified-answer", answer?.nonce === input.nonce && answer.a === 2 && answer.b === 3 && answer.result === 5 && answer.verified === true
    && body(input.documents["phase-verification"])?.result === 5
    && input.documents.answer?.createdByAgentId === input.agents.implementation && input.documents.answer?.updatedByAgentId === input.agents.implementation,
  "The public answer document contains the independently specified result 5 and a saved verifier observation.");
  add("bounded-normal-completion", input.issue.status === "done" && input.issue.assigneeAgentId === input.agents.implementation
    && input.caseRecord.phase === "done" && input.caseRecord.handoffVersion === 5 && !input.caseRecord.pendingHandoff
    && input.runs.length >= 4 && input.runs.length <= 6 && input.runs.every(r => r.companyId === input.companyId && r.runtimeMode === "native" && r.status === "succeeded"
      && [r.issueId, r.nativeIssueId, r.contextSnapshot?.issueId, r.contextSnapshot?.taskId].includes(input.taskId))
    && input.pendingInteractions === 0,
  "The final implementation turn completes normally within six accounted runs and leaves no pending handoff or approval.");
  return checks;
}
