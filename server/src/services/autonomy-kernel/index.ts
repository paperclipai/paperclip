import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { agents, approvals, autonomyEvidenceEntries, autonomyIncidents, autonomyRunTransitions, lanePolicies } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import type {
  AutonomyEvidenceEntry,
  AutonomyEvidenceStatus,
  AutonomyEvidenceType,
  AutonomyEvidenceVerdict,
  AutonomyInboxItem,
  AutonomyIncident,
  AutonomyIncidentSeverity,
  AutonomyIncidentStatus,
  AutonomyIncidentType,
  AutonomyLaneStatus,
  AutonomyRunTransition,
  AutonomySourceType,
} from "@paperclipai/shared";
import { createAgentContractService } from "./agent-contracts.js";
import { createApprovalGateService, approvalGateSummaryFromApproval } from "./approval-gates.js";
import { createDependencyGraphService } from "./dependency-graph.js";
import { createEvidenceLedger } from "./evidence-ledger.js";
import { createIncidentService } from "./incidents.js";
import { createLanePolicyService } from "./lane-policy.js";
import { validateRunTransition } from "./run-state-machine.js";
import type {
  AutonomyKernelContext,
  AutonomyKernelOptions,
  AutonomyKernelService,
  AuthorizeRunRequest,
  EvaluateContinuationInput,
  KernelDecision,
  KernelDecisionStatus,
  PreflightExternalGateKind,
  PreflightRunRequest,
  RecordTransitionInput,
} from "./types.js";
import { createValidatorService } from "./validators.js";

const defaultLogger = console;
const AUTONOMY_INBOX_CATEGORY_LIMIT = 250;

function toIso(value: Date | string | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function rowTimestamp(value: Date | string | null): string {
  return toIso(value) ?? new Date(0).toISOString();
}

function incidentDto(row: typeof autonomyIncidents.$inferSelect): AutonomyIncident {
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type as AutonomyIncidentType,
    severity: row.severity as AutonomyIncidentSeverity,
    status: row.status as AutonomyIncidentStatus,
    laneKey: row.laneKey ?? null,
    runId: row.runId ?? null,
    issueId: row.issueId ?? null,
    agentId: row.agentId ?? null,
    sourceType: row.sourceType as AutonomySourceType,
    sourceId: row.sourceId ?? null,
    title: row.title,
    message: row.message,
    remediation: row.remediation ?? null,
    stopsLane: row.stopsLane,
    metadata: (row.metadata as AutonomyIncident["metadata"]) ?? null,
    acknowledgedByUserId: row.acknowledgedByUserId ?? null,
    acknowledgedAt: toIso(row.acknowledgedAt),
    resolvedByUserId: row.resolvedByUserId ?? null,
    resolvedAt: toIso(row.resolvedAt),
    resolutionNote: row.resolutionNote ?? null,
    createdAt: rowTimestamp(row.createdAt),
    updatedAt: rowTimestamp(row.updatedAt),
  };
}

function evidenceDto(row: typeof autonomyEvidenceEntries.$inferSelect): AutonomyEvidenceEntry {
  return {
    id: row.id,
    companyId: row.companyId,
    type: row.type as AutonomyEvidenceType,
    status: row.status as AutonomyEvidenceStatus,
    verdict: row.verdict as AutonomyEvidenceVerdict,
    laneKey: row.laneKey ?? null,
    runId: row.runId ?? null,
    issueId: row.issueId ?? null,
    agentId: row.agentId ?? null,
    sourceType: row.sourceType as AutonomySourceType,
    sourceId: row.sourceId ?? null,
    title: row.title,
    summary: row.summary ?? null,
    uri: row.uri ?? null,
    payload: (row.payload as AutonomyEvidenceEntry["payload"]) ?? null,
    validatorName: row.validatorName ?? null,
    validatorVersion: row.validatorVersion ?? null,
    validatorMessage: row.validatorMessage ?? null,
    validatedAt: toIso(row.validatedAt),
    createdAt: rowTimestamp(row.createdAt),
    updatedAt: rowTimestamp(row.updatedAt),
  };
}

function evidenceSeverity(row: typeof autonomyEvidenceEntries.$inferSelect): AutonomyIncidentSeverity {
  return row.status === "rejected" || row.verdict === "validator_error" || row.verdict === "rejected" ? "error" : "warning";
}

