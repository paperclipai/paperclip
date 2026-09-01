/**
 * Projects a live Capability session into the issue-thread view contract.
 *
 * This runs in the package server, never in the browser. It reads only durable
 * records — the live snapshot's transcript, evidence entries, semantic
 * authorization records, and the serialized mock state — and rearranges them
 * for rendering. It decides nothing: every allow/deny, revision, and state
 * change already exists in the input.
 */

import type {
  CapabilityFixtureInteraction,
  CapabilityFixtureState,
  CapabilityJsonValue,
} from "../mock-core/capability-control-plane-types.js";
import {
  capabilityEvidenceDetail,
  capabilityEvidenceDetails,
  redactCapabilityToolResult,
} from "../live/evidence-redaction.js";
import type {
  CapabilityLiveEvidenceEntry,
  CapabilityLiveSessionSnapshot,
} from "../live/live-session.js";
import { CAPABILITY_SEMANTIC_TOOL_CATALOG } from "../semantic-tools/catalog.js";
import type { CapabilitySemanticOperationId } from "../semantic-tools/types.js";
import type {
  CapabilityComposerModel,
  CapabilityEvidenceControlPlaneRecord,
  CapabilityEvidenceModel,
  CapabilityEvidenceParityRecord,
  CapabilityEvidenceToolRow,
  CapabilityEvidenceTraceabilityRecord,
  CapabilityIssueThreadSnapshot,
  CapabilityThreadConnection,
  CapabilityThreadInteractionCard,
  CapabilityThreadInteractionState,
  CapabilityThreadItem,
  CapabilityThreadMode,
  CapabilityThreadTurn,
  CapabilityToolDisposition,
} from "./types.js";
import { CAPABILITY_ISSUE_THREAD_VIEW_SCHEMA } from "./types.js";

const INTERACTION_RESULT_SCHEMA = "paperclip.semantic-interaction-result.v1";

const PROVIDER_FAMILY_PREFIXES = {
  "plan.": "plan", "tool.execution.": "tool_execution", "research.": "research",
  "delegation.": "delegation", "model.": "model_identity", "context.": "context",
  "artifact.": "artifact", "review.": "review", "hook.": "hook",
  "memory.": "memory", "safety.": "safety", "terminal.": "terminal",
  "wait.": "wait", "provider.notice.": "provider_notice",
} as const;

function providerActivityItem(entry: CapabilityLiveEvidenceEntry): Extract<CapabilityThreadItem, { kind: "provider_activity" }> | null {
  if (entry.data.canonical !== true) return null;
  const eventType = readString(entry.data.event);
  const family = Object.entries(PROVIDER_FAMILY_PREFIXES).find(([prefix]) => eventType.startsWith(prefix))?.[1];
  if (family === undefined) return null;
  const payload = readRecord(entry.data.payload);
  const rawStatus = readString(payload.status);
  const status = rawStatus === "running" || rawStatus === "pending" ? "running"
    : rawStatus === "failed" || rawStatus === "denied" ? "failed"
      : rawStatus === "interrupted" || rawStatus === "cancelled" ? "interrupted"
        : eventType === "plan.updated" && payload.complete === true ? "completed"
          : eventType.endsWith("started") || eventType.endsWith("progressed") ? "running"
          : eventType.endsWith("completed") || rawStatus === "completed" ? "completed" : "informational";
  const title = ({
    plan: "Plan", tool_execution: "Tool execution", research: "Research", delegation: "Delegation",
    model_identity: "Model", context: "Context compacted", artifact: "Artifact", review: "Review mode",
    hook: "Hook", memory: "Memory citation", safety: "Safety review", terminal: "Terminal input",
    wait: "Intentional wait", provider_notice: "Provider notice",
  } as const)[family];
  const summary = readString(payload.summary) || readString(payload.name) || readString(payload.query) || eventType.replaceAll(".", " · ");
  return {
    kind: "provider_activity", id: `provider-${entry.id}`, at: entry.at, family, eventType,
    status, title, summary, payload: entry.data.payload ?? null,
    evidenceRef: { section: "runner", recordId: entry.id },
  };
}

const DURABLE_COMMENT_OPERATIONS = new Set<CapabilitySemanticOperationId>([
  "report_progress",
  "answer_status_question",
]);

const DISPOSITION_OPERATIONS = new Set<CapabilitySemanticOperationId>([
  "finish_task",
  "block_task",
  "request_review",
]);

