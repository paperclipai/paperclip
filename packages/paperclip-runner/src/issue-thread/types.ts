/**
 * Capability issue-thread view contract.
 *
 * The browser renders exactly this shape and nothing else. Every field is a
 * projection of a mock-core record, a canonical event, or a semantic
 * authorization record produced by the package server (Capability UX contract
 * §11: the browser holds no policy, diff, or parity authority). Two producers
 * exist — the deterministic `fake` fixtures used by the screenshot matrix and
 * the live session projection — and they emit the same schema.
 */

import type {
  CapabilityInteractionKind,
  CapabilityJsonValue,
  CapabilityTaskStatus,
} from "../mock-core/capability-control-plane-types.js";
import type { CapabilitySemanticOperationId } from "../semantic-tools/types.js";

export const CAPABILITY_ISSUE_THREAD_VIEW_SCHEMA = "paperclip.capability.issue-thread-view.v1" as const;

/** Contract §0: a surface never shows an unlabeled mode. */
export type CapabilityThreadMode = "live" | "fake" | "replay";

/** Contract §0: closed disposition enum; UI copy is fixed per disposition. */
export type CapabilityToolDisposition =
  | "control_plane_owned"
  | "always_agent_tool"
  | "optional_agent_tool";

export const CAPABILITY_DISPOSITION_LABELS: Readonly<Record<CapabilityToolDisposition, string>> = {
  always_agent_tool: "Agent tool — always",
  optional_agent_tool: "Agent tool — granted",
  control_plane_owned: "Control plane",
};

export interface CapabilityThreadIdentity {
  /** `Real Codex` in live mode, `Fake agent` in fake mode, `Replay` in replay mode. */
  agentLabel: string;
  /** `Real runnerd` in live mode, `In-process runner` otherwise. */
  runnerLabel: string;
  /** Pulse while a runnerd session is attached; static when detached. */
  runnerAttached: boolean;
  /** Always `Mock Paperclip`. */
  controlPlaneLabel: string;
  controlPlaneTooltip: string;
  /** Present in replay mode so replay evidence can never satisfy a live criterion. */
  replaySource: "fake" | "live" | null;
}

export interface CapabilityThreadIssue {
  identifier: string;
  title: string;
  status: CapabilityTaskStatus;
  priority: "critical" | "high" | "medium" | "low";
  assignee: string | null;
  runState: string;
  scenarioId: string;
  fixtureProfile: string;
}

/** Contract §4. `data-composer-state` is the test and screenshot hook. */
export type CapabilityComposerState =
  | "ready"
  | "sending"
  | "streaming"
  | "waiting"
  | "reconnecting"
  | "disabled";

export interface CapabilityComposerModel {
  state: CapabilityComposerState;
  helper: string | null;
  /** Reason line rendered by the `disabled` state. */
  reason: string | null;
  /** Anchor target for the `waiting` helper link. */
  pendingInteractionId: string | null;
}

export type CapabilityThreadInteractionState =
  | "pending"
  | "submitting"
  | "accepted"
  | "answered"
  | "rejected"
  | "stale_target"
  | "superseded_by_comment"
  | "expired"
  | "withdrawn"
  | "issue_closed";

export interface CapabilityThreadLink {
  label: string;
  /** In-explorer route only. Real Paperclip URLs never appear (§11). */
  href: string;
}

export interface CapabilityThreadQuestion {
  id: string;
  prompt: string;
  control: "radio" | "select" | "text";
  options?: string[];
  required?: boolean;
}

export interface CapabilityThreadCheckboxOption {
  id: string;
  label: string;
  defaultSelected?: boolean;
}

export interface CapabilityThreadProposedTask {
  id: string;
  title: string;
  description: string;
}

export interface CapabilityThreadVerdictItem {
  id: string;
  title: string;
  requireReason?: boolean;
  /** Set once the item has been submitted in a partial submit. */
  lockedVerdict?: "approve" | "reject" | "defer" | null;
}

export type CapabilityThreadInteractionPayload =
  | { kind: "questions"; questions: CapabilityThreadQuestion[]; submitLabel: string }
  | {
      kind: "confirmation";
      targetSummary: string;
      acceptLabel: string;
      rejectLabel: string;
      requireRejectReason: boolean;
    }
  | {
      kind: "checkbox";
      options: CapabilityThreadCheckboxOption[];
      minSelected: number;
      maxSelected: number;
      acceptLabel: string;
      rejectLabel: string;
    }
  | { kind: "suggest_tasks"; tasks: CapabilityThreadProposedTask[]; acceptLabel: string }
  | { kind: "item_verdicts"; items: CapabilityThreadVerdictItem[]; submitLabel: string };

