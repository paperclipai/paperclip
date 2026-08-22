import type {
  CompleteControlPlaneRunInput,
  ControlPlanePort,
  OpenControlPlaneRunInput,
} from "../contracts/control-plane-port.js";
import type { NativeRunEvent, NativeRunResult } from "../contracts/types.js";
import type { PersistedNativeSession } from "../contracts/native-session-backend.js";
import type { PrpEvent } from "../protocol/phase1-contract.js";

export type Phase7JsonPrimitive = string | number | boolean | null;
export type Phase7JsonValue =
  | Phase7JsonPrimitive
  | Phase7JsonValue[]
  | { [key: string]: Phase7JsonValue };

export type Phase7TaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

export interface Phase7FixtureCompany {
  id: string;
  name: string;
  issuePrefix: string;
  status: "active" | "paused";
  budgetId: string;
}

export interface Phase7FixtureActor {
  id: string;
  companyId: string;
  name: string;
  role: string;
  status: "active" | "paused";
  budgetId: string;
  capabilityGrants: string[];
}

export interface Phase7FixtureTask {
  id: string;
  companyId: string;
  identifier: string;
  title: string;
  description: string | null;
  status: Phase7TaskStatus;
  priority: "critical" | "high" | "medium" | "low";
  workMode: "standard" | "ask" | "planning" | "skill_test";
  parentId: string | null;
  assigneeActorId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface Phase7FixtureComment {
  id: string;
  taskId: string;
  authorActorId: string | null;
  body: string;
  createdAt: string;
}

export interface Phase7FixtureDocumentRevision {
  id: string;
  documentId: string;
  revision: number;
  body: string;
  changeSummary: string | null;
  createdAt: string;
}

export interface Phase7FixtureDocument {
  id: string;
  taskId: string;
  key: string;
  title: string;
  format: "markdown";
  latestRevisionId: string;
  revisions: Phase7FixtureDocumentRevision[];
}

export type Phase7InteractionKind =
  | "confirmation"
  | "checkbox"
  | "questions"
  | "suggest_tasks"
  | "item_verdicts";

export interface Phase7FixtureInteraction {
  id: string;
  taskId: string;
  kind: Phase7InteractionKind;
  status: "pending" | "answered" | "accepted" | "rejected" | "expired";
  title: string;
  prompt: string;
  payload: Phase7JsonValue;
  targetRevisionId: string | null;
  continuationPolicy: "none" | "wake_assignee" | "wake_assignee_on_accept";
  result: Phase7JsonValue | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface Phase7FixtureApprovalComment {
  id: string;
  authorActorId: string | null;
  body: string;
  createdAt: string;
}

export interface Phase7FixtureApproval {
  id: string;
  companyId: string;
  taskIds: string[];
  type: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requestedByActorId: string | null;
  payload: Phase7JsonValue;
  decisionNote: string | null;
  comments: Phase7FixtureApprovalComment[];
  createdAt: string;
  decidedAt: string | null;
}

export interface Phase7FixtureArtifact {
  id: string;
  taskId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  contentRef: string;
  createdAt: string;
}

export interface Phase7FixtureWorkProduct {
  id: string;
  taskId: string;
  type: "artifact" | "document" | "pull_request" | "preview_url" | "runtime_service" | "commit" | "branch";
  title: string;
  metadata: Phase7JsonValue;
  artifactId: string | null;
  createdAt: string;
}

export interface Phase7FixtureBlocker {
  id: string;
  taskId: string;
  blockedByTaskId: string;
  createdAt: string;
}

export interface Phase7FixtureWorkspaceService {
  id: string;
  taskId: string;
  name: string;
  status: "stopped" | "starting" | "running" | "failed";
  url: string | null;
  lastTransitionAt: string;
}

export interface Phase7FixtureBudget {
  id: string;
  scope: "company" | "actor";
  scopeId: string;
  limitCents: number;
  spentCents: number;
  hardStop: boolean;
}

export type Phase7WakeReason =
  | "manual"
  | "issue_commented"
  | "interaction_resolved"
  | "approval_resolved"
  | "blockers_resolved"
  | "scheduled_retry"
  | "resume";

export interface Phase7WakeContext {
  reason: Phase7WakeReason;
  payload: Phase7JsonValue;
}

export interface Phase7ScheduledWake {
  id: string;
  actorId: string;
  taskId: string;
  reason: Phase7WakeReason;
  payload: Phase7JsonValue;
  dueAt: string;
  status: "scheduled" | "delivered" | "cancelled";
  createdAt: string;
}

export interface Phase7FixtureRun {
  id: string;
  companyId: string;
  actorId: string;
  taskId: string;
  sessionId: string;
  backendKind: OpenControlPlaneRunInput["backendKind"];
  sourceInstanceId: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "budget_stopped";
  attempt: number;
  openedAt: string;
  finishedAt: string | null;
  wake: Phase7WakeContext;
  capabilities: string[];
  events: Array<NativeRunEvent | PrpEvent>;
  result: NativeRunResult | CompleteControlPlaneRunInput | null;
  sessionCheckpoint: PersistedNativeSession | null;
}

export interface Phase7AuditRecord {
  id: string;
  at: string;
  runId: string | null;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details: Phase7JsonValue;
}

export interface Phase7DecisionRecord {
  id: string;
  at: string;
  runId: string | null;
  operation: string;
  outcome: "allowed" | "denied" | "duplicate" | "reconciled" | "faulted";
  reason: string;
  stateRevision: number;
  entityRefs: string[];
}

export interface Phase7FaultRule {
  id: string;
  operation: "open_run" | "append_event" | "apply_command" | "complete_run";
  commandKind?: Phase7SemanticCommand["kind"];
  effect: "retryable_error" | "lost_ack";
  remaining: number;
  code: string;
}

export interface Phase7IdempotencyRecord {
  scope: string;
  key: string;
  inputCanonical: string;
  result: Phase7CommandResult;
}

export interface Phase7FixtureState {
  schema: "paperclip.phase7.mock-state.v1";
  revision: number;
  clock: { epochMs: number; tick: number };
  counters: Record<string, number>;
  lifecycle: "stopped" | "running";
  activeRunId: string | null;
  company: Phase7FixtureCompany;
  actors: Phase7FixtureActor[];
  tasks: Phase7FixtureTask[];
  comments: Phase7FixtureComment[];
  documents: Phase7FixtureDocument[];
  interactions: Phase7FixtureInteraction[];
  approvals: Phase7FixtureApproval[];
  artifacts: Phase7FixtureArtifact[];
  workProducts: Phase7FixtureWorkProduct[];
  blockers: Phase7FixtureBlocker[];
  workspaceServices: Phase7FixtureWorkspaceService[];
  budgets: Phase7FixtureBudget[];
  runs: Phase7FixtureRun[];
  wakes: Phase7ScheduledWake[];
  audit: Phase7AuditRecord[];
  decisions: Phase7DecisionRecord[];
  idempotency: Phase7IdempotencyRecord[];
  faults: Phase7FaultRule[];
}

export interface Phase7RunContext {
  schema: "paperclip.phase7.run-context.v1";
  company: Pick<Phase7FixtureCompany, "id" | "name" | "issuePrefix" | "status">;
  actor: Pick<Phase7FixtureActor, "id" | "name" | "role" | "status" | "capabilityGrants">;
  activeTask: Phase7FixtureTask;
  ancestors: Phase7FixtureTask[];
  wake: Phase7WakeContext;
  capabilities: string[];
  budget: { limitCents: number; spentCents: number; remainingCents: number };
  interactionResults: Array<Pick<Phase7FixtureInteraction, "id" | "kind" | "status" | "result">>;
}

export interface Phase7OpenFixtureRunInput extends OpenControlPlaneRunInput {
  wake?: Phase7WakeContext;
  capabilities?: string[];
  resume?: boolean;
}

interface Phase7BaseCommand {
  taskId?: string;
}

export type Phase7SemanticCommand =
  | (Phase7BaseCommand & { kind: "report_progress"; body: string })
  | (Phase7BaseCommand & {
      kind: "write_document";
      key: string;
      title: string;
      body: string;
      baseRevisionId: string | null;
      changeSummary?: string | null;
    })
  | (Phase7BaseCommand & {
      kind: "request_human_input";
      interactionKind: Phase7InteractionKind;
      title: string;
      prompt: string;
      payload?: Phase7JsonValue;
      targetRevisionId?: string | null;
      continuationPolicy: Phase7FixtureInteraction["continuationPolicy"];
    })
  | (Phase7BaseCommand & {
      kind: "resolve_human_input";
      interactionId: string;
      outcome: "answered" | "accepted" | "rejected" | "expired";
      result: Phase7JsonValue;
    })
  | (Phase7BaseCommand & {
      kind: "register_deliverable";
      filename: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      contentRef: string;
      title: string;
    })
  | (Phase7BaseCommand & { kind: "set_dependencies"; blockedByTaskIds: string[] })
  | (Phase7BaseCommand & {
      kind: "create_task";
      title: string;
      description?: string | null;
      assigneeActorId?: string | null;
      priority?: Phase7FixtureTask["priority"];
      blockedByTaskIds?: string[];
    })
  | (Phase7BaseCommand & {
      kind: "request_approval";
      approvalType: string;
      payload: Phase7JsonValue;
    })
  | (Phase7BaseCommand & {
      kind: "decide_approval";
      approvalId: string;
      decision: "approved" | "rejected" | "cancelled";
      note: string;
    })
  | (Phase7BaseCommand & {
      kind: "comment_on_approval";
      approvalId: string;
      body: string;
    })
  | (Phase7BaseCommand & {
      kind: "control_workspace_service";
      serviceId: string;
      action: "start" | "stop" | "fail";
      url?: string | null;
    })
  | (Phase7BaseCommand & { kind: "record_budget_usage"; cents: number })
  | (Phase7BaseCommand & { kind: "finish_task"; summary: string })
  | (Phase7BaseCommand & {
      kind: "block_task";
      reason: string;
      blockedByTaskIds?: string[];
    })
  | (Phase7BaseCommand & { kind: "request_review"; summary: string })
  | (Phase7BaseCommand & { kind: "release_task"; reason: string })
  | (Phase7BaseCommand & {
      kind: "schedule_wake";
      reason: Phase7WakeReason;
      payload?: Phase7JsonValue;
      delayTicks: number;
    });

export interface Phase7CommandEnvelope {
  runId: string;
  idempotencyKey: string;
  expectedRevision?: number;
  command: Phase7SemanticCommand;
}

export interface Phase7CommandResult {
  commandId: string;
  commandKind: Phase7SemanticCommand["kind"];
  disposition: "applied" | "duplicate";
  stateRevision: number;
  entityRefs: string[];
  scheduledWakeIds: string[];
}

export interface Phase7CommandErrorResult {
  code: string;
  message: string;
  retryable: boolean;
}

export type Phase7CommandOutcome =
  | { ok: true; result: Phase7CommandResult }
  | {
      ok: false;
      commandKind: Phase7SemanticCommand["kind"];
      stateRevision: number;
      error: Phase7CommandErrorResult;
    };

/**
 * Claims enforced by the mock command boundary itself. The semantic catalog
 * may hide ungranted operations earlier, but direct adapter consumers cannot
 * bypass these checks.
 */
export const PHASE7_COMMAND_REQUIRED_CLAIMS = {
  report_progress: [],
  write_document: [],
  request_human_input: [],
  resolve_human_input: ["control_plane:interactions"],
  register_deliverable: [],
  set_dependencies: ["dependencies:write"],
  create_task: ["delegation:tasks:create"],
  request_approval: ["governance:approvals:request"],
  decide_approval: ["governance:approvals:decide"],
  comment_on_approval: ["governance:approvals:comment"],
  control_workspace_service: ["workspace:control"],
  record_budget_usage: ["control_plane:budget"],
  finish_task: [],
  block_task: [],
  request_review: [],
  release_task: ["control_plane:release"],
  schedule_wake: ["control_plane:wakes"],
} as const satisfies Record<Phase7SemanticCommand["kind"], readonly string[]>;

export interface Phase7MockControlPlanePort extends ControlPlanePort {
  start(): Promise<void>;
  stop(): Promise<void>;
  openFixtureRun(input: Phase7OpenFixtureRunInput): Promise<Phase7RunContext>;
  context(runId: string): Phase7RunContext;
  applyCommand(envelope: Phase7CommandEnvelope): Promise<Phase7CommandResult>;
  tryApplyCommand(envelope: Phase7CommandEnvelope): Promise<Phase7CommandOutcome>;
  snapshot(): Readonly<Phase7FixtureState>;
  decisionRecords(): readonly Phase7DecisionRecord[];
  serialize(): string;
}

export interface Phase7FixtureSeed {
  epochMs?: number;
  company?: Partial<Phase7FixtureCompany>;
  actors?: Phase7FixtureActor[];
  tasks?: Phase7FixtureTask[];
  comments?: Phase7FixtureComment[];
  documents?: Phase7FixtureDocument[];
  interactions?: Phase7FixtureInteraction[];
  approvals?: Phase7FixtureApproval[];
  artifacts?: Phase7FixtureArtifact[];
  workProducts?: Phase7FixtureWorkProduct[];
  blockers?: Phase7FixtureBlocker[];
  workspaceServices?: Phase7FixtureWorkspaceService[];
  budgets?: Phase7FixtureBudget[];
  faults?: Phase7FaultRule[];
}

export function createPhase7FixtureState(seed: Phase7FixtureSeed = {}): Phase7FixtureState {
  const company: Phase7FixtureCompany = {
    id: "company-1",
    name: "Mock Paperclip Company",
    issuePrefix: "MCK",
    status: "active",
    budgetId: "budget-company-1",
    ...seed.company,
  };
  const actors = seed.actors ?? [
    {
      id: "actor-1",
      companyId: company.id,
      name: "Mock Engineer",
      role: "engineer",
      status: "active",
      budgetId: "budget-actor-1",
      capabilityGrants: [],
    },
  ];
  const tasks = seed.tasks ?? [
    {
      id: "task-1",
      companyId: company.id,
      identifier: `${company.issuePrefix}-1`,
      title: "Deterministic fixture task",
      description: null,
      status: "todo",
      priority: "medium",
      workMode: "standard",
      parentId: null,
      assigneeActorId: actors[0]?.id ?? null,
      checkoutRunId: null,
      executionRunId: null,
      startedAt: null,
      completedAt: null,
    },
  ];
  const budgets = seed.budgets ?? [
    {
      id: company.budgetId,
      scope: "company",
      scopeId: company.id,
      limitCents: 10_000,
      spentCents: 0,
      hardStop: true,
    },
    ...actors.map((actor) => ({
      id: actor.budgetId,
      scope: "actor" as const,
      scopeId: actor.id,
      limitCents: 1_000,
      spentCents: 0,
      hardStop: true,
    })),
  ];
  return {
    schema: "paperclip.phase7.mock-state.v1",
    revision: 0,
    clock: { epochMs: seed.epochMs ?? Date.UTC(2026, 7, 9), tick: 0 },
    counters: {},
    lifecycle: "stopped",
    activeRunId: null,
    company,
    actors: structuredClone(actors),
    tasks: structuredClone(tasks),
    comments: structuredClone(seed.comments ?? []),
    documents: structuredClone(seed.documents ?? []),
    interactions: structuredClone(seed.interactions ?? []),
    approvals: structuredClone(seed.approvals ?? []),
    artifacts: structuredClone(seed.artifacts ?? []),
    workProducts: structuredClone(seed.workProducts ?? []),
    blockers: structuredClone(seed.blockers ?? []),
    workspaceServices: structuredClone(seed.workspaceServices ?? []),
    budgets: structuredClone(budgets),
    runs: [],
    wakes: [],
    audit: [],
    decisions: [],
    idempotency: [],
    faults: structuredClone(seed.faults ?? []),
  };
}