const PROGRESS_EVENTS = {
  reasoning_delta: {
    activity: "thinking",
    label: "Thinking",
    running: "Reasoning activity is arriving from Codex.",
    complete: "Reasoning activity completed.",
  },
  plan_delta: {
    activity: "planning",
    label: "Planning",
    running: "Codex is updating its plan.",
    complete: "Plan activity completed.",
  },
  command_output_delta: {
    activity: "command",
    label: "Running a command",
    running: "Command progress is arriving from Codex.",
    complete: "Command activity completed.",
  },
  file_change_delta: {
    activity: "file_change",
    label: "Reviewing a file change",
    running: "File-change progress is arriving from Codex.",
    complete: "File-change activity completed.",
  },
  reasoning_started: { activity: "thinking", label: "Thinking", running: "Codex started reasoning.", complete: "Reasoning started." },
  reasoning_completed: { activity: "thinking", label: "Thinking", running: "Codex completed reasoning.", complete: "Reasoning completed." },
  plan_started: { activity: "planning", label: "Planning", running: "Codex started planning.", complete: "Planning started." },
  plan_completed: { activity: "planning", label: "Planning", running: "Codex completed planning.", complete: "Planning completed." },
  command_started: { activity: "command", label: "Shell command", running: "Codex started a shell command.", complete: "Shell command started." },
  command_completed: { activity: "command", label: "Shell command", running: "Codex completed a shell command.", complete: "Shell command completed." },
  tool_started: { activity: "command", label: "Codex tool", running: "Codex started a tool call.", complete: "Tool call started." },
  tool_completed: { activity: "command", label: "Codex tool", running: "Codex completed a tool call.", complete: "Tool call completed." },
  file_change_started: { activity: "file_change", label: "File change", running: "Codex started a file change.", complete: "File change started." },
  file_change_completed: { activity: "file_change", label: "File change", running: "Codex completed a file change.", complete: "File change completed." },
} as const;

export interface CapabilityLiveProjectionInput {
  snapshot: CapabilityLiveSessionSnapshot;
  /** Transport state owned by the server, not inferred in the browser. */
  connection?: CapabilityThreadConnection;
  mode?: CapabilityThreadMode;
  replaySource?: "fake" | "live" | null;
  fixtureProfile?: string;
  /** 7A traceability rows for the active fixture, passed through verbatim. */
  traceability?: CapabilityEvidenceTraceabilityRecord[];
  /** 7F parity verdicts, passed through verbatim. */
  parity?: CapabilityEvidenceParityRecord[];
}

function readRecord(value: CapabilityJsonValue | undefined): Record<string, CapabilityJsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value
    : {};
}