function laneSeverity(status: AutonomyLaneStatus): AutonomyIncidentSeverity {
  if (status === "stopped") return "critical";
  if (status === "blocked") return "error";
  return "warning";
}

function allow(reason: string | null = null): KernelDecision {
  return { status: "allow", reason, incidentIds: [], approvalGateIds: [] };
}

function mergeDecision(status: KernelDecisionStatus, reason: string | null, incidentIds: string[] = [], approvalGateIds: string[] = []): KernelDecision {
  return { status, reason, incidentIds, approvalGateIds };
}

function createTransitionDto(input: RecordTransitionInput): AutonomyRunTransition {
  const now = (input.transitionedAt ?? new Date()).toISOString();
  return {
    id: randomUUID(),
    companyId: input.companyId,
    runId: input.runId,
    issueId: input.issueId ?? null,
    agentId: input.agentId ?? null,
    laneKey: input.laneKey ?? null,
    fromState: input.fromState,
    toState: input.toState,
    terminalClassification: input.terminalClassification ?? null,
    reason: input.reason ?? null,
    actorType: input.actorType ?? "kernel",
    actorId: input.actorId ?? null,
    evidenceEntryIds: input.evidenceEntryIds ?? [],
    incidentIds: input.incidentIds ?? [],
    metadata: input.metadata ?? null,
    transitionedAt: now,
    createdAt: now,
  };
}

