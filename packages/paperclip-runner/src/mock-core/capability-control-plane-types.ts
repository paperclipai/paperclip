import type {
  CompleteControlPlaneRunInput,
  ControlPlanePort,
  OpenControlPlaneRunInput,
} from "../contracts/control-plane-port.js";
import type { NativeRunEvent, NativeRunResult } from "../contracts/types.js";
import type { PersistedNativeSession } from "../contracts/native-session-backend.js";
import type { PrpEvent } from "../protocol/replay-contract.js";

export type CapabilityJsonPrimitive = string | number | boolean | null;
export type CapabilityJsonValue =
  | CapabilityJsonPrimitive
  | CapabilityJsonValue[]
  | { [key: string]: CapabilityJsonValue };

export type CapabilityTaskStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "done"
  | "blocked"
  | "cancelled";

export interface CapabilityFixtureCompany {
  id: string;
  name: string;
  issuePrefix: string;
  status: "active" | "paused";
  budgetId: string;
}

export interface CapabilityFixtureActor {
  id: string;
  companyId: string;
  name: string;
  role: string;
  status: "active" | "paused";
  budgetId: string;
  capabilityGrants: string[];
}

export interface CapabilityFixtureTask {
  id: string;
  companyId: string;
  identifier: string;
  title: string;
  description: string | null;
  status: CapabilityTaskStatus;
  priority: "critical" | "high" | "medium" | "low";
  workMode: "standard" | "ask" | "planning" | "skill_test";
  parentId: string | null;
  assigneeActorId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface CapabilityFixtureComment {
  id: string;
  taskId: string;
  authorActorId: string | null;
  body: string;
  createdAt: string;
}

export interface CapabilityFixtureDocumentRevision {
  id: string;
  documentId: string;
  revision: number;
  body: string;
  changeSummary: string | null;
  createdAt: string;
}

export interface CapabilityFixtureDocument {
  id: string;
  taskId: string;
  key: string;
  title: string;
  format: "markdown";
  latestRevisionId: string;
  revisions: CapabilityFixtureDocumentRevision[];
}

export type CapabilityInteractionKind =
  | "confirmation"
  | "checkbox"
  | "questions"
  | "suggest_tasks"
  | "item_verdicts";

export interface CapabilityFixtureInteraction {
  id: string;
  taskId: string;
  kind: CapabilityInteractionKind;
  status: "pending" | "answered" | "accepted" | "rejected" | "expired";
  title: string;
  prompt: string;
  payload: CapabilityJsonValue;
  targetRevisionId: string | null;
  continuationPolicy: "none" | "wake_assignee" | "wake_assignee_on_accept";
  result: CapabilityJsonValue | null;
  createdAt: string;
  resolvedAt: string | null;
}

export interface CapabilityFixtureApprovalComment {
  id: string;
  authorActorId: string | null;
  body: string;
  createdAt: string;
}

export interface CapabilityFixtureApproval {
  id: string;
  companyId: string;
  taskIds: string[];
  type: string;
  status: "pending" | "approved" | "rejected" | "cancelled";
  requestedByActorId: string | null;
  payload: CapabilityJsonValue;
  decisionNote: string | null;
  comments: CapabilityFixtureApprovalComment[];
  createdAt: string;
  decidedAt: string | null;
}

export interface CapabilityFixtureArtifact {
  id: string;
  taskId: string;
  filename: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  contentRef: string;
  createdAt: string;
}

export interface CapabilityFixtureWorkProduct {
  id: string;
  taskId: string;
  type: "artifact" | "document" | "pull_request" | "preview_url" | "runtime_service" | "commit" | "branch";
  title: string;
  metadata: CapabilityJsonValue;
  artifactId: string | null;
  createdAt: string;
}

export interface CapabilityFixtureBlocker {
  id: string;
  taskId: string;
  blockedByTaskId: string;
  createdAt: string;
}

export interface CapabilityFixtureWorkspaceService {
  id: string;
  taskId: string;
  name: string;
  status: "stopped" | "starting" | "running" | "failed";
  url: string | null;
  lastTransitionAt: string;
}

export interface CapabilityFixtureBudget {
  id: string;
  scope: "company" | "actor";
  scopeId: string;
  limitCents: number;
  spentCents: number;
  hardStop: boolean;
}

export type CapabilityWakeReason =
  | "manual"
  | "issue_commented"
  | "interaction_resolved"
  | "approval_resolved"
  | "blockers_resolved"
  | "scheduled_retry"
  | "resume";

export interface CapabilityWakeContext {
  reason: CapabilityWakeReason;
  payload: CapabilityJsonValue;
}

export interface CapabilityScheduledWake {
  id: string;
  actorId: string;
  taskId: string;
  reason: CapabilityWakeReason;
  payload: CapabilityJsonValue;
  dueAt: string;
  status: "scheduled" | "delivered" | "cancelled";
  createdAt: string;
}

export interface CapabilityFixtureRun {
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
  wake: CapabilityWakeContext;
  capabilities: string[];
  events: Array<NativeRunEvent | PrpEvent>;
  result: NativeRunResult | CompleteControlPlaneRunInput | null;
  sessionCheckpoint: PersistedNativeSession | null;
}

export interface CapabilityAuditRecord {
  id: string;
  at: string;
  runId: string | null;
  actorId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  details: CapabilityJsonValue;
}

export interface CapabilityDecisionRecord {
  id: string;
  at: string;
  runId: string | null;
  operation: string;
  outcome: "allowed" | "denied" | "duplicate" | "reconciled" | "faulted";
  reason: string;
  stateRevision: number;
  entityRefs: string[];
}

export interface CapabilityFaultRule {
  id: string;
  operation: "open_run" | "append_event" | "apply_command" | "complete_run";
  commandKind?: CapabilitySemanticCommand["kind"];
  effect: "retryable_error" | "lost_ack";
  remaining: number;
  code: string;
}

export interface ScenarioChatdempotencyRecord {
  scope: string;
  key: string;
  inputCanonical: string;
  result: CapabilityCommandResult;
}

export interface CapabilityFixtureState {
  schema: "paperclip.capability.mock-state.v1";
  revision: number;
  clock: { epochMs: number; tick: number };
  counters: Record<string, number>;
  lifecycle: "stopped" | "running";
  activeRunId: string | null;
  company: CapabilityFixtureCompany;
  actors: CapabilityFixtureActor[];
  tasks: CapabilityFixtureTask[];
  /** Known task ids outside the fixture company, without leaking foreign data. */
  outOfScopeTaskIds: string[];
  comments: CapabilityFixtureComment[];
  documents: CapabilityFixtureDocument[];
  interactions: CapabilityFixtureInteraction[];
  approvals: CapabilityFixtureApproval[];
  artifacts: CapabilityFixtureArtifact[];
  workProducts: CapabilityFixtureWorkProduct[];
  blockers: CapabilityFixtureBlocker[];
  workspaceServices: CapabilityFixtureWorkspaceService[];
  budgets: CapabilityFixtureBudget[];
  runs: CapabilityFixtureRun[];
  wakes: CapabilityScheduledWake[];
  audit: CapabilityAuditRecord[];
  decisions: CapabilityDecisionRecord[];
  idempotency: ScenarioChatdempotencyRecord[];
  faults: CapabilityFaultRule[];
}

export interface CapabilityRunContext {
  schema: "paperclip.capability.run-context.v1";
  company: Pick<CapabilityFixtureCompany, "id" | "name" | "issuePrefix" | "status">;
  actor: Pick<CapabilityFixtureActor, "id" | "name" | "role" | "status" | "capabilityGrants">;
  activeTask: CapabilityFixtureTask;
  ancestors: CapabilityFixtureTask[];
  wake: CapabilityWakeContext;
  capabilities: string[];
  budget: { limitCents: number; spentCents: number; remainingCents: number };
  interactionResults: Array<Pick<CapabilityFixtureInteraction, "id" | "kind" | "status" | "result">>;
}

export interface CapabilityOpenFixtureRunInput extends OpenControlPlaneRunInput {
  wake?: CapabilityWakeContext;
  capabilities?: string[];
  resume?: boolean;
}

interface CapabilityBaseCommand {
  taskId?: string;
}

export type CapabilitySemanticCommand =
  | (CapabilityBaseCommand & { kind: "report_progress"; body: string })
  | (CapabilityBaseCommand & {
      kind: "write_document";
      key: string;
      title: string;
      body: string;
      baseRevisionId: string | null;
      changeSummary?: string | null;
    })
  | (CapabilityBaseCommand & {
      kind: "request_human_input";
      interactionKind: CapabilityInteractionKind;
      title: string;
      prompt: string;
      payload?: CapabilityJsonValue;
      targetRevisionId?: string | null;
      continuationPolicy: CapabilityFixtureInteraction["continuationPolicy"];
    })
  | (CapabilityBaseCommand & {
      kind: "resolve_human_input";
      interactionId: string;
      outcome: "answered" | "accepted" | "rejected" | "expired";
      result: CapabilityJsonValue;
    })
  | (CapabilityBaseCommand & {
      kind: "register_deliverable";
      filename: string;
      contentType: string;
      byteSize: number;
      sha256: string;
      contentRef: string;
      title: string;
    })
  | (CapabilityBaseCommand & { kind: "set_dependencies"; blockedByTaskIds: string[] })
  | (CapabilityBaseCommand & {
      kind: "create_task";
      title: string;
      description?: string | null;
      assigneeActorId?: string | null;
      priority?: CapabilityFixtureTask["priority"];
      blockedByTaskIds?: string[];
    })
  | (CapabilityBaseCommand & {
      kind: "request_approval";
      approvalType: string;
      payload: CapabilityJsonValue;
    })
  | (CapabilityBaseCommand & {
      kind: "decide_approval";
      approvalId: string;
      decision: "approved" | "rejected" | "cancelled";
      note: string;
    })
  | (CapabilityBaseCommand & {
      kind: "comment_on_approval";
      approvalId: string;
      body: string;
    })
  | (CapabilityBaseCommand & {
      kind: "control_workspace_service";
      serviceId: string;
      action: "start" | "stop" | "fail";
      url?: string | null;
    })
  | (CapabilityBaseCommand & { kind: "record_budget_usage"; cents: number })
  | (CapabilityBaseCommand & { kind: "finish_task"; summary: string })
  | (CapabilityBaseCommand & {
      kind: "block_task";
      reason: string;
      blockedByTaskIds?: string[];
    })
  | (CapabilityBaseCommand & { kind: "request_review"; summary: string })
  | (CapabilityBaseCommand & { kind: "release_task"; reason: string })
  | (CapabilityBaseCommand & {
      kind: "schedule_wake";
      reason: CapabilityWakeReason;
      payload?: CapabilityJsonValue;
      delayTicks: number;
    });

export interface CapabilityCommandEnvelope {
  runId: string;
  idempotencyKey: string;
  expectedRevision?: number;
  command: CapabilitySemanticCommand;
}

export interface CapabilityCommandResult {
  commandId: string;
  commandKind: CapabilitySemanticCommand["kind"];
  disposition: "applied" | "duplicate";
  stateRevision: number;
  entityRefs: string[];
  scheduledWakeIds: string[];
}

export interface CapabilityCommandErrorResult {
  code: string;
  message: string;
  retryable: boolean;
}

export type CapabilityCommandOutcome =
  | { ok: true; result: CapabilityCommandResult }
  | {
      ok: false;
      commandKind: CapabilitySemanticCommand["kind"];
      stateRevision: number;
      error: CapabilityCommandErrorResult;
    };

/**
 * Claims enforced by the mock command boundary itself. The semantic catalog
 * may hide ungranted operations earlier, but direct adapter consumers cannot
 * bypass these checks.
 */
export const CAPABILITY_COMMAND_REQUIRED_CLAIMS = {
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
} as const satisfies Record<CapabilitySemanticCommand["kind"], readonly string[]>;

export interface CapabilityMockControlPlanePort extends ControlPlanePort {
  start(): Promise<void>;
  stop(): Promise<void>;
  openFixtureRun(input: CapabilityOpenFixtureRunInput): Promise<CapabilityRunContext>;
  context(runId: string): CapabilityRunContext;
  applyCommand(envelope: CapabilityCommandEnvelope): Promise<CapabilityCommandResult>;
  tryApplyCommand(envelope: CapabilityCommandEnvelope): Promise<CapabilityCommandOutcome>;
  snapshot(): Readonly<CapabilityFixtureState>;
  decisionRecords(): readonly CapabilityDecisionRecord[];
  serialize(): string;
}

export interface CapabilityFixtureSeed {
  epochMs?: number;
  company?: Partial<CapabilityFixtureCompany>;
  actors?: CapabilityFixtureActor[];
  tasks?: CapabilityFixtureTask[];
  outOfScopeTaskIds?: string[];
  comments?: CapabilityFixtureComment[];
  documents?: CapabilityFixtureDocument[];
  interactions?: CapabilityFixtureInteraction[];
  approvals?: CapabilityFixtureApproval[];
  artifacts?: CapabilityFixtureArtifact[];
  workProducts?: CapabilityFixtureWorkProduct[];
  blockers?: CapabilityFixtureBlocker[];
  workspaceServices?: CapabilityFixtureWorkspaceService[];
  budgets?: CapabilityFixtureBudget[];
  faults?: CapabilityFaultRule[];
}

export function createCapabilityFixtureState(seed: CapabilityFixtureSeed = {}): CapabilityFixtureState {
  const company: CapabilityFixtureCompany = {
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
    schema: "paperclip.capability.mock-state.v1",
    revision: 0,
    clock: { epochMs: seed.epochMs ?? Date.UTC(2026, 7, 9), tick: 0 },
    counters: {},
    lifecycle: "stopped",
    activeRunId: null,
    company,
    actors: structuredClone(actors),
    tasks: structuredClone(tasks),
    outOfScopeTaskIds: structuredClone(seed.outOfScopeTaskIds ?? []),
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