function readString(value: CapabilityJsonValue | undefined, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function readNumber(value: CapabilityJsonValue | undefined, fallback = 0): number {
  return typeof value === "number" ? value : fallback;
}

function parseMockState(serialized: string): CapabilityFixtureState | null {
  try {
    return JSON.parse(serialized) as CapabilityFixtureState;
  } catch {
    return null;
  }
}

function isInteractionResultMessage(text: string): boolean {
  if (!text.startsWith("{")) return false;
  try {
    return readString(readRecord(JSON.parse(text)).schema) === INTERACTION_RESULT_SCHEMA;
  } catch {
    return false;
  }
}

function toolSummary(operationId: string, result: CapabilityJsonValue): string {
  const payload = readRecord(result);
  if (payload.ok === false) {
    return readString(readRecord(payload.denial).message, "denied");
  }
  // The strip already prints the operation id; the summary adds what changed.
  const inner = readRecord(payload.result);
  const revision = readNumber(payload.stateRevision, readNumber(inner.stateRevision, 0));
  return revision > 0 ? `state revision ${revision}` : "completed";
}

function dispositionFor(operationId: string, exposed: Set<string>): CapabilityToolDisposition {
  const descriptor = CAPABILITY_SEMANTIC_TOOL_CATALOG.find(
    (candidate) => candidate.operationId === operationId,
  );
  if (descriptor === undefined || !exposed.has(operationId)) return "control_plane_owned";
  return descriptor.exposure === "always" ? "always_agent_tool" : "optional_agent_tool";
}

function interactionState(
  interaction: CapabilityFixtureInteraction,
): { state: CapabilityThreadInteractionState; label: string } {
  const outcome = readString(readRecord(interaction.result ?? undefined).outcome);
  if (interaction.status === "pending") return { state: "pending", label: "Waiting for you" };
  if (interaction.status === "accepted") return { state: "accepted", label: "Accepted" };
  if (interaction.status === "answered") return { state: "answered", label: "Answered" };
  if (interaction.status === "rejected") return { state: "rejected", label: "Changes requested" };
  if (outcome === "stale_target") return { state: "stale_target", label: "Stale — target moved" };
  if (outcome === "superseded_by_comment") {
    return { state: "superseded_by_comment", label: "Superseded by a later comment" };
  }
  if (outcome === "withdrawn") return { state: "withdrawn", label: "Withdrawn" };
  if (outcome === "issue_closed") return { state: "issue_closed", label: "Issue closed" };
  return { state: "expired", label: "Expired" };
}

function interactionPayload(
  interaction: CapabilityFixtureInteraction,
): CapabilityThreadInteractionCard["payload"] {
  const payload = readRecord(interaction.payload ?? undefined);
  switch (interaction.kind) {
    case "questions":
      return {
        kind: "questions",
        submitLabel: readString(payload.submitLabel, "Submit answers"),
        questions: (Array.isArray(payload.questions) ? payload.questions : []).map(
          (entry, index) => {
            const question = readRecord(entry);
            const options = Array.isArray(question.options)
              ? question.options.map((option) => readString(option))
              : undefined;
            return {
              id: readString(question.id, `q${index + 1}`),
              prompt: readString(question.prompt),
              control:
                options === undefined || options.length === 0
                  ? ("text" as const)
                  : options.length > 3
                    ? ("select" as const)
                    : ("radio" as const),
              options,
              required: question.required === true,
            };
          },
        ),
      };
    case "confirmation":
      return {
        kind: "confirmation",
        targetSummary: readString(payload.targetSummary, interaction.prompt),
        acceptLabel: readString(payload.acceptLabel, "Accept"),
        rejectLabel: readString(payload.rejectLabel, "Reject"),
        requireRejectReason: payload.requireRejectReason !== false,
      };
    case "checkbox":
      return {
        kind: "checkbox",
        options: (Array.isArray(payload.options) ? payload.options : []).map((entry, index) => {
          const option = readRecord(entry);
          return {
            id: readString(option.id, `o${index + 1}`),
            label: readString(option.label),
            defaultSelected: option.defaultSelected === true,
          };
        }),
        minSelected: readNumber(payload.minSelected, 0),
        maxSelected: readNumber(
          payload.maxSelected,
          Array.isArray(payload.options) ? payload.options.length : 0,
        ),
        acceptLabel: readString(payload.acceptLabel, "Accept"),
        rejectLabel: readString(payload.rejectLabel, "Reject"),
      };
    case "suggest_tasks":
      return {
        kind: "suggest_tasks",
        acceptLabel: readString(payload.acceptLabel, "Create selected tasks"),
        tasks: (Array.isArray(payload.tasks) ? payload.tasks : []).map((entry, index) => {
          const task = readRecord(entry);
          return {
            id: readString(task.id, `t${index + 1}`),
            title: readString(task.title),
            description: readString(task.description),
          };
        }),
      };
    case "item_verdicts":
      return {
        kind: "item_verdicts",
        submitLabel: readString(payload.submitLabel, "Submit verdicts"),
        items: (Array.isArray(payload.items) ? payload.items : []).map((entry, index) => {
          const item = readRecord(entry);
          return {
            id: readString(item.id, `i${index + 1}`),
            title: readString(item.title),
            requireReason: item.requireReason === true,
            lockedVerdict: null,
          };
        }),
      };
  }
}

function interactionCard(
  interaction: CapabilityFixtureInteraction,
  state: CapabilityFixtureState | null,
): CapabilityThreadInteractionCard {
  const view = interactionState(interaction);
  const result = readRecord(interaction.result ?? undefined);
  const document = state?.documents.find((candidate) =>
    candidate.revisions.some((revision) => revision.id === interaction.targetRevisionId),
  );
  const revision = document?.revisions.find(
    (candidate) => candidate.id === interaction.targetRevisionId,
  );
  return {
    interactionId: interaction.id,
    interactionKind: interaction.kind,
    title: interaction.title,
    prompt: interaction.prompt,
    payload: interactionPayload(interaction),
    state: view.state,
    stateLabel: view.label,
    target:
      document !== undefined && revision !== undefined
        ? {
            label: `${document.key} · r${revision.revision}`,
            href: `?panel=state&rec=${document.id}`,
          }
        : null,
    resolvedSummary: Array.isArray(result.summary)
      ? result.summary.map((entry) => readString(entry))
      : [],
    reason: typeof result.reason === "string" ? result.reason : null,
    supersededBy:
      typeof result.supersededBy === "string"
        ? { label: result.supersededBy, href: `?panel=control_plane&rec=${result.supersededBy}` }
        : null,
    evidenceRef: { section: "authorization", recordId: `interaction:${interaction.id}` },
  };
}

interface CallPair {
  callId: string;
  turnId: string | null;
  operationId: string;
  input: CapabilityJsonValue;
  result: CapabilityJsonValue | null;
  at: string;
  beforeRevision: number;
  afterRevision: number | null;
}

function collectCalls(evidence: CapabilityLiveEvidenceEntry[]): CallPair[] {
  const pairs = new Map<string, CallPair>();
  const order: string[] = [];
  for (const entry of evidence) {
    if (entry.kind !== "tool_call" && entry.kind !== "tool_result") continue;
    const callId = readString(entry.data.callId);
    if (callId.length === 0) continue;
    let pair = pairs.get(callId);
    if (pair === undefined) {
      pair = {
        callId,
        turnId: entry.turnId,
        operationId: readString(entry.data.operationId),
        input: entry.data.input ?? null,
        result: null,
        at: entry.at,
        beforeRevision: readNumber(entry.data.beforeRevision),
        afterRevision: null,
      };
      pairs.set(callId, pair);
      order.push(callId);
    }
    if (entry.kind === "tool_result") {
      pair.result = entry.data.result ?? null;
      pair.afterRevision = readNumber(entry.data.afterRevision, pair.beforeRevision);
    }
  }
  return order.map((callId) => pairs.get(callId)!);
}

function toolActivityItem(pair: CallPair): CapabilityThreadItem {
  const payload = readRecord(pair.result ?? undefined);
  if (pair.result === null) {
    return {
      kind: "tool_activity",
      id: `item-call-${pair.callId}`,
      at: pair.at,
      status: "running",
      operationId: pair.operationId,
      summary: `${pair.operationId} · running`,
      input: pair.input,
      result: null,
      evidenceRef: { section: "calls", recordId: pair.callId },
    };
  }
  if (payload.ok === false) {
    return {
      kind: "denial",
      id: `item-call-${pair.callId}`,
      at: pair.at,
      operationId: pair.operationId,
      reason: readString(readRecord(payload.denial).message, "denied"),
      evidenceRef: { section: "authorization", recordId: `call:${pair.callId}` },
    };
  }
  return {
    kind: "tool_activity",
    id: `item-call-${pair.callId}`,
    at: pair.at,
    status: "ok",
    operationId: pair.operationId,
    summary: toolSummary(pair.operationId, pair.result),
    input: pair.input,
    result: redactCapabilityToolResult(pair.result),
    evidenceRef: { section: "calls", recordId: pair.callId },
  };
}

function derivedRecordItems(
  pair: CallPair,
  state: CapabilityFixtureState | null,
): CapabilityThreadItem[] {
  const payload = readRecord(pair.result ?? undefined);
  if (payload.ok !== true || state === null) return [];
  const command = readRecord(payload.result);
  const entityRefs = Array.isArray(command.entityRefs)
    ? command.entityRefs.map((entry) => readString(entry))
    : [];
  // Mock entity refs are `<kind>:<id>` pairs, e.g. `comment:comment-1`.
  const refsOf = (kind: string): string[] =>
    entityRefs
      .filter((ref) => ref.startsWith(`${kind}:`))
      .map((ref) => ref.slice(kind.length + 1));
  const operationId = pair.operationId as CapabilitySemanticOperationId;
  const items: CapabilityThreadItem[] = [];

  if (DURABLE_COMMENT_OPERATIONS.has(operationId)) {
    for (const ref of refsOf("comment")) {
      const comment = state.comments.find((candidate) => candidate.id === ref);
      if (comment === undefined) continue;
      items.push({
        kind: "durable_comment",
        id: `item-comment-${comment.id}`,
        at: comment.createdAt,
        author:
          state.actors.find((actor) => actor.id === comment.authorActorId)?.name ?? "Agent",
        body: comment.body,
        operationId,
        evidenceRef: { section: "calls", recordId: pair.callId },
      });
    }
  }

  if (operationId === "write_document") {
    for (const ref of refsOf("document")) {
      const document = state.documents.find((candidate) => candidate.id === ref);
      if (document === undefined) continue;
      const latest = document.revisions.at(-1);
      const previous = document.revisions.at(-2);
      if (latest === undefined) continue;
      items.push({
        kind: "document",
        id: `item-document-${document.id}-${latest.id}`,
        at: latest.createdAt,
        documentKey: document.key,
        title: document.title,
        author: state.actors[0]?.name ?? "Agent",
        revisionFrom: previous?.revision ?? null,
        revisionTo: latest.revision,
        staleBehind: null,
        evidenceRef: { section: "state", recordId: `document:${document.id}` },
      });
    }
  }

  if (operationId === "register_deliverable") {
    for (const ref of refsOf("artifact")) {
      const artifact = state.artifacts.find((candidate) => candidate.id === ref);
      if (artifact === undefined) continue;
      items.push({
        kind: "deliverable",
        id: `item-artifact-${artifact.id}`,
        at: artifact.createdAt,
        filename: artifact.filename,
        deliverableKind: "attachment bytes",
        byteSize: artifact.byteSize,
        registeredBy: state.actors[0]?.name ?? "Agent",
        contentRef: artifact.contentRef,
        evidenceRef: { section: "calls", recordId: pair.callId },
      });
    }
  }

  if (operationId === "create_task" || operationId === "set_dependencies") {
    const created = refsOf("task")
      .filter((id) => id !== state.tasks[0]?.id)
      .map((ref) => state.tasks.find((candidate) => candidate.id === ref))
      .filter((task): task is NonNullable<typeof task> => task !== undefined)
      .map((task) => ({ identifier: task.identifier, title: task.title }));
    const edges = state.blockers.map((blocker) => {
      const blocking = state.tasks.find((task) => task.id === blocker.blockedByTaskId);
      const blocked = state.tasks.find((task) => task.id === blocker.taskId);
      return `${blocking?.identifier ?? blocker.blockedByTaskId} blocks ${blocked?.identifier ?? blocker.taskId}`;
    });
    if (created.length > 0 || edges.length > 0) {
      items.push({
        kind: "dependency",
        id: `item-dependency-${pair.callId}`,
        at: pair.at,
        createdTasks: created,
        blockerEdges: edges,
        evidenceRef: { section: "calls", recordId: pair.callId },
      });
    }
  }

  if (DISPOSITION_OPERATIONS.has(operationId)) {
    const task = state.tasks.find((candidate) => candidate.id === refsOf("task")[0]);
    items.push({
      kind: "disposition",
      id: `item-disposition-${pair.callId}`,
      at: pair.at,
      operationId,
      status: task?.status ?? "in_review",
      // The one input value the contract renders, carried under its own key by
      // the evidence redactor rather than read out of raw arguments.
      body: readString(readRecord(pair.input).dispositionSummary),
      blockerOwner: null,
      evidenceRef: { section: "calls", recordId: pair.callId },
    });
  }

  for (const ref of refsOf("interaction")) {
    const interaction = state.interactions.find((candidate) => candidate.id === ref);
    if (interaction === undefined) continue;
    items.push({
      kind: "interaction",
      id: `item-interaction-${interaction.id}`,
      // Anchor the prompt to the tool call that created it. Mock timestamps can
      // precede streamed provider activity, which used to hoist the card above
      // the exchange instead of showing it inline where Codex asked.
      at: pair.at,
      ...interactionCard(interaction, state),
    });
  }

  return items;
}

function composerModel(
  snapshot: CapabilityLiveSessionSnapshot,
  connection: CapabilityThreadConnection,
  mode: CapabilityThreadMode,
  pendingInteractionId: string | null,
  terminal: boolean,
  providerName: string,
): CapabilityComposerModel {
  if (mode === "replay") {
    return { state: "disabled", helper: null, reason: "Replay is read-only", pendingInteractionId: null };
  }
  if (connection.state === "reconnecting") {
    return {
      state: "reconnecting",
      helper: "Reconnecting… your session is preserved.",
      reason: null,
      pendingInteractionId,
    };
  }
  if (snapshot.status === "closed" || snapshot.status === "failed") {
    return {
      state: "disabled",
      helper: null,
      reason: "Session is closed",
      pendingInteractionId: null,
    };
  }
  if (snapshot.status === "suspended" || snapshot.status === "suspending") {
    return {
      state: snapshot.status === "suspending" ? "reconnecting" : "ready",
      helper: snapshot.status === "suspended"
        ? "Runner suspended — your next message will restore this provider session."
        : "Suspending runner after durable flush…",
      reason: null,
      pendingInteractionId,
    };
  }
  if (terminal) {
    return {
      state: "ready",
      helper: "This task is done. You can still continue the conversation.",
      reason: null,
      pendingInteractionId: null,
    };
  }
  if (pendingInteractionId !== null) {
    return {
      state: "waiting",
      helper: "Answer the pending request above to continue.",
      reason: null,
      pendingInteractionId,
    };
  }
  // `running` covers the window between accepting a message and the provider
  // reporting a turn id. A streamed turn is observable in that window, so the
  // composer has to read as streaming there rather than briefly as ready.
  if (snapshot.activeTurnId !== null || snapshot.status === "running") {
    return {
      state: "streaming",
      helper: `${providerName} is working — send to steer, or stop the turn.`,
      reason: null,
      pendingInteractionId: null,
    };
  }
  return { state: "ready", helper: null, reason: null, pendingInteractionId: null };
}

/**
 * The real-API block, rendered as a record rather than a claim in prose.
 *
 * Both the clean-room chat and the scenario path route every Paperclip
 * operation through the in-process mock port, so "no request reached a real
 * Paperclip API" is a fact the session already carries. Projecting it into the
 * Control plane section is what makes it inspectable in the drawer instead of
 * something a reader has to take on trust.
 */
function networkGuardRecord(
  snapshot: CapabilityLiveSessionSnapshot,
  state: CapabilityFixtureState | null,
): CapabilityEvidenceControlPlaneRecord {
  const { realPaperclipRequests, childPaperclipEnvironmentKeys } = snapshot.networkEvidence;
  return {
    id: `network-guard-${snapshot.sessionId}`,
    turnId: "turn-0",
    category: "session",
    outcome: realPaperclipRequests === 0 ? "no_real_paperclip_request" : "real_paperclip_request",
    reason:
      `Real Paperclip API requests: ${realPaperclipRequests}. ` +
      `Child PAPERCLIP_* environment keys: ${
        childPaperclipEnvironmentKeys.length === 0
          ? "none"
          : childPaperclipEnvironmentKeys.join(", ")
      }.`,
    stateRevision: state?.revision ?? 0,
    threadAnchorId: null,
  };
}

function evidenceModel(
  snapshot: CapabilityLiveSessionSnapshot,
  state: CapabilityFixtureState | null,
  calls: CallPair[],
  input: CapabilityLiveProjectionInput,
): CapabilityEvidenceModel {
  const exposureEntry = [...snapshot.evidence]
    .reverse()
    .find((entry) => entry.kind === "tool_exposure");
  const exposedIds = new Set(
    Array.isArray(exposureEntry?.data.operationIds)
      ? exposureEntry.data.operationIds.map((entry) => readString(entry))
      : [],
  );
  const rows: CapabilityEvidenceToolRow[] = CAPABILITY_SEMANTIC_TOOL_CATALOG.map((descriptor) => ({
    operationId: descriptor.operationId,
    disposition: dispositionFor(descriptor.operationId, exposedIds),
    grant: descriptor.requiredClaims[0] ?? null,
    description: descriptor.description,
  }));
  const turnIds = [...new Set(snapshot.transcript.map((entry) => entry.turnId ?? "turn-0"))];

  return {
    tools: turnIds.map((turnId) => ({ id: `tools-${turnId}`, turnId, rows })),
    calls: calls.map((pair) => {
      const payload = readRecord(pair.result ?? undefined);
      const fields = readRecord(pair.input).fields;
      const fieldCount = Array.isArray(fields) ? fields.length : 0;
      return {
        id: pair.callId,
        turnId: pair.turnId ?? "turn-0",
        operationId: pair.operationId,
        version: 1,
        // The arguments themselves are never republished — the redacted field
        // list already says what the call carried (track 7U).
        providerRequest: `tools/call ${pair.operationId} · ${fieldCount} field${fieldCount === 1 ? "" : "s"}`,
        dispatchedCommand:
          payload.ok === false ? "rejected before dispatch" : `control_plane.dispatch(${pair.operationId})`,
        outcome: payload.ok === false ? ("denied" as const) : ("ok" as const),
        result: pair.result === null ? null : redactCapabilityToolResult(pair.result),
        redactions: pair.result === null ? [] : ["tool_result_detail"],
        threadAnchorId: `item-call-${pair.callId}`,
      };
    }),
    authorization: snapshot.authorizationRecords.map((record) => ({
      id: record.id,
      turnId: record.callId === null ? "turn-0" : (calls.find((pair) => pair.callId === record.callId)?.turnId ?? "turn-0"),
      operationId: record.operationId,
      phase: record.phase,
      allowed: record.allowed,
      code: record.code,
      reason: record.reason,
      claimsConsidered: [...record.effectiveClaims],
      redactions: [],
      stateChangeRef: null,
      threadAnchorId: record.callId === null ? "" : `item-call-${record.callId}`,
    })),
    control_plane: [networkGuardRecord(snapshot, state), ...(state?.decisions ?? []).map((decision) => ({
      id: decision.id,
      turnId: "turn-0",
      category:
        decision.operation === "open_run"
          ? ("checkout" as const)
          : decision.operation === "schedule_wake"
            ? ("wake" as const)
            : decision.outcome === "duplicate"
              ? ("idempotency" as const)
              : decision.outcome === "reconciled"
                ? ("reconciliation" as const)
                : ("session" as const),
      outcome: decision.outcome,
      reason: decision.reason,
      stateRevision: decision.stateRevision,
      threadAnchorId: null,
    }))],
    // A stringified record used to be the detail line, which republished every
    // retained field. The detail is now composed from the redacted record.
    runner: snapshot.evidence.map((entry, index) => ({
      id: entry.id,
      turnId: entry.turnId ?? "turn-0",
      kind: entry.kind,
      ordinal: index + 1,
      detail: capabilityEvidenceDetail(entry.kind, entry.data),
      details: capabilityEvidenceDetails(entry.kind, entry.data),
    })),
    state: calls
      .filter((pair) => pair.afterRevision !== null && pair.afterRevision !== pair.beforeRevision)
      .map((pair) => ({
        id: `diff-${pair.callId}`,
        turnId: pair.turnId ?? "turn-0",
        fromRevision: pair.beforeRevision,
        toRevision: pair.afterRevision ?? pair.beforeRevision,
        rows: (Array.isArray(readRecord(readRecord(pair.result ?? undefined).result).entityRefs)
          ? (readRecord(readRecord(pair.result ?? undefined).result).entityRefs as CapabilityJsonValue[])
          : []
        ).map((ref) => ({
          entityClass: pair.operationId,
          entityRef: readString(ref),
          before: `revision ${pair.beforeRevision}`,
          after: `revision ${pair.afterRevision ?? pair.beforeRevision}`,
        })),
      })),
    traceability: input.traceability ?? [],
    parity: input.parity ?? [],
  };
}

export function projectCapabilityIssueThread(
  input: CapabilityLiveProjectionInput,
): CapabilityIssueThreadSnapshot {
  const { snapshot } = input;
  const mode = input.mode ?? "live";
  const agentLabel = mode === "live"
    ? snapshot.config.provider === "claude_managed" || snapshot.config.driver === "claude_managed_agents_api"
      ? "Claude Agent"
      : snapshot.config.provider === "aws_agentcore" || snapshot.config.driver === "aws_agentcore_harness_api"
        ? "Real AWS AgentCore"
      : snapshot.config.provider === "opencode" || snapshot.config.driver === "opencode_server"
        ? "Real OpenCode"
      : snapshot.config.provider === "acpx" || snapshot.config.driver === "acpx_runtime"
        ? `Real ${snapshot.config.acpxAgent === "claude" ? "Claude" : snapshot.config.acpxAgent === "codex" ? "Codex" : "Pi"} via ACPX`
        : "Real Codex"
    : mode === "replay" ? "Replay" : "Fake agent";
  const connection = input.connection ?? { state: "connected", attempt: 0 };
  const state = parseMockState(snapshot.mockState);
  const calls = collectCalls(snapshot.evidence);
  const task =
    state?.tasks.find((candidate) => candidate.id === snapshot.authority.taskId) ??
    state?.tasks[0] ??
    null;

  const turns = new Map<string, CapabilityThreadTurn>();
  const turnOrder: string[] = [];
  function turnFor(turnId: string | null, at: string): CapabilityThreadTurn {
    const key = turnId ?? "turn-0";
    let turn = turns.get(key);
    if (turn === undefined) {
      turnOrder.push(key);
      turn = {
        id: key,
        ordinal: turnOrder.length,
        mode,
        toolCallCount: 0,
        at,
        stoppedByUser: false,
        items: [],
      };
      turns.set(key, turn);
    }
    return turn;
  }

  for (const entry of snapshot.transcript) {
    if (entry.role === "user" && isInteractionResultMessage(entry.text)) continue;
    const turn = turnFor(entry.turnId, entry.at);
    if (entry.role === "user") {
      turn.items.push({
        kind: "user_message",
        id: entry.id,
        at: entry.at,
        author: "You (board user)",
        body: entry.text,
      });
    } else if (entry.role === "assistant") {
      turn.items.push({
        kind: "agent_message",
        id: entry.id,
        at: entry.at,
        author: agentLabel,
        body: entry.text,
        streaming: snapshot.activeTurnId !== null && entry.turnId === snapshot.activeTurnId,
      });
    } else {
      turn.items.push({
        kind: "system_notice",
        id: entry.id,
        at: entry.at,
        glyph: "⚙",
        text: entry.text,
        evidenceRef: { section: "control_plane", recordId: entry.id },
      });
    }
  }

  for (const pair of calls) {
    const turn = turnFor(pair.turnId, pair.at);
    turn.toolCallCount += 1;
    turn.items.push(toolActivityItem(pair));
    turn.items.push(...derivedRecordItems(pair, state));
  }

  const progressGroups = new Map<
    string,
    {
      id: string;
      turnId: string;
      event: keyof typeof PROGRESS_EVENTS;
      at: string;
      count: number;
      details: Record<string, CapabilityJsonValue>;
    }
  >();
  for (const entry of snapshot.evidence) {
    if (entry.kind !== "provider_event" || entry.turnId === null) continue;
    const event = readString(entry.data.event) as keyof typeof PROGRESS_EVENTS;
    if (!(event in PROGRESS_EVENTS)) continue;
    // Deltas are a stream and stay grouped for readability. Lifecycle records
    // are discrete Codex tools/items: retain one row per start/completion so a
    // burst of shell commands never collapses into an opaque counter.
    const key = event.endsWith("_delta") ? `${entry.turnId}:${event}` : entry.id;
    const group = progressGroups.get(key);
    if (group === undefined) {
      progressGroups.set(key, { id: entry.id, turnId: entry.turnId, event, at: entry.at, count: 1, details: entry.data });
    } else {
      group.count += 1;
    }
  }
  for (const entry of snapshot.evidence) {
    if (entry.kind !== "provider_event" || entry.turnId === null) continue;
    const item = providerActivityItem(entry);
    if (item !== null) turnFor(entry.turnId, entry.at).items.push(item);
  }
  for (const group of progressGroups.values()) {
    const copy = PROGRESS_EVENTS[group.event];
    const providerName = agentLabel.replace(/^Real /, "");
    const running = snapshot.activeTurnId === group.turnId && !group.event.endsWith("_completed");
    turnFor(group.turnId, group.at).items.push({
      kind: "progress_activity",
      id: `item-progress-${group.id}`,
      at: group.at,
      activity: copy.activity,
      status: running ? "running" : "complete",
      label: copy.label.replaceAll("Codex", providerName),
      summary: (running ? copy.running : copy.complete).replaceAll("Codex", providerName),
      eventCount: group.count,
      details: group.details,
    });
  }

  for (const entry of snapshot.workspaceDiffs ?? []) {
    turnFor(entry.turnId, entry.at).items.push({
      kind: "workspace_changes",
      id: `item-workspace-${entry.diff.changeSetId}`,
      at: entry.at,
      changeSet: structuredClone(entry.diff),
    });
  }

  for (const entry of snapshot.workspaceFileReferences ?? []) {
    turnFor(entry.turnId, entry.at).items.push({
      kind: "workspace_file_reference",
      id: `item-file-reference-${entry.reference.referenceId}`,
      at: entry.at,
      reference: structuredClone(entry.reference),
    });
  }

  // The transcript, provider progress, and semantic calls are collected from
  // separate durable record sets. Put them back into time order for a chat-like
  // flow while relying on stable sort order for records sharing a timestamp.
  for (const turn of turns.values()) {
    turn.items.sort((left, right) => left.at.localeCompare(right.at));
  }

  const stopRequested = snapshot.evidence.some(
    (entry) => entry.kind === "session" && readString(entry.data.action) === "stop_requested",
  );
  if (stopRequested) {
    const turn = turns.get(snapshot.activeTurnId ?? turnOrder.at(-1) ?? "turn-0");
    if (turn !== undefined) turn.stoppedByUser = true;
  }

  const pendingInteraction =
    state?.interactions.find((interaction) => interaction.status === "pending") ?? null;
  const terminal = task?.status === "done" || task?.status === "cancelled";

  return {
    schema: CAPABILITY_ISSUE_THREAD_VIEW_SCHEMA,
    sessionId: snapshot.sessionId,
    mode,
    identity: {
      agentLabel,
      runnerLabel: mode === "live" ? "Real runnerd" : "In-process runner",
      runnerAttached: ["idle", "warm_idle", "waiting_input", "running"].includes(snapshot.status),
      controlPlaneLabel: "Mock Paperclip",
      controlPlaneTooltip: "All issue records are mock. No real Paperclip API is reachable.",
      replaySource: input.replaySource ?? null,
    },
    issue: {
      identifier: task?.identifier ?? "MCK-1",
      title: task?.title ?? "Mock task",
      status: task?.status ?? "in_progress",
      priority: task?.priority ?? "medium",
      assignee:
        state?.actors.find((actor) => actor.id === task?.assigneeActorId)?.name ?? null,
      runState: `${snapshot.authority.runId} · ${snapshot.status}`,
      scenarioId: snapshot.authority.scenarioId,
      fixtureProfile: input.fixtureProfile ?? snapshot.authority.scenarioId,
    },
    turns: turnOrder.map((id) => turns.get(id)!),
    composer: composerModel(
      snapshot,
      connection,
      mode,
      pendingInteraction?.id ?? null,
      terminal,
      agentLabel.replace(/^Real /, ""),
    ),
    evidence: evidenceModel(snapshot, state, calls, input),
    connection,
    replay: null,
    renderedAt: snapshot.updatedAt,
  };
}