export interface CapabilityThreadInteractionCard {
  interactionId: string;
  interactionKind: CapabilityInteractionKind;
  title: string;
  prompt: string;
  payload: CapabilityThreadInteractionPayload;
  state: CapabilityThreadInteractionState;
  /** Revision-bound confirmation target, e.g. `plan · r4`. */
  target: CapabilityThreadLink | null;
  /** Chip copy, always paired with a glyph in the renderer (§9.5). */
  stateLabel: string;
  /** Chosen values summarised inline once resolved. */
  resolvedSummary: string[];
  /** Verbatim reject reason. */
  reason: string | null;
  /** Superseding revision or comment for the expired outcomes. */
  supersededBy: CapabilityThreadLink | null;
  evidenceRef: CapabilityEvidenceRef;
}

export interface CapabilityEvidenceRef {
  section: CapabilityEvidenceSectionId;
  recordId: string;
}

export type CapabilityThreadItem =
  | { kind: "user_message"; id: string; at: string; author: string; body: string }
  | {
      kind: "agent_message";
      id: string;
      at: string;
      author: string;
      body: string;
      streaming: boolean;
    }
  | {
      kind: "durable_comment";
      id: string;
      at: string;
      author: string;
      body: string;
      operationId: CapabilitySemanticOperationId;
      evidenceRef: CapabilityEvidenceRef;
    }
  | {
      kind: "tool_activity";
      id: string;
      at: string;
      status: "ok" | "denied" | "running";
      operationId: string;
      summary: string;
      input: CapabilityJsonValue;
      result: CapabilityJsonValue;
      evidenceRef: CapabilityEvidenceRef;
    }
  | {
      kind: "progress_activity";
      id: string;
      at: string;
      activity: "thinking" | "planning" | "command" | "file_change";
      status: "running" | "complete";
      label: string;
      summary: string;
      eventCount: number;
    }
  | ({ kind: "interaction"; id: string; at: string } & CapabilityThreadInteractionCard)
  | {
      kind: "document";
      id: string;
      at: string;
      documentKey: string;
      title: string;
      author: string;
      revisionFrom: number | null;
      revisionTo: number;
      staleBehind: number | null;
      evidenceRef: CapabilityEvidenceRef;
    }
  | {
      kind: "deliverable";
      id: string;
      at: string;
      filename: string;
      deliverableKind: "attachment bytes" | "external ref" | "workspace file";
      byteSize: number;
      registeredBy: string;
      contentRef: string;
      evidenceRef: CapabilityEvidenceRef;
    }
  | {
      kind: "dependency";
      id: string;
      at: string;
      createdTasks: Array<{ identifier: string; title: string }>;
      blockerEdges: string[];
      evidenceRef: CapabilityEvidenceRef;
    }
  | {
      kind: "disposition";
      id: string;
      at: string;
      operationId: CapabilitySemanticOperationId;
      status: CapabilityTaskStatus;
      body: string;
      blockerOwner: string | null;
      evidenceRef: CapabilityEvidenceRef;
    }
  | {
      kind: "denial";
      id: string;
      at: string;
      operationId: string;
      /** Verbatim from the authorization record; never paraphrased. */
      reason: string;
      evidenceRef: CapabilityEvidenceRef;
    }
  | {
      kind: "system_notice";
      id: string;
      at: string;
      glyph: string;
      text: string;
      evidenceRef: CapabilityEvidenceRef;
    };

export interface CapabilityThreadTurn {
  id: string;
  ordinal: number;
  mode: CapabilityThreadMode;
  toolCallCount: number;
  at: string;
  stoppedByUser: boolean;
  items: CapabilityThreadItem[];
}

export type CapabilityEvidenceSectionId =
  | "tools"
  | "calls"
  | "authorization"
  | "control_plane"
  | "runner"
  | "state"
  | "traceability"
  | "parity";

export const CAPABILITY_EVIDENCE_SECTIONS: ReadonlyArray<{
  id: CapabilityEvidenceSectionId;
  title: string;
}> = [
  { id: "tools", title: "Tools exposed" },
  { id: "calls", title: "Calls & results" },
  { id: "authorization", title: "Authorization" },
  { id: "control_plane", title: "Control plane" },
  { id: "runner", title: "Runner & events" },
  { id: "state", title: "State diff" },
  { id: "traceability", title: "Traceability" },
  { id: "parity", title: "Parity" },
];

export interface CapabilityEvidenceToolRow {
  operationId: string;
  disposition: CapabilityToolDisposition;
  /** 7A grant string rendered verbatim, e.g. `rf:read_or_write`. */
  grant: string | null;
  description: string;
}

export interface CapabilityEvidenceToolsRecord {
  id: string;
  turnId: string;
  rows: CapabilityEvidenceToolRow[];
}

