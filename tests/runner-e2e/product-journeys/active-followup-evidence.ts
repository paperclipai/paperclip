import { createHash } from "node:crypto";
import { activeNativeTurnStarted } from "../stop-redirect-flow.js";
import { isValidNativePrpEnvelope } from "../native-event-envelope.js";

type Row = Record<string, any>;
export interface ActiveFollowupBoundary {
  runId: string;
  executionId: string;
  startedSeq: number;
  sourceEventId: string;
  sourceInstanceId: string;
  sourceSeq: number;
  startedRowSha256: string;
}

/** A claimed run or elapsed delay is not proof that native work is active. */
export function activeFollowupBoundary(run: Row, events: Row[]): ActiveFollowupBoundary | null {
  if (!activeNativeTurnStarted(run, events) || !events.length
    || events.some((event, index) => event.seq !== index + 1)) return null;
  const bound = events.filter(event => {
    const envelope = event.payload?.prpEvent;
    return envelope && isValidNativePrpEnvelope(envelope, event.protocolSchemaVersion)
      && event.runId === run.id && event.companyId === run.companyId && event.agentId === run.agentId
      && envelope.runId === run.id && envelope.eventType === event.eventType && envelope.sourceKind === "runner"
      && typeof envelope.sourceEventId === "string" && Boolean(envelope.sourceEventId) && envelope.sourceEventId === event.sourceEventId
      && typeof envelope.sourceInstanceId === "string" && Boolean(envelope.sourceInstanceId) && envelope.sourceInstanceId === event.sourceInstanceId
      && Number.isSafeInteger(envelope.sourceSeq) && envelope.sourceSeq > 0 && envelope.sourceSeq === event.sourceSeq;
  });
  const latestTurn = bound.filter(event => /^turn\.(started|completed|failed|cancelled|interrupted)$/.test(event.eventType)).at(-1);
  if (latestTurn?.eventType !== "turn.started") return null;
  const starts = bound.filter(event => {
    const payload = event.payload.prpEvent.payload;
    return event.seq > latestTurn.seq && event.eventType === "tool.execution.started" && payload?.schema === "paperclip.tool.execution.v1"
      && typeof payload.executionId === "string" && Boolean(payload.executionId)
      && ["builtin", "process"].includes(payload.transport)
      && (payload.operation === "execute"
        // Older native packs classify builtin bash as unknown. Recognize only
        // that named v1 shell shape; unknown semantic/custom tools still fail.
        || event.protocolSchemaVersion === 1 && payload.operation === "unknown"
          && payload.transport === "builtin" && payload.name === "bash" && payload.readOnly === false)
      // Provider display titles vary, but Paperclip semantic calls never prove
      // native command work, even when a provider maps them to builtin execute.
      && payload.namespace == null
      && (payload.transport === "process" || typeof payload.name === "string" && Boolean(payload.name.trim())
        && !/^(?:unknown|tool(?:[ _-]+call)?)$/i.test(payload.name.trim())
        && !/(?:^|[._:/-])paperclip(?:[._:/-]|$)/i.test(payload.name.trim()))
      && payload.readOnly !== true && payload.status === "running";
  });
  const pending = starts.filter(start => {
    const id = start.payload.prpEvent.payload.executionId;
    return starts.filter(other => other.payload.prpEvent.payload.executionId === id).length === 1
      && !events.some(event => event.eventType === "tool.execution.completed"
        && event.payload?.prpEvent?.payload?.executionId === id);
  });
  const started = pending.at(-1);
  if (!started) return null;
  const envelope = started.payload.prpEvent;
  return { runId: run.id, executionId: envelope.payload.executionId, startedSeq: started.seq,
    sourceEventId: envelope.sourceEventId, sourceInstanceId: envelope.sourceInstanceId, sourceSeq: envelope.sourceSeq,
    startedRowSha256: createHash("sha256").update(JSON.stringify(started)).digest("hex") };
}

export function sameActiveFollowupBoundary(before: ActiveFollowupBoundary, after: ActiveFollowupBoundary | null) {
  return Boolean(after && Object.keys(before).every(key => before[key as keyof ActiveFollowupBoundary] === after[key as keyof ActiveFollowupBoundary]));
}

/** Accept in-turn steering or one normal successor; reject duplicate delivery. */
export function activeFollowupOutcome(input: {
  issueId: string; agentId: string; before: ActiveFollowupBoundary; after: ActiveFollowupBoundary | null;
  runs: Row[]; expectedReply: string; marker: string; replies: Array<{ runId: string; body: string }>;
  storedFollowupCount: number; queuedCommentCount: number; finalIssueStatus: string;
}) {
  const ids = input.runs.map(run => run.id);
  const matching = input.replies.filter(reply => Boolean(input.marker) && reply.body.includes(input.marker));
  return sameActiveFollowupBoundary(input.before, input.after)
    && input.storedFollowupCount === 1 && input.queuedCommentCount === 0 && input.finalIssueStatus === "done"
    && input.runs.length >= 1 && input.runs.length <= 2 && new Set(ids).size === ids.length && ids.includes(input.before.runId)
    && input.runs.every(run => run.agentId === input.agentId && run.status === "succeeded" && run.runtimeMode === "native"
      && (run.nativeIssueId ?? run.issueId ?? run.contextSnapshot?.issueId ?? run.contextSnapshot?.taskId) === input.issueId)
    && matching.length === 1 && matching[0]!.body === input.expectedReply && ids.includes(matching[0]!.runId)
    && (input.runs.length === 1 || matching[0]!.runId !== input.before.runId);
}