export function autonomyKernelService(db: Db, options: AutonomyKernelOptions = {}): AutonomyKernelService {
  const context: AutonomyKernelContext = {
    db,
    logger: options.logger ?? defaultLogger,
    preflightChecks: options.preflightChecks ?? {},
    enforceAgentContracts: options.enforceAgentContracts ?? true,
  };

  const agentContracts = createAgentContractService(context);
  const approvalsSvc = createApprovalGateService(context);
  const dependencyGraph = createDependencyGraphService(context);
  const validators = createValidatorService(context);

  const evidenceLedger = createEvidenceLedger(context);
  const incidents = createIncidentService(context);
  const lanePolicy = createLanePolicyService(context);

  async function createPreflightIncident(
    request: PreflightRunRequest,
    input: {
      type: AutonomyIncidentType;
      title: string;
      message: string;
      severity?: "info" | "warning" | "error" | "critical";
      stopsLane?: boolean;
      remediation?: string | null;
      sourceType?: "heartbeat_run" | "issue" | "budget" | "kernel" | "external";
      sourceId?: string | null;
    },
  ): Promise<string> {
    const incident = await incidents.createIncident({
      companyId: request.companyId,
      runId: null,
      issueId: request.issueId ?? null,
      agentId: request.agentId ?? null,
      laneKey: request.laneKey ?? "default",
      type: input.type,
      severity: input.severity ?? "error",
      title: input.title,
      message: input.message,
      remediation: input.remediation ?? "Resolve the preflight blocker and retry the autonomous run.",
      stopsLane: input.stopsLane ?? false,
      sourceType: input.sourceType ?? "kernel",
      sourceId: input.sourceId ?? request.runId,
      idempotent: true,
      idempotencyKey: `preflight:${request.companyId}:${request.runId}:${input.type}`,
      metadata: { gate: input.type },
    });
    return incident.id;
  }

  async function runExternalGate(request: PreflightRunRequest, gate: PreflightExternalGateKind): Promise<KernelDecision | null> {
    const check = context.preflightChecks[gate];
    if (!check) return null;
    const result = await check({ ...request, gate });
    if (result.status === "allow") return null;
    const incidentIds: string[] = [];
    if (result.status === "deny" && result.incidentType) {
      incidentIds.push(
        await createPreflightIncident(request, {
          type: result.incidentType,
          title: `${gate} preflight denied`,
          message: result.reason ?? `${gate} preflight denied`,
          severity: result.severity ?? (gate === "budget" ? "critical" : "error"),
          remediation: result.remediation ?? null,
          sourceType: gate === "budget" ? "budget" : "external",
        }),
      );
    }
    return mergeDecision(result.status, result.reason ?? `${gate} preflight returned ${result.status}`, incidentIds);
  }

  async function evaluatePreflight(request: PreflightRunRequest): Promise<KernelDecision> {
    for (const gate of ["auth", "budget"] as const) {
      const decision = await runExternalGate(request, gate);
      if (decision) return decision;
    }

    if (!request.agentId) {
      const id = await createPreflightIncident(request, {
        type: "AGENT_API_UNAUTHORIZED",
        title: "Preflight missing agent",
        message: "Autonomous run preflight requires an agent id before wakeup.",
        severity: "error",
      });
      return mergeDecision("deny", "Autonomous run preflight requires an agent id", [id]);
    }

    const [agent] = await db
      .select()
      .from(agents)
      .where(and(eq(agents.companyId, request.companyId), eq(agents.id, request.agentId)))
      .limit(1);
    if (!agent) {
      const id = await createPreflightIncident(request, {
        type: "AGENT_API_UNAUTHORIZED",
        title: "Agent not authorized for company",
        message: `Agent ${request.agentId} was not found in company ${request.companyId}.`,
        severity: "error",
      });
      return mergeDecision("deny", "Agent is not authorized for this company", [id]);
    }
    if (agent.pausedAt || agent.pauseReason || ["paused", "disabled", "archived"].includes(agent.status)) {
      const id = await createPreflightIncident(request, {
        type: "AUTH_STALE_AGENT_CODEX",
        title: "Agent is not runnable",
        message: `Agent ${agent.name} is ${agent.status}${agent.pauseReason ? `: ${agent.pauseReason}` : ""}.`,
        severity: "error",
      });
      return mergeDecision("deny", "Agent is not runnable", [id]);
    }
    if (agent.budgetMonthlyCents > 0 && agent.spentMonthlyCents >= agent.budgetMonthlyCents) {
      const id = await createPreflightIncident(request, {
        type: "LANE_BUDGET_EXCEEDED",
        title: "Agent budget exceeded",
        message: `Agent ${agent.name} has spent ${agent.spentMonthlyCents} of ${agent.budgetMonthlyCents} monthly cents.`,
        severity: "critical",
        stopsLane: true,
        sourceType: "budget",
      });
      return mergeDecision("deny", "Agent budget exceeded", [id]);
    }

    const workspaceDecision = await runExternalGate(request, "workspace");
    if (workspaceDecision) return workspaceDecision;
    if (request.requiresWorkspace && !agent.defaultEnvironmentId && !request.metadata?.workspaceId) {
      const id = await createPreflightIncident(request, {
        type: "WORKSPACE_MISSING",
        title: "Workspace missing",
        message: "Run requires a workspace but no workspace/environment is attached to the agent or request.",
        severity: "error",
      });
      return mergeDecision("deny", "Workspace missing", [id]);
    }

    if (request.metadata?.skipDependencyGraphPreflight !== true) {
      const dependencies = await dependencyGraph.evaluateDependencies(request);
      if (dependencies.status === "deny") {
        const id = await createPreflightIncident(request, {
          type: "DEPENDENCY_GRAPH_INVALID",
          title: "Dependency graph invalid",
          message: dependencies.reason ?? "Dependency graph is invalid.",
          severity: "critical",
          stopsLane: true,
        });
        return mergeDecision("deny", dependencies.reason, [id]);
      }
      if (dependencies.status === "blocked") {
        return mergeDecision("blocked", dependencies.reason);
      }
    }

    const lane = await lanePolicy.evaluateLane(request);
    if (lane.status === "deny") {
      const id = await createPreflightIncident(request, {
        type: "LANE_STOPPED",
        title: "Lane policy denied run",
        message: lane.reason ?? "Lane policy denied the autonomous run.",
        severity: "error",
      });
      return mergeDecision("deny", lane.reason, [id]);
    }
    if (lane.status === "blocked") {
      return mergeDecision("blocked", lane.reason);
    }

    const contract = await agentContracts.evaluateContract({ ...request, laneKey: lane.laneKey });
    if (contract.status === "deny") {
      const id = await createPreflightIncident(request, {
        type: "ISSUE_CONTRACT_MISSING",
        title: "Issue contract missing",
        message: contract.reason ?? "No active agent contract covers this run.",
        severity: "critical",
        stopsLane: true,
      });
      return mergeDecision("deny", contract.reason, [id]);
    }

    const governedAction = request.governedAction ??
      (typeof request.metadata?.governedAction === "string" ? request.metadata.governedAction : null);
    const approvalRequired = contract.status === "approval_required" || (governedAction !== null && lane.requiresApprovalFor.includes(governedAction));
    if (approvalRequired) {
      if (!governedAction) {
        const id = await createPreflightIncident(request, {
          type: "HIDDEN_APPROVAL_BLOCKER",
          title: "Approval required but cannot be represented",
          message: "A preflight gate required approval without a governed action to show in the approvals inbox.",
          severity: "critical",
          stopsLane: true,
        });
        return mergeDecision("deny", "Approval required but no visible approval can be represented", [id]);
      }
      try {
        const gate = await approvalsSvc.ensureVisibleApprovalGate({
          ...request,
          laneKey: lane.laneKey,
          governedAction,
          risk: contract.reason,
          policySource: contract.status === "approval_required" ? `agent_contract:${contract.contract?.id ?? "unknown"}` : `lane_policy:${lane.policyId ?? lane.laneKey}`,
        });
        return mergeDecision("approval_required", contract.reason ?? `Approval required for ${governedAction}`, [], [gate.id]);
      } catch (error) {
        context.logger.error("Failed to create visible approval gate", error);
        const id = await createPreflightIncident(request, {
          type: "CONTROLLER_INVARIANT_BROKEN",
          title: "Approval gate invariant failed",
          message: "A preflight gate required approval but the kernel could not create a visible approval object.",
          severity: "critical",
          stopsLane: true,
        });
        return mergeDecision("deny", "Approval required but visible approval creation failed", [id]);
      }
    }

    return allow("All autonomy preflight gates passed.");
  }

  return {
    preflightRun: evaluatePreflight,

    async authorizeRun(request: AuthorizeRunRequest): Promise<KernelDecision> {
      return evaluatePreflight(request);
    },

    async recordTransition(input: RecordTransitionInput): Promise<AutonomyRunTransition> {
      validateRunTransition(input);
      const dto = createTransitionDto(input);
      await db.insert(autonomyRunTransitions).values({
        id: dto.id,
        companyId: dto.companyId,
        runId: dto.runId,
        issueId: dto.issueId,
        agentId: dto.agentId,
        laneKey: dto.laneKey,
        fromState: dto.fromState,
        toState: dto.toState,
        terminalClassification: dto.terminalClassification,
        reason: dto.reason,
        actorType: dto.actorType,
        actorId: dto.actorId,
        evidenceEntryIds: dto.evidenceEntryIds,
        incidentIds: dto.incidentIds,
        metadata: dto.metadata,
        transitionedAt: new Date(dto.transitionedAt),
        createdAt: new Date(dto.createdAt),
      });
      return dto;
    },

    recordEvidence: evidenceLedger.recordEvidence,
    validateEvidence: evidenceLedger.validateEvidence,
    validateEvidenceCandidate: validators.validateEvidenceCandidate,
    createIncident: incidents.createIncident,
    resolveIncident: incidents.resolveIncident,

    async evaluateContinuation(_input: EvaluateContinuationInput): Promise<KernelDecision> {
      return allow("Autonomy kernel skeleton continuation has no queued follow-up until policy is implemented.");
    },

    getCompanyLaneStatus: lanePolicy.getCompanyLaneStatus,

    async getAutonomyInbox(companyId: string): Promise<AutonomyInboxItem[]> {
      const [approvalRows, incidentRows, evidenceRows, laneRows] = await Promise.all([
        db
          .select()
          .from(approvals)
          .where(and(eq(approvals.companyId, companyId), eq(approvals.status, "pending"), eq(approvals.type, "autonomy_preflight_gate")))
          .orderBy(desc(approvals.updatedAt))
          .limit(AUTONOMY_INBOX_CATEGORY_LIMIT),
        db
          .select()
          .from(autonomyIncidents)
          .where(and(eq(autonomyIncidents.companyId, companyId), ne(autonomyIncidents.status, "resolved")))
          .orderBy(desc(autonomyIncidents.updatedAt))
          .limit(AUTONOMY_INBOX_CATEGORY_LIMIT),
        db
          .select()
          .from(autonomyEvidenceEntries)
          .where(
            and(
              eq(autonomyEvidenceEntries.companyId, companyId),
              ne(autonomyEvidenceEntries.status, "accepted"),
              ne(autonomyEvidenceEntries.status, "superseded"),
            ),
          )
          .orderBy(desc(autonomyEvidenceEntries.updatedAt))
          .limit(AUTONOMY_INBOX_CATEGORY_LIMIT),
        db
          .select()
          .from(lanePolicies)
          .where(
            and(
              eq(lanePolicies.companyId, companyId),
              inArray(lanePolicies.status, ["blocked", "degraded", "stopped"]),
            ),
          )
          .orderBy(desc(lanePolicies.updatedAt))
          .limit(AUTONOMY_INBOX_CATEGORY_LIMIT),
      ]);

      const approvalItems: AutonomyInboxItem[] = approvalRows.map((row) => {
        const approvalGate = approvalGateSummaryFromApproval(row);
        return {
          id: row.id,
          companyId: row.companyId,
          kind: "approval_gate",
          severity: "warning",
          status: approvalGate.status,
          title: "Autonomy approval required",
          summary: `Approval required for ${approvalGate.governedAction}`,
          laneKey: approvalGate.laneKey,
          runId: approvalGate.runId,
          issueId: approvalGate.issueId,
          agentId: approvalGate.agentId,
          incident: null,
          approvalGate,
          evidenceEntry: null,
          createdAt: rowTimestamp(row.createdAt),
          updatedAt: rowTimestamp(row.updatedAt),
        };
      });

      const incidentItems: AutonomyInboxItem[] = incidentRows.map((row) => {
        const incident = incidentDto(row);
        return {
          id: row.id,
          companyId: row.companyId,
          kind: "incident",
          severity: incident.severity,
          status: incident.status,
          title: incident.title,
          summary: incident.remediation ? `${incident.message} Remediation: ${incident.remediation}` : incident.message,
          laneKey: incident.laneKey,
          runId: incident.runId,
          issueId: incident.issueId,
          agentId: incident.agentId,
          incident,
          approvalGate: null,
          evidenceEntry: null,
          createdAt: incident.createdAt,
          updatedAt: incident.updatedAt,
        };
      });

      const evidenceItems: AutonomyInboxItem[] = evidenceRows.map((row) => {
        const evidenceEntry = evidenceDto(row);
        return {
          id: row.id,
          companyId: row.companyId,
          kind: "evidence_validation",
          severity: evidenceSeverity(row),
          status: evidenceEntry.status,
          title: evidenceEntry.status === "rejected" ? `Evidence rejected: ${evidenceEntry.title}` : `Evidence validation pending: ${evidenceEntry.title}`,
          summary: evidenceEntry.validatorMessage ?? evidenceEntry.summary ?? null,
          laneKey: evidenceEntry.laneKey,
          runId: evidenceEntry.runId,
          issueId: evidenceEntry.issueId,
          agentId: evidenceEntry.agentId,
          incident: null,
          approvalGate: null,
          evidenceEntry,
          createdAt: evidenceEntry.createdAt,
          updatedAt: evidenceEntry.updatedAt,
        };
      });

      const laneItems: AutonomyInboxItem[] = laneRows.map((row) => {
        const status = row.status as AutonomyLaneStatus;
        return {
          id: `lane:${row.id}`,
          companyId: row.companyId,
          kind: "lane_block",
          severity: laneSeverity(status),
          status,
          title: `Lane ${row.laneName} is ${status}`,
          summary: row.statusReason ?? null,
          laneKey: row.laneKey,
          runId: row.activeRunId ?? null,
          issueId: row.activeIssueId ?? null,
          agentId: row.activeAgentId ?? null,
          incident: null,
          approvalGate: null,
          evidenceEntry: null,
          createdAt: rowTimestamp(row.createdAt),
          updatedAt: rowTimestamp(row.updatedAt),
        };
      });

      return [...approvalItems, ...incidentItems, ...evidenceItems, ...laneItems].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
  };
}

export * from "./run-state-machine.js";
export * from "./evidence-extractors.js";
export { AutonomyEvidenceLedgerError } from "./evidence-ledger.js";
export { AutonomyIncidentError } from "./incidents.js";
export type * from "./types.js";