export interface CapabilityEvidenceCallRecord {
  id: string;
  turnId: string;
  operationId: string;
  version: number;
  providerRequest: string;
  dispatchedCommand: string;
  outcome: "ok" | "denied";
  result: CapabilityJsonValue;
  redactions: string[];
  threadAnchorId: string;
}

export interface CapabilityEvidenceAuthorizationRecord {
  id: string;
  turnId: string;
  operationId: string;
  phase: "exposure" | "invocation";
  allowed: boolean;
  code: string;
  reason: string;
  claimsConsidered: string[];
  redactions: string[];
  stateChangeRef: string | null;
  threadAnchorId: string;
}

export interface CapabilityEvidenceControlPlaneRecord {
  id: string;
  turnId: string;
  category: "checkout" | "wake" | "budget" | "idempotency" | "reconciliation" | "session";
  outcome: string;
  reason: string;
  stateRevision: number;
  threadAnchorId: string | null;
}

export interface CapabilityEvidenceRunnerRecord {
  id: string;
  turnId: string;
  kind: string;
  ordinal: number;
  detail: string;
  /** Complete allowlisted detail; raw provider payloads never enter this DTO. */
  details: Array<{ label: string; value: string }>;
}

export interface CapabilityEvidenceStateDiffRow {
  entityClass: string;
  entityRef: string;
  before: string;
  after: string;
}

export interface CapabilityEvidenceStateDiffRecord {
  id: string;
  turnId: string;
  fromRevision: number;
  toRevision: number;
  rows: CapabilityEvidenceStateDiffRow[];
}

export interface CapabilityEvidenceTraceabilityRecord {
  id: string;
  turnId: string;
  capabilityId: string;
  sourceAnchor: string;
  caseId: string;
  group: string;
  browserEvidenceRecipe: string;
  expectedSemanticOperations: string[];
  forbiddenOperations: string[];
  requiredCapabilityGrants: string[];
}

export interface CapabilityEvidenceParityRecord {
  id: string;
  turnId: string;
  assertion: string;
  verdict: "pass" | "fail" | "intentional_gap";
  note: string | null;
}

export interface CapabilityEvidenceModel {
  tools: CapabilityEvidenceToolsRecord[];
  calls: CapabilityEvidenceCallRecord[];
  authorization: CapabilityEvidenceAuthorizationRecord[];
  control_plane: CapabilityEvidenceControlPlaneRecord[];
  runner: CapabilityEvidenceRunnerRecord[];
  state: CapabilityEvidenceStateDiffRecord[];
  traceability: CapabilityEvidenceTraceabilityRecord[];
  parity: CapabilityEvidenceParityRecord[];
}

export interface CapabilityThreadConnection {
  state: "connected" | "reconnecting" | "closed";
  attempt: number;
}

export interface CapabilityReplayModel {
  ordinal: number;
  total: number;
}

export interface CapabilityIssueThreadSnapshot {
  schema: typeof CAPABILITY_ISSUE_THREAD_VIEW_SCHEMA;
  sessionId: string;
  mode: CapabilityThreadMode;
  identity: CapabilityThreadIdentity;
  issue: CapabilityThreadIssue;
  turns: CapabilityThreadTurn[];
  composer: CapabilityComposerModel;
  evidence: CapabilityEvidenceModel;
  connection: CapabilityThreadConnection;
  replay: CapabilityReplayModel | null;
  /** Fixture clock; every rendered timestamp derives from snapshot data. */
  renderedAt: string;
}

export function capabilityDispositionLabel(disposition: CapabilityToolDisposition): string {
  return CAPABILITY_DISPOSITION_LABELS[disposition];
}

/**
 * The one byte formatter for the whole surface. Deliverable sizes surface in
 * two places — the tool-activity strip summary and the deliverable card — and
 * they must agree, so both sides (fixtures, live projection, and the browser
 * components) format through here rather than rolling their own division.
 */
export function capabilityFormatBytes(byteSize: number): string {
  if (byteSize < 1024) return `${byteSize} B`;
  if (byteSize < 1024 * 1024) return `${(byteSize / 1024).toFixed(1)} kB`;
  return `${(byteSize / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Authorization denials that the agent actually hit. Drives the `Evidence`
 * badge (§2.2) and reads straight off authorization records — the browser never
 * decides whether something was denied.
 *
 * Exposure-phase denials are excluded on purpose: withholding an ungranted
 * operation from the tool list is the normal, expected path (it is what §7's
 * `Control plane — not exposed` list renders), so badging it would cry wolf on
 * every turn. Only invocation-phase denials mean the model was refused.
 */
export function capabilityDenialCount(
  evidence: CapabilityEvidenceModel,
  turnId: string | null,
): number {
  return evidence.authorization.filter(
    (record) =>
      !record.allowed &&
      record.phase === "invocation" &&
      (turnId === null || record.turnId === turnId),
  ).length;
}
