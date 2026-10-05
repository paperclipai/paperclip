import { isValidNativePrpEnvelope } from "./native-event-envelope.js";

type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
const forbiddenKinds = new Set(["commandExecution", "process", "fileChange", "file_change", "apply_patch"]);
const toolKinds = new Set(["dynamicToolCall", "mcpToolCall", "commandExecution", "tool_call", "tool_use"]);
const terminalName = (value: unknown, expected: string) => typeof value === "string" && (value === expected || value.endsWith(`.${expected}`));

export interface NativeCompletionObservation {
  caseId: "assigned-skill-explicit-invocation" | "native-blocked-report";
  companyId: string; agentId: string; issue: Row; runs: readonly Row[];
  comments: readonly Row[]; events: readonly Row[];
  state: { issueIds: string[]; agentIds: string[]; documentCount: number; interactionCount: number };
  initial: { issueIds: string[]; agentIds: string[] };
  workspaceChanged: boolean;
  marker: string;
}

/** Observable tool/result/final sequence, not a claim that the provider consumed feedback. */
export function gradeNativeCompletion(input: NativeCompletionObservation) {
  const checks: Array<{ id: string; passed: boolean; detail: string }> = [];
  const check = (id: string, passed: boolean, detail: string) => checks.push({ id, passed, detail });
  const blocked = input.caseId === "native-blocked-report";
  const run = input.runs[0] ?? {};
  const expectedDisposition = blocked ? "blocked" : "done";
  const expectedTool = blocked ? "paperclip_block" : "paperclip_finish";
  const nativeResult = row(row(run.resultJson).nativeResult);
  check("one-native-attempt", input.runs.length === 1 && run.status === "succeeded" && run.runtimeMode === "native"
    && typeof run.id === "string" && run.id.length > 0 && typeof input.issue.id === "string" && input.issue.id.length > 0
    && run.nativeIssueId === input.issue.id
    && run.companyId === input.companyId && run.agentId === input.agentId
    && !run.retryOfRunId && !run.continuationAttempt && !input.issue.scheduledRetry,
  "Exactly one succeeded native run, with no continuation/retry or uncounted extra work.");
  check("durable-disposition", input.issue.companyId === input.companyId && input.issue.assigneeAgentId === input.agentId
    && input.issue.status === expectedDisposition && nativeResult.reportedWorkDisposition === expectedDisposition,
  "Public durable issue status and the native semantic result agree with the requested disposition.");
  if (blocked) {
    const blocker = row(nativeResult.blocker);
    check("exact-blocker", row(blocker.owner).name === "Release Owner" && blocker.unblockAction === "Grant deployment access"
      && blocker.scope === "task_wide", "The structured owner, exact action and whole-task scope are independently checked.");
  }

  const events = input.events.map(event => ({ event, envelope: row(row(event.payload).prpEvent) }));
  const bound = events.length > 0 && events.every(({ event, envelope }, index) => {
    const action = /^(?:tool\.execution\.|item\.)/.test(String(event.eventType));
    const required = action || ["run.result.proposed", "run.result.accepted", "run.terminal"].includes(String(event.eventType));
    return event.seq === index + 1
    && (Object.keys(envelope).length === 0 ? !required : isValidNativePrpEnvelope(envelope, event.protocolSchemaVersion as number | undefined)
    && (!action || envelope.sourceKind === "runner")
    && typeof envelope.sourceEventId === "string" && envelope.sourceEventId.length > 0
    && typeof envelope.sourceInstanceId === "string" && envelope.sourceInstanceId.length > 0
    && Number.isSafeInteger(envelope.sourceSeq) && Number(envelope.sourceSeq) > 0
    && envelope.runId === run.id && envelope.eventType === event.eventType
    && envelope.sourceEventId === event.sourceEventId && envelope.sourceInstanceId === event.sourceInstanceId
    && envelope.sourceSeq === event.sourceSeq);
  });
  check("complete-bound-events", bound, "A complete contiguous public PRP stream is bound to this run and persisted source identity.");
  const selected = (type: string) => events.filter(({ event }) => event.eventType === type);
  const proposed = selected("run.result.proposed");
  const accepted = selected("run.result.accepted");
  const terminal = selected("run.terminal");
  const acceptedResult = row(row(accepted[0]?.envelope.payload).result);
  const terminalResult = row(terminal[0]?.envelope.payload);
  check("authoritative-native-result", proposed.length === 1 && accepted.length === 1 && terminal.length === 1
    && proposed[0]?.envelope.sourceKind === "runner" && accepted[0]?.envelope.sourceKind === "control_plane" && terminal[0]?.envelope.sourceKind === "control_plane"
    && row(proposed[0]?.envelope.payload).reportedWorkDisposition === expectedDisposition
    && acceptedResult.reportedWorkDisposition === expectedDisposition
    && terminalResult.runTerminalState === "succeeded" && terminalResult.turnTerminalState === "completed",
  "One runner proposal is independently accepted and terminated by the control plane.");
  const proposalSeq = Number(proposed[0]?.event.seq ?? -1);
  const finishes = events.filter(({ event, envelope }) => {
    const payload = row(envelope.payload), item = row(payload.item);
    const completion = envelope.sourceKind === "runner" && Number(event.seq) > proposalSeq && (
      event.eventType === "tool.execution.completed" && terminalName(payload.name, expectedTool) && payload.status === "completed"
      || event.eventType === "item.completed" && (payload.kind === "tool_result" || item.type === "tool_result") && item.status === "completed"
    );
    if (!completion) return false;
    return events.some(({ event: start, envelope: startEnvelope }) => {
      const started = row(startEnvelope.payload), startedItem = row(started.item);
      return startEnvelope.sourceKind === "runner" && Number(start.seq) < proposalSeq && (
        event.eventType === "tool.execution.completed" && start.eventType === "tool.execution.started"
        && typeof payload.executionId === "string" && payload.executionId.length > 0 && started.executionId === payload.executionId && terminalName(started.name, expectedTool)
        || event.eventType === "item.completed" && start.eventType === "item.started"
        && (started.kind === "tool_call" || startedItem.type === "tool_call")
        && typeof item.id === "string" && item.id.length > 0 && item.id === startedItem.id
        && terminalName(startedItem.name, expectedTool)
        && (item.name === undefined || item.name === null || terminalName(item.name, expectedTool))
      );
    });
  });
  const finals = events.filter(({ event, envelope }) => {
    const payload = row(envelope.payload), item = row(payload.item);
    return envelope.sourceKind === "runner" && event.eventType === "item.completed"
      && (payload.kind === "agentMessage" || item.type === "agentMessage")
      && (payload.channel === "final" || item.channel === "final") && item.phase === "final_answer"
      && typeof item.text === "string" && item.text.trim().length > 0;
  });
  const finishSeq = Number(finishes.at(-1)?.event.seq ?? -1);
  const finalSeq = Number(finals[0]?.event.seq ?? -1);
  const starts = events.filter(({ event, envelope }) => envelope.sourceKind === "runner" && (
    event.eventType === "tool.execution.started" || event.eventType === "item.started"
      && toolKinds.has(String(row(envelope.payload).kind ?? row(row(envelope.payload).item).type))));
  check("final-after-tool-result", proposed.length === 1 && finishes.length > 0 && finals.length === 1
    && proposalSeq < finishSeq && finishSeq < finalSeq
    && proposalSeq < Number(accepted[0]?.event.seq ?? -1) && Number(accepted[0]?.event.seq ?? -1) < Number(terminal[0]?.event.seq ?? -1)
    && !starts.some(({ event }) => Number(event.seq) > proposalSeq),
  "The provider final follows the observed finishing result; no new invocation follows admission. Control-plane acceptance precedes its terminal receipt independently.");
  const finalText = String(row(row(finals[0]?.envelope.payload).item).text ?? "").trim();
  const replies = input.comments.filter(comment => comment.createdByRunId === run.id && comment.authorAgentId === input.agentId
    && typeof comment.body === "string" && comment.body.trim() === finalText);
  check("persisted-provider-final", finalText.length > 0 && replies.length === 1,
    "A nonempty provider final is durably projected as this run's agent reply; semantic-summary fallback is insufficient.");
  if (blocked) check("visible-blocker-content", finalText.split(input.marker).length === 2
    && finalText.includes("Release Owner") && finalText.includes("Grant deployment access")
    && /\b(?:blocked|cannot proceed|can't proceed|missing|required access|not (?:yet )?granted|awaiting|waiting|unavailable)\b/i.test(finalText)
    && !/\b(?:not blocked|no longer blocked|access (?:is |has been |was )?already granted|completed Grant deployment access)\b/i.test(finalText),
  "The final explains the actual unresolved blocker and its owner/action, rather than supplying only a marker.");
  const same = (a: string[], b: string[]) => a.length === b.length && a.every(id => b.includes(id)) && new Set(a).size === a.length;
  check("bounded-durable-work", same(input.state.issueIds, [...input.initial.issueIds, String(input.issue.id)])
    && same(input.state.agentIds, input.initial.agentIds) && input.state.documentCount === (blocked ? 0 : 1)
    && input.state.interactionCount === 0,
  "No additional tasks, agents or interactions; completion permits its one required document and blocker permits none.");
  if (blocked) {
    const forbidden = events.some(({ event, envelope }) => {
      const payload = row(envelope.payload), item = row(payload.item);
      return envelope.sourceKind === "runner" && (forbiddenKinds.has(String(payload.kind ?? item.type))
        || String(event.eventType).startsWith("tool.execution.") && payload.transport === "process"
        || /(?:write_document|create_task|hire_agent|register_deliverable|apply_patch|exec_command)/.test(String(payload.name ?? item.name ?? "")));
    });
    check("no-deployment-or-file-work", !input.workspaceChanged && !forbidden,
      "The fixture workspace is unchanged and no process/file/deployment or extra-work tool is observed.");
  }
  return { schema: "paperclip.native-completion-observation.v2", passed: checks.every(value => value.passed), checks,
    limitations: ["Exact provider feedback identity/consumption is not measured by the public sequence."] };
}
