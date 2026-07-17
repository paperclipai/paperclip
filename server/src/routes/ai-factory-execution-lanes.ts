import { createHash, randomUUID } from "node:crypto";
import { Router, type Request } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import type {
  CompiledFactoryPolicyV1,
  FactoryPolicyV1,
  IssueExecutionPolicy,
  IssueExecutionStage,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { conflict, HttpError, unauthorized, unprocessable } from "../errors.js";
import {
  accessService,
  agentService,
  aiFactoryExecutionLaneService,
  companySkillService,
  heartbeatService,
  issueService,
  issueVisibilityService,
  logActivity,
  type VisibilityPrincipal,
} from "../services/index.js";
import {
  buildInitialIssueExecutionWorkflow,
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
} from "../services/issue-execution-policy.js";
import {
  authorizeFactoryManagedCreate,
  authorizeFactoryManagedPolicyPin,
} from "../services/issues.js";
import {
  assertFactoryExecutionPolicySnapshotConsistent,
  effectiveFactoryExecutionLaneMaximum,
  factoryPolicyStageIsSelected,
  factoryStageEvidenceGates,
  factoryStageReturnTarget,
} from "../services/ai-factory-policy.js";
import {
  factoryControlAuthorizationFingerprint,
  type FactoryControlAuthorizationSource,
} from "../services/ai-factory-execution-lanes.js";
import {
  assertCompanyAccess,
  getActorInfo,
  requirePermission,
  requireProjectAccess,
} from "./authz.js";

const ACTIVE_FACTORY_AGENT_STATUSES = new Set(["active", "idle", "running"]);

const createFactoryExecutionLaneSchema = z.object({
  title: z.string().trim().min(1).max(500).optional(),
  description: z.string().max(100_000).nullable().optional(),
  production: z.boolean().optional().default(false),
  blockParentUntilDone: z.boolean().optional().default(true),
  roleAgentOverrides: z.record(z.string().uuid()).optional().default({}),
}).strict();

function factoryLaneIdempotency(req: Request, input: {
  controlIssueId: string;
  policyHash: string;
}) {
  const key = req.header("idempotency-key");
  if (key === undefined) return null;
  const roleAgentOverrides = Object.fromEntries(
    Object.entries(req.body.roleAgentOverrides as Record<string, string>)
      .sort(([left], [right]) => left.localeCompare(right)),
  );
  const requestFingerprint = createHash("sha256")
    .update(JSON.stringify({
      controlIssueId: input.controlIssueId,
      policyHash: input.policyHash,
      title: req.body.title ?? null,
      description: req.body.description ?? null,
      production: req.body.production,
      blockParentUntilDone: req.body.blockParentUntilDone,
      roleAgentOverrides,
    }))
    .digest("hex");
  return { key, requestFingerprint };
}

type FactoryAgentCandidate = {
  id: string;
  companyId: string;
  name: string;
  title: string | null;
  role: string;
  status: string;
};

function normalizedRoleText(value: string | null | undefined) {
  return (value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function roleAliases(role: string) {
  const normalized = normalizedRoleText(role);
  const aliases = new Set([normalized]);
  const known: Record<string, string[]> = {
    ceo: ["chief executive officer"],
    cto: ["chief technology officer", "chief technical officer"],
    cmo: ["chief marketing officer"],
    cfo: ["chief financial officer"],
    qa: ["quality assurance", "test engineer", "software tester"],
    devops: ["devops", "site reliability", "platform engineer", "deployment engineer"],
    engineer: ["software engineer", "developer"],
    pm: ["product manager", "project manager"],
  };
  for (const alias of known[normalized] ?? []) aliases.add(alias);
  return [...aliases].filter(Boolean);
}

function factoryRoleMatchScore(agent: FactoryAgentCandidate, requestedRole: string) {
  const requested = normalizedRoleText(requestedRole);
  const agentRole = normalizedRoleText(agent.role);
  const title = normalizedRoleText(agent.title);
  const name = normalizedRoleText(agent.name);
  if (agentRole === requested) return 1_000;
  const aliases = roleAliases(requestedRole);
  if (aliases.some((alias) => title === alias)) return 800;
  if (aliases.some((alias) => name === alias)) return 700;
  if (aliases.some((alias) => alias.length >= 3 && title.includes(alias))) return 600;
  if (aliases.some((alias) => alias.length >= 3 && name.includes(alias))) return 500;
  return 0;
}

export function selectFactoryAgentForRole(
  input: {
    agents: FactoryAgentCandidate[];
    role: string;
    overrideAgentId?: string | null;
    excludeAgentIds?: Iterable<string>;
  },
) {
  const excluded = new Set(input.excludeAgentIds ?? []);
  const activeAgents = input.agents.filter(
    (agent) => ACTIVE_FACTORY_AGENT_STATUSES.has(agent.status) && !excluded.has(agent.id),
  );

  if (input.overrideAgentId) {
    const overridden = input.agents.find((agent) => agent.id === input.overrideAgentId) ?? null;
    if (!overridden) {
      throw unprocessable(`AI Factory role override for ${input.role} does not reference a company agent.`, {
        code: "factory_role_override_invalid",
        role: input.role,
        agentId: input.overrideAgentId,
        reason: "agent_not_found",
      });
    }
    if (!ACTIVE_FACTORY_AGENT_STATUSES.has(overridden.status)) {
      throw unprocessable(`AI Factory role override for ${input.role} is not active.`, {
        code: "factory_role_override_invalid",
        role: input.role,
        agentId: input.overrideAgentId,
        reason: "agent_not_active",
        status: overridden.status,
      });
    }
    if (excluded.has(overridden.id)) {
      throw unprocessable(`AI Factory role override for ${input.role} violates stage independence.`, {
        code: "factory_independence_conflict",
        role: input.role,
        agentId: overridden.id,
      });
    }
    return overridden;
  }

  const ranked = activeAgents
    .map((agent) => ({ agent, score: factoryRoleMatchScore(agent, input.role) }))
    .filter((candidate) => candidate.score > 0)
    .sort((left, right) =>
      right.score - left.score
      || left.agent.name.localeCompare(right.agent.name)
      || left.agent.id.localeCompare(right.agent.id));
  const selected = ranked[0]?.agent ?? null;
  if (!selected) {
    throw unprocessable(`No active AI Factory agent can fill the ${input.role} role.`, {
      code: "factory_role_unavailable",
      role: input.role,
      activeAgentIds: activeAgents.map((agent) => agent.id).sort(),
    });
  }
  return selected;
}

function deepCopyFactoryPolicy(policy: FactoryPolicyV1): FactoryPolicyV1 {
  return JSON.parse(JSON.stringify(policy)) as FactoryPolicyV1;
}

function buildFactoryExecutionPolicy(input: {
  compiled: CompiledFactoryPolicyV1;
  agents: FactoryAgentCandidate[];
  production: boolean;
  controlIssueId: string;
  roleAgentOverrides: Record<string, string>;
}) {
  const policyStages = input.compiled.policy.stages.filter(
    (stage) => factoryPolicyStageIsSelected(stage, input.production),
  );
  if (policyStages.length === 0) {
    throw unprocessable("The selected AI Factory policy has no stages for this lane type.", {
      code: "factory_stages_empty",
      production: input.production,
      policyKey: input.compiled.skillKey,
    });
  }

  const coordinatorRole = input.compiled.policy.roles.laneCoordinatorRole;
  const coordinatorAgent = selectFactoryAgentForRole({
    agents: input.agents,
    role: coordinatorRole,
    overrideAgentId: input.roleAgentOverrides[coordinatorRole],
  });
  const stages: IssueExecutionStage[] = [];
  const priorWorkAndDeploymentAgentIds = new Set<string>();
  for (const [index, stage] of policyStages.entries()) {
    const excludedAgentIds = stage.independent
      ? new Set([coordinatorAgent.id, ...priorWorkAndDeploymentAgentIds])
      : undefined;
    const participant = selectFactoryAgentForRole({
      agents: input.agents,
      role: stage.role,
      overrideAgentId: input.roleAgentOverrides[stage.role],
      excludeAgentIds: excludedAgentIds,
    });
    stages.push({
      id: randomUUID(),
      key: stage.key,
      type: stage.type,
      role: stage.role,
      independent: stage.independent ?? false,
      returnToStageKey: factoryStageReturnTarget(policyStages, index),
      evidenceGates: factoryStageEvidenceGates(stage),
      approvalsNeeded: 1,
      participants: [{ id: randomUUID(), type: "agent", agentId: participant.id }],
    });
    if (stage.type === "work" || stage.type === "deployment") {
      priorWorkAndDeploymentAgentIds.add(participant.id);
    }
  }

  const executionPolicy: IssueExecutionPolicy = {
    mode: "normal",
    commentRequired: true,
    stages,
    factory: {
      schemaVersion: 1,
      laneKind: "execution",
      topologyMode: "same_issue_only",
      controlIssueId: input.controlIssueId,
      coordinator: { type: "agent", agentId: coordinatorAgent.id },
      policyKey: input.compiled.skillKey,
      policyVersion: String(input.compiled.policy.version),
      policyHash: input.compiled.contentHash,
      maxExecutionLanes: effectiveFactoryExecutionLaneMaximum(input.compiled.policy),
      policySnapshot: deepCopyFactoryPolicy(input.compiled.policy),
      production: input.production,
    },
  };
  assertFactoryExecutionPolicySnapshotConsistent({
    executionPolicy,
    expectedControlIssueId: input.controlIssueId,
  });
  return { executionPolicy, coordinatorAgent, selectedPolicyStages: policyStages };
}

function issueFactoryMetadata(issue: { executionPolicy?: unknown }) {
  const policy = issue.executionPolicy;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return null;
  const factory = (policy as Record<string, unknown>).factory;
  return factory && typeof factory === "object" && !Array.isArray(factory)
    ? factory as Record<string, unknown>
    : null;
}

function effectiveCompiledFactoryPolicy(
  parent: { id: string; executionPolicy?: unknown },
  current: CompiledFactoryPolicyV1,
): CompiledFactoryPolicyV1 {
  const storedPolicy = normalizeIssueExecutionPolicy(parent.executionPolicy);
  const factory = storedPolicy?.factory ?? null;
  if (!factory) return current;
  if (factory.laneKind !== "control") {
    throw conflict("A top-level AI Factory control issue cannot carry an execution-lane snapshot.", {
      code: "factory_control_snapshot_conflict",
      issueId: parent.id,
      laneKind: factory.laneKind,
    });
  }
  if (!factory.policySnapshot) {
    if (factory.policyHash !== current.contentHash || factory.policyKey !== current.skillKey) {
      throw conflict("The control issue is pinned to an older policy without a full immutable snapshot.", {
        code: "factory_control_snapshot_missing",
        issueId: parent.id,
        policyKey: factory.policyKey,
        policyHash: factory.policyHash,
        currentPolicyKey: current.skillKey,
        currentPolicyHash: current.contentHash,
      });
    }
  }
  const snapshot = assertFactoryExecutionPolicySnapshotConsistent({
    executionPolicy: storedPolicy!,
    fallbackPolicySnapshot: factory.policySnapshot ? undefined : current.policy,
    expectedControlIssueId: null,
  });
  return {
    ...current,
    skillKey: factory.policyKey,
    contentHash: factory.policyHash,
    policy: deepCopyFactoryPolicy(snapshot),
  };
}

function buildFactoryControlPolicy(input: {
  parentExecutionPolicy: unknown;
  compiled: CompiledFactoryPolicyV1;
  coordinatorAgentId: string;
}) {
  const existing = normalizeIssueExecutionPolicy(input.parentExecutionPolicy);
  const effectiveMaximum = effectiveFactoryExecutionLaneMaximum(input.compiled.policy);
  const executionPolicy = {
    mode: existing?.mode ?? "normal",
    commentRequired: true,
    stages: existing?.stages ?? [],
    ...(existing?.monitor ? { monitor: existing.monitor } : {}),
    factory: {
      schemaVersion: 1 as const,
      laneKind: "control" as const,
      topologyMode: effectiveMaximum === 1
        ? "single_execution_lane" as const
        : "direct_execution_lanes" as const,
      controlIssueId: null,
      coordinator: { type: "agent" as const, agentId: input.coordinatorAgentId },
      policyKey: input.compiled.skillKey,
      policyVersion: String(input.compiled.policy.version),
      policyHash: input.compiled.contentHash,
      maxExecutionLanes: effectiveMaximum,
      policySnapshot: deepCopyFactoryPolicy(input.compiled.policy),
    },
  } satisfies IssueExecutionPolicy;
  assertFactoryExecutionPolicySnapshotConsistent({
    executionPolicy,
    expectedControlIssueId: null,
  });
  return executionPolicy;
}

function stageWakeDescriptor(stage: IssueExecutionStage) {
  if (stage.type === "work") return { reason: "execution_work_requested", wakeRole: "worker", allowedActions: ["complete_stage", "block"] };
  if (stage.type === "verification") return { reason: "execution_verification_requested", wakeRole: "verifier", allowedActions: ["pass", "request_changes", "block"] };
  if (stage.type === "deployment") return { reason: "execution_deployment_requested", wakeRole: "deployer", allowedActions: ["complete_stage", "block"] };
  if (stage.type === "approval") return { reason: "execution_approval_requested", wakeRole: "approver", allowedActions: ["approve", "request_changes"] };
  return { reason: "execution_review_requested", wakeRole: "reviewer", allowedActions: ["approve", "request_changes"] };
}

function assertFactoryControlAccess(input: {
  req: Request;
  parent: {
    id: string;
    companyId: string;
    assigneeAgentId: string | null;
    executionPolicy?: unknown;
  };
  agents: FactoryAgentCandidate[];
  compiled: CompiledFactoryPolicyV1;
}) {
  if (input.req.actor.type === "board") return;
  const actorAgentId = input.req.actor.type === "agent" ? input.req.actor.agentId : null;
  if (!actorAgentId) {
    throw new HttpError(403, "AI Factory lane control requires board or controlling-agent access.", {
      code: "factory_lane_control_forbidden",
      issueId: input.parent.id,
    });
  }
  if (input.parent.assigneeAgentId === actorAgentId) return;
  const existingCoordinator = issueFactoryMetadata(input.parent)?.coordinator;
  if (
    existingCoordinator
    && typeof existingCoordinator === "object"
    && !Array.isArray(existingCoordinator)
    && (existingCoordinator as Record<string, unknown>).agentId === actorAgentId
  ) return;

  const actorAgent = input.agents.find((agent) => agent.id === actorAgentId) ?? null;
  const controlRoles = [
    input.compiled.policy.roles.controlOwnerRole,
    input.compiled.policy.roles.laneCoordinatorRole,
  ];
  if (
    actorAgent
    && ACTIVE_FACTORY_AGENT_STATUSES.has(actorAgent.status)
    && controlRoles.some((role) => factoryRoleMatchScore(actorAgent, role) > 0)
  ) return;

  throw new HttpError(403, "AI Factory lane control requires board or controlling-agent access.", {
    code: "factory_lane_control_forbidden",
    issueId: input.parent.id,
    actorAgentId,
    assigneeAgentId: input.parent.assigneeAgentId,
  });
}

function factoryVisibilityPrincipal(req: Request): VisibilityPrincipal {
  if (req.actor.type === "agent") {
    return { kind: "agent", agentId: req.actor.agentId ?? "" };
  }
  if (req.actor.type === "board") {
    if (req.actor.source === "local_implicit") return { kind: "system" };
    return {
      kind: "user",
      userId: req.actor.userId ?? "",
      isInstanceAdmin: Boolean(req.actor.isInstanceAdmin),
    };
  }
  return { kind: "user", userId: "" };
}

function factoryRunContext(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function buildExecutionLaneContract(input: {
  parent: { id: string; identifier?: string | null; title: string };
  title: string;
  compiled: CompiledFactoryPolicyV1;
  production: boolean;
  stageKeys: string[];
}) {
  return {
    schemaVersion: 2,
    revision: 1,
    contractType: "delegated_task",
    taskType: input.production ? "production_delivery" : "implementation",
    core: {
      objective: input.title,
      why: `Deliver the scoped work for ${input.parent.identifier ?? input.parent.id} through the snapshotted AI Factory workflow.`,
      sourceOfTruth: [{ kind: "control_issue", issueId: input.parent.id }],
      acceptanceChecks: input.stageKeys.map((stageKey) => ({ stageKey, required: true })),
      constraints: [
        "Keep all work and evidence in this execution lane.",
        "Do not create child issues or sub-issues from this execution lane.",
      ],
      evidenceRequired: ["Record delivery evidence through the authoritative delivery event API."],
      handoffNotes: {
        managerReasoning: "A typed AI Factory lane preserves independent execution, verification, and acceptance ownership.",
      },
    },
    extensions: {
      aiFactory: {
        laneKind: "execution",
        controlIssueId: input.parent.id,
        topologyMode: "same_issue_only",
        companyPolicyKey: input.compiled.skillKey,
        companyPolicyHash: input.compiled.contentHash,
        production: input.production,
      },
    },
  };
}

export function aiFactoryExecutionLaneRoutes(db: Db) {
  const router = Router();
  const issuesSvc = issueService(db);
  const access = accessService(db);
  const agentsSvc = agentService(db);
  const skillsSvc = companySkillService(db);
  const factoryLanes = aiFactoryExecutionLaneService(db);
  const heartbeat = heartbeatService(db);
  const visibility = issueVisibilityService(db);

  async function loadContext(req: Request) {
    const parent = await issuesSvc.getById(req.params.id as string);
    if (!parent) return null;
    if (parent.projectId) {
      await requireProjectAccess(req, access, parent.companyId, parent.projectId);
    } else {
      assertCompanyAccess(req, parent.companyId);
    }
    if (
      parent.visibility === "private"
      && !(await visibility.canSeeIssue(factoryVisibilityPrincipal(req), parent))
    ) {
      return null;
    }
    if (parent.parentId) {
      throw unprocessable("Execution lanes can only be created or listed under a top-level control issue.", {
        code: "factory_lane_parent_required",
        issueId: parent.id,
        parentId: parent.parentId,
      });
    }
    const [currentCompiled, companyAgents] = await Promise.all([
      skillsSvc.getAiFactoryPolicy(parent.companyId),
      agentsSvc.list(parent.companyId),
    ]);
    const compiled = effectiveCompiledFactoryPolicy(parent, currentCompiled);
    assertFactoryControlAccess({ req, parent, agents: companyAgents, compiled });
    return { parent, compiled, companyAgents };
  }

  router.get("/issues/:id/execution-lanes", async (req, res) => {
    const context = await loadContext(req);
    if (!context) {
      res.status(404).json({ error: "Control issue not found" });
      return;
    }
    const children = await issuesSvc.list(context.parent.companyId, { parentId: context.parent.id });
    const visibleChildren = await visibility.filterVisibleIssues(
      factoryVisibilityPrincipal(req),
      children,
    );
    const lanes = visibleChildren.filter((issue) => {
      const factory = issueFactoryMetadata(issue);
      return factory?.laneKind === "execution" && factory.controlIssueId === context.parent.id;
    });
    res.json({
      controlIssueId: context.parent.id,
      policyKey: context.compiled.skillKey,
      policyHash: context.compiled.contentHash,
      lanes,
    });
  });

  router.post(
    "/issues/:id/execution-lanes",
    validate(createFactoryExecutionLaneSchema),
    async (req, res) => {
      const context = await loadContext(req);
      if (!context) {
        res.status(404).json({ error: "Control issue not found" });
        return;
      }
      await requirePermission(req, access, context.parent.companyId, "tasks:assign");
      if (req.actor.type === "agent") {
        const actorAgentId = req.actor.agentId;
        const actorRunId = req.actor.runId?.trim();
        if (!actorAgentId) throw unauthorized("Agent authentication required");
        if (!actorRunId) throw unauthorized("Agent run id required");
        const run = await heartbeat.getRun(actorRunId);
        const runContext = factoryRunContext(run?.contextSnapshot);
        if (
          !run
          || run.companyId !== context.parent.companyId
          || run.agentId !== actorAgentId
          || run.status !== "running"
          || ![runContext.issueId, runContext.taskId, runContext.sourceIssueId].includes(context.parent.id)
        ) {
          throw new HttpError(403, "Factory execution lanes require an active control run scoped to this issue.", {
            code: "factory_control_run_required",
            controlIssueId: context.parent.id,
          });
        }
      }
      if (
        req.body.production
        && context.compiled.policy.productionAuthority.mode === "board_approval_required"
        && req.actor.type !== "board"
      ) {
        throw new HttpError(403, "This AI Factory policy requires board approval to create a production lane.", {
          code: "factory_production_board_approval_required",
          controlIssueId: context.parent.id,
          policyKey: context.compiled.skillKey,
          policyHash: context.compiled.contentHash,
        });
      }
      const existingChildren = await issuesSvc.list(context.parent.companyId, { parentId: context.parent.id });
      const existingFactoryLanes = existingChildren.filter((issue) => {
        const factory = issueFactoryMetadata(issue);
        return factory?.laneKind === "execution" && factory.controlIssueId === context.parent.id;
      });

      const pinnedCoordinator = normalizeIssueExecutionPolicy(context.parent.executionPolicy)?.factory?.coordinator;
      const pinnedCoordinatorAgentId = pinnedCoordinator?.type === "agent"
        ? pinnedCoordinator.agentId ?? null
        : null;
      const coordinatorRole = context.compiled.policy.roles.laneCoordinatorRole;
      const requestedCoordinatorOverride = req.body.roleAgentOverrides[coordinatorRole] ?? null;
      if (
        pinnedCoordinatorAgentId
        && requestedCoordinatorOverride
        && requestedCoordinatorOverride !== pinnedCoordinatorAgentId
      ) {
        throw conflict("The control issue coordinator is part of its immutable factory snapshot.", {
          code: "factory_coordinator_frozen",
          controlIssueId: context.parent.id,
          coordinatorAgentId: pinnedCoordinatorAgentId,
          requestedCoordinatorAgentId: requestedCoordinatorOverride,
        });
      }
      const built = buildFactoryExecutionPolicy({
        compiled: context.compiled,
        agents: context.companyAgents,
        production: req.body.production,
        controlIssueId: context.parent.id,
        roleAgentOverrides: {
          ...req.body.roleAgentOverrides,
          ...(pinnedCoordinatorAgentId ? { [coordinatorRole]: pinnedCoordinatorAgentId } : {}),
        },
      });
      const initialWorkflow = buildInitialIssueExecutionWorkflow({ policy: built.executionPolicy });
      if (!initialWorkflow) {
        throw unprocessable("The AI Factory execution policy could not initialize its first stage.", {
          code: "factory_workflow_initialization_failed",
          controlIssueId: context.parent.id,
        });
      }
      const actor = getActorInfo(req);
      const laneNumber = existingFactoryLanes.length + 1;
      const title = req.body.title ?? `${context.parent.title} — execution lane ${laneNumber}`;
      const executionContract = buildExecutionLaneContract({
        parent: context.parent,
        title,
        compiled: context.compiled,
        production: req.body.production,
        stageKeys: built.selectedPolicyStages.map((stage) => stage.key),
      });
      const {
        issue,
        parentBlockerAdded,
        parentPinned,
        idempotentReplay,
      } = await factoryLanes.create(context.parent.id, {
        companyId: context.parent.companyId,
        parentAuthorizationFingerprint: factoryControlAuthorizationFingerprint(context.parent),
        authorizeLockedParent: async (lockedParent: FactoryControlAuthorizationSource) => {
          if (lockedParent.projectId) {
            await requireProjectAccess(
              req,
              access,
              lockedParent.companyId,
              lockedParent.projectId,
            );
          } else {
            assertCompanyAccess(req, lockedParent.companyId);
          }
          if (
            lockedParent.visibility === "private"
            && !(await visibility.canSeeIssue(factoryVisibilityPrincipal(req), lockedParent))
          ) {
            throw new HttpError(404, "Control issue not found");
          }
          assertFactoryControlAccess({
            req,
            parent: lockedParent,
            agents: context.companyAgents,
            compiled: context.compiled,
          });
        },
        controlExecutionPolicy: buildFactoryControlPolicy({
          parentExecutionPolicy: context.parent.executionPolicy,
          compiled: context.compiled,
          coordinatorAgentId: built.coordinatorAgent.id,
        }),
        factoryManagedPolicyPin: authorizeFactoryManagedPolicyPin(context.compiled.contentHash),
        actorAgentId: actor.agentId,
        actorUserId: actor.actorType === "user" ? actor.actorId : null,
        idempotency: factoryLaneIdempotency(req, {
          controlIssueId: context.parent.id,
          policyHash: context.compiled.contentHash,
        }),
        child: {
          title,
          description: req.body.description ?? `Typed AI Factory execution lane for ${context.parent.identifier ?? context.parent.id}.`,
          priority: context.parent.priority,
          workMode: context.parent.workMode,
          visibility: context.parent.visibility,
          executionContract,
          executionPolicy: built.executionPolicy as unknown as Record<string, unknown>,
          executionState: initialWorkflow.executionState as Record<string, unknown>,
          status: initialWorkflow.status as string,
          assigneeAgentId: initialWorkflow.assigneeAgentId as string,
          blockParentUntilDone: req.body.blockParentUntilDone,
          createdByAgentId: actor.agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null,
          actorAgentId: actor.agentId,
          actorUserId: actor.actorType === "user" ? actor.actorId : null,
          factoryManagedCreate: authorizeFactoryManagedCreate(
            context.compiled.contentHash,
            context.parent.id,
          ),
        },
      });

      const persistedPolicy = normalizeIssueExecutionPolicy(issue.executionPolicy);
      const persistedState = parseIssueExecutionState(issue.executionState);
      const firstStage = persistedPolicy?.stages[0] ?? null;
      const initialStageStillActive = Boolean(
        firstStage
        && persistedState?.currentStageId === firstStage.id
        && persistedState.stageRevision === 1
        && persistedState.completedStageIds.length === 0,
      );
      const firstParticipantAgentId = firstStage?.participants[0]?.agentId ?? null;
      const wakeDescriptor = firstStage ? stageWakeDescriptor(firstStage) : null;
      const factoryWakeStage = firstStage && firstParticipantAgentId && wakeDescriptor && persistedState
        ? {
            wakeRole: wakeDescriptor.wakeRole,
            stageId: firstStage.id,
            stageKey: firstStage.key ?? null,
            stageType: firstStage.type,
            stageRole: firstStage.role ?? null,
            stageRevision: persistedState.stageRevision,
            evidenceGates: [...(firstStage.evidenceGates ?? [])],
            currentParticipant: { type: "agent" as const, agentId: firstParticipantAgentId },
            returnAssignee: built.executionPolicy.factory?.coordinator ?? null,
            allowedActions: wakeDescriptor.allowedActions,
            factory: {
              laneKind: "execution" as const,
              controlIssueId: built.executionPolicy.factory?.controlIssueId ?? context.parent.id,
              policyKey: built.executionPolicy.factory?.policyKey ?? context.compiled.skillKey,
              policyVersion: built.executionPolicy.factory?.policyVersion ?? String(context.compiled.policy.version),
              policyHash: built.executionPolicy.factory?.policyHash ?? context.compiled.contentHash,
              production: built.executionPolicy.factory?.production ?? req.body.production,
            },
          }
        : null;
      let wakeup: unknown = null;
      let wakeupError: string | null = null;
      if (firstStage && firstParticipantAgentId && wakeDescriptor && initialStageStillActive) {
        try {
          wakeup = await heartbeat.wakeup(firstParticipantAgentId, {
            source: "assignment",
            triggerDetail: "system",
            reason: wakeDescriptor.reason,
            payload: {
              issueId: issue.id,
              mutation: "factory_execution_lane_created",
              executionStage: factoryWakeStage,
            },
            requestedByActorType: actor.actorType,
            requestedByActorId: actor.actorId,
            idempotencyKey: `factory_execution_lane:${issue.id}:${firstStage.id}:1`,
            contextSnapshot: {
              issueId: issue.id,
              taskId: issue.id,
              wakeReason: wakeDescriptor.reason,
              source: "issue.factory_execution_lane",
              executionStage: factoryWakeStage,
            },
          });
        } catch (error) {
          wakeupError = error instanceof Error ? error.message : String(error);
        }
      }

      if (!idempotentReplay) {
        await logActivity(db, {
          companyId: context.parent.companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "issue.factory_execution_lane_created",
          entityType: "issue",
          entityId: issue.id,
          details: {
            controlIssueId: context.parent.id,
            policyKey: context.compiled.skillKey,
            policyHash: context.compiled.contentHash,
            production: req.body.production,
            stageKeys: built.selectedPolicyStages.map((stage) => stage.key),
            coordinatorAgentId: built.coordinatorAgent.id,
            parentBlockerAdded,
            parentPinned,
            wakeupError,
          },
        });
      }

      res.status(idempotentReplay ? 200 : 201).json({
        lane: issue,
        parentBlockerAdded,
        parentPinned,
        idempotentReplay,
        policyKey: context.compiled.skillKey,
        policyHash: context.compiled.contentHash,
        wakeup,
        wakeupError,
      });
    },
  );

  return router;
}
