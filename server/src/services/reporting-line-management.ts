import { agents, companies, companyMemberships, principalPermissionGrants, toolConnectionInstalls, toolProfileBindings, type Db } from "@paperclipai/db";
import { reportingLinePolicySchema, delegatedRuntimeScopeSchema, type ReportingLinePolicy } from "@paperclipai/shared";
import { and, eq, or } from "drizzle-orm";
import { conflict, forbidden } from "../errors.js";
import type { AgentConfigurationPatch, AgentConfigurationRecord, CreateAgentData, CreateAgentOptions } from "../lib/agent-records.js";
import { authorizationService, subtreeGrantRoots, type AuthorizationActor } from "./authorization.js";
import { withAccountingTransaction } from "./accounting-transaction.js";
import { environmentService } from "./environments.js";

type GraphAgent = Pick<AgentConfigurationRecord, "id" | "reportsTo" | "status" | "lifecycleState">;
type Graph = Map<string, GraphAgent>;
type RuntimeChoice = Pick<CreateAgentData, "adapterType" | "adapterConfig" | "defaultEnvironmentId" | "runtimeConfig">;
type AgentActor = AuthorizationActor & { agentId: string };

export async function reportingLinePolicyFor(db: Db, companyId: string) {
  const [company] = await db.select({ policy: companies.reportingLinePolicy }).from(companies).where(eq(companies.id, companyId));
  const parsed = reportingLinePolicySchema.safeParse(company?.policy);
  return parsed.success && parsed.data.enabled ? parsed.data : null;
}

export async function assertReportingLinePolicyOwner(db: Db, companyId: string, actor: AuthorizationActor) {
  if (actor.type === "board") {
    if (actor.source === "local_implicit" || (actor.isInstanceAdmin && !actor.ignoreInstanceAdmin)) return;
    if (actor.userId) {
      const [owner] = await db.select({ id: companyMemberships.id }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, companyId), eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, actor.userId), eq(companyMemberships.membershipRole, "owner"),
        eq(companyMemberships.status, "active"),
      ));
      if (owner) return;
    }
  }
  throw forbidden("Company owner access is required");
}

async function companyGraph(db: Db, companyId: string): Promise<Graph> {
  const rows = await db.select({
    id: agents.id, reportsTo: agents.reportsTo, status: agents.status, lifecycleState: agents.lifecycleState,
  }).from(agents).where(eq(agents.companyId, companyId));
  return new Map(rows.map(row => [row.id, row]));
}

function counts(agent: GraphAgent) {
  return agent.lifecycleState !== "terminated" && agent.lifecycleState !== "rejected";
}

function lineage(graph: Graph, agentId: string) {
  const chain = new Set<string>();
  let id: string | null = agentId;
  while (id !== null) {
    const agent = graph.get(id);
    if (!agent || chain.has(id)) throw conflict("Invalid reporting chain");
    chain.add(id);
    id = agent.reportsTo;
  }
  return chain;
}

function assertGraphLimits(graph: Graph, policy: ReportingLinePolicy, rootId?: string) {
  const directReports = new Map<string, number>();
  for (const agent of graph.values()) {
    if (!counts(agent)) continue;
    if (agent.reportsTo) directReports.set(agent.reportsTo, (directReports.get(agent.reportsTo) ?? 0) + 1);
    const chain = lineage(graph, agent.id);
    if ((!rootId || chain.has(rootId)) && chain.size - 1 > policy.maxDepth) {
      throw conflict("Maximum reporting depth exceeded");
    }
  }
  for (const [managerId, count] of directReports) {
    if ((!rootId || graph.get(rootId)?.reportsTo === managerId) && count > policy.maxDirectReports) {
      throw conflict("Maximum direct reports exceeded");
    }
  }
}

export async function assertReportingLinePolicyChange(db: Db, companyId: string, policy: ReportingLinePolicy | null | undefined, requiresApproval: boolean) {
  if (!policy?.enabled) return;
  if (requiresApproval) throw conflict("Turn off board approval for new hires before letting agents manage their reports");
  assertGraphLimits(await companyGraph(db, companyId), policy);
}

export async function assertReportingLineActor(db: Db, companyId: string, actor: AuthorizationActor) {
  if (actor.type !== "agent" || !actor.agentId) throw forbidden("Agent authentication required");
  const [member] = await db.select({ id: agents.id, bounded: agents.delegatedHire }).from(agents).innerJoin(companyMemberships, and(
    eq(companyMemberships.companyId, agents.companyId), eq(companyMemberships.principalId, actor.agentId),
    eq(companyMemberships.principalType, "agent"), eq(companyMemberships.status, "active"),
  )).where(and(eq(agents.id, actor.agentId), eq(agents.companyId, companyId), eq(agents.lifecycleState, "ready")));
  if (!member) throw forbidden("Only ready agents with active company membership can manage their reports");
  const decision = await authorizationService(db).decide({
    actor, action: "agents:create", resource: { type: "company", companyId },
    ...(member.bounded ? { scope: { reportingLineManagement: true } } : {}),
  });
  if (!decision.allowed) throw forbidden(decision.explanation);
  return actor as AgentActor;
}

function assertBranchTarget(graph: Graph, actor: AgentActor, targetId: string, allowSelf = false) {
  const chain = lineage(graph, targetId);
  if ((!allowSelf && targetId === actor.agentId) || !chain.has(actor.agentId)) {
    throw forbidden("This agent is outside your reporting branch");
  }
  for (const id of chain) {
    if (id !== targetId && graph.get(id)?.status === "terminated") throw conflict("Invalid reporting chain");
  }
}

export async function assertReportRoleDescriptionUpdate(db: Db, target: AgentConfigurationRecord, actor: AuthorizationActor) {
  if (actor.type !== "agent" || actor.agentId === target.id || !await reportingLinePolicyFor(db, target.companyId)) return false;
  const manager = await assertReportingLineActor(db, target.companyId, actor);
  const graph = await companyGraph(db, target.companyId);
  assertBranchTarget(graph, manager, target.id);
  await assertOwnerManagedBindingsAbsent(db, target);
  await assertDelegableRuntime(db, target.companyId, graph, manager.agentId, target);
  return true;
}

async function assertDelegableRuntime(db: Db, companyId: string, graph: Graph, managerId: string, runtime: RuntimeChoice) {
  const config = runtime.adapterConfig ?? {};
  if (Object.keys(runtime.runtimeConfig ?? {}).some(key => key !== "heartbeat" && key !== "timezone")) {
    throw forbidden("This runtime has owner-managed settings");
  }
  if (Object.keys(config).some(key => !["provider", "model", "codexPermissionMode", "opencodePermissionMode",
    "lifecycleMode", "instructionsBundleMode", "instructionsRootPath", "instructionsEntryFile", "instructionsFilePath"].includes(key)) ||
    config.instructionsBundleMode === "external") {
    throw forbidden("This adapter has owner-managed settings");
  }
  if (!runtime.defaultEnvironmentId || runtime.adapterType !== "paperclip_runner" ||
    typeof config.provider !== "string" || typeof config.model !== "string") {
    throw forbidden("This runtime choice requires owner configuration");
  }
  const environment = await environmentService(db).getById(runtime.defaultEnvironmentId);
  const bound = await environmentService(db).listBoundCompanyIds(runtime.defaultEnvironmentId);
  if (!environment || environment.status !== "active" || environment.driver !== "sandbox" ||
    Object.keys(environment.envVars ?? {}).length > 0 || (bound.length && !bound.includes(companyId))) {
    throw forbidden("This environment requires owner configuration");
  }
  const grants = await db.select({
    principalId: principalPermissionGrants.principalId, scope: principalPermissionGrants.scope,
  }).from(principalPermissionGrants).innerJoin(companyMemberships, and(
    eq(companyMemberships.companyId, principalPermissionGrants.companyId),
    eq(companyMemberships.principalType, principalPermissionGrants.principalType),
    eq(companyMemberships.principalId, principalPermissionGrants.principalId),
    eq(companyMemberships.status, "active"),
  )).where(and(eq(principalPermissionGrants.companyId, companyId),
    eq(principalPermissionGrants.principalType, "agent"), eq(principalPermissionGrants.permissionKey, "agents:delegate_runtime")));
  const managers = lineage(graph, managerId);
  for (const grant of grants) {
    if (!managers.has(grant.principalId) || graph.get(grant.principalId)?.lifecycleState !== "ready") continue;
    const scope = delegatedRuntimeScopeSchema.safeParse(grant.scope);
    if (scope.success && scope.data.choices.some(choice =>
      (grant.principalId === managerId || choice.includeDescendants) &&
      choice.environmentId === runtime.defaultEnvironmentId && choice.adapterType === runtime.adapterType &&
      choice.provider === config.provider && choice.model === config.model)) return;
  }
  throw forbidden("Owner approval is required to delegate this runtime choice");
}

export function assertReportingLineHireInput(body: Record<string, unknown>) {
  const allowed = new Set(["reportsTo", "name", "title", "icon", "appearance", "role", "adapterType",
    "adapterConfig", "defaultEnvironmentId", "instructionsBundle", "runtimeConfig", "budgetMonthlyCents", "sourceIssueId", "sourceIssueIds"]);
  const config = (body.adapterConfig ?? {}) as Record<string, unknown>;
  if (Object.entries(body).some(([key, value]) => value !== undefined && !allowed.has(key)) ||
    Object.keys(config).some(key => key !== "provider" && key !== "model") ||
    Object.keys((body.runtimeConfig ?? {}) as object).length || Number(body.budgetMonthlyCents ?? 0) !== 0 ||
    (body.role !== undefined && body.role !== "general")) {
    throw forbidden("Delegated hires accept an approved runtime, role brief, and ordinary profile fields");
  }
}

export async function assertReportingLineHireReplay(db: Db, agentId: string, companyId: string, actor: AuthorizationActor) {
  return withAccountingTransaction(db, companyId, async tx => {
    if (!await reportingLinePolicyFor(tx, companyId)) throw forbidden("The reporting-line policy is off");
    const manager = await assertReportingLineActor(tx, companyId, actor);
    const graph = await companyGraph(tx, companyId);
    assertBranchTarget(graph, manager, agentId);
    const [agent] = await tx.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (!agent || !agent.delegatedHire || !counts(agent)) throw conflict("The previous hire is unavailable");
    if (agent.defaultEnvironmentId) await assertDelegableRuntime(tx, companyId, graph, manager.agentId, agent);
  });
}

export async function prepareReportingLineHire(db: Db, companyId: string, id: string, data: CreateAgentData, options?: CreateAgentOptions) {
  const policy = await reportingLinePolicyFor(db, companyId);
  const actor = options?.reportingLineActor ?? (options?.createdByAgentId
    ? { type: "agent" as const, agentId: options.createdByAgentId, companyId }
    : undefined);
  if (!policy) {
    if (options?.requiresReportingLinePolicy) throw forbidden("The reporting-line policy is off");
    if (actor?.type === "agent" && actor.agentId) {
      const [record] = await db.select({ bounded: agents.delegatedHire }).from(agents).where(and(
        eq(agents.companyId, companyId), eq(agents.id, actor.agentId),
      ));
      if (record?.bounded) throw forbidden("The reporting-line policy is off");
    }
    return { reportsTo: data.reportsTo, bounded: false };
  }
  const graph = await companyGraph(db, companyId);
  let reportsTo = data.reportsTo ?? null;
  if (actor?.type === "agent") {
    const manager = await assertReportingLineActor(db, companyId, actor);
    if (options?.reportingLineHireInput) assertReportingLineHireInput(options.reportingLineHireInput);
    if (data.reportsTo === null || options?.setupOnly || options?.setupAgentId || data.status !== "idle" ||
      options?.aiConnectionInstall || data.metadata || data.permissions ||
      data.role !== "general" || (data.budgetMonthlyCents ?? 0) !== 0) {
      throw forbidden("This hire requires owner configuration");
    }
    reportsTo ??= manager.agentId;
    assertBranchTarget(graph, manager, reportsTo, true);
    if (!graph.get(reportsTo) || graph.get(reportsTo)?.lifecycleState !== "ready") throw conflict("The destination manager is not ready");
    if (data.adapterType === "process" && !data.defaultEnvironmentId && !Object.keys(data.adapterConfig ?? {}).length) {
      data.status = "paused";
    } else {
      await assertDelegableRuntime(db, companyId, graph, manager.agentId, data);
      if (reportsTo !== manager.agentId) await assertDelegableRuntime(db, companyId, graph, reportsTo, data);
    }
  }
  graph.set(id, { id, reportsTo, status: data.status ?? "idle", lifecycleState: "preparing" });
  assertGraphLimits(graph, policy, id);
  return { reportsTo, bounded: actor?.type === "agent" };
}

async function assertOwnerManagedBindingsAbsent(db: Db, agent: AgentConfigurationRecord) {
  const [install] = await db.select({ id: toolConnectionInstalls.id }).from(toolConnectionInstalls).where(and(
    eq(toolConnectionInstalls.companyId, agent.companyId),
    or(eq(toolConnectionInstalls.targetType, "company"), eq(toolConnectionInstalls.targetId, agent.id)),
  )).limit(1);
  const [profile] = await db.select({ id: toolProfileBindings.id }).from(toolProfileBindings).where(and(
    eq(toolProfileBindings.companyId, agent.companyId),
    or(eq(toolProfileBindings.targetType, "company"), eq(toolProfileBindings.targetId, agent.id)),
  )).limit(1);
  if (!agent.delegatedHire || install || profile || Object.values(agent.permissions).some(value => value === true)) {
    throw forbidden("The agent's effective access requires owner configuration");
  }
}

async function assertMovePreservesDelegation(db: Db, companyId: string, before: Graph, after: Graph, rootId: string, actorId: string) {
  const grants = await db.select({
    principalId: principalPermissionGrants.principalId, permissionKey: principalPermissionGrants.permissionKey,
    scope: principalPermissionGrants.scope,
  }).from(principalPermissionGrants).where(eq(principalPermissionGrants.companyId, companyId));
  const callerChain = lineage(before, actorId);
  for (const agent of before.values()) {
    if (!counts(agent)) continue;
    const oldChain = lineage(before, agent.id);
    if (!oldChain.has(rootId)) continue;
    const newChain = lineage(after, agent.id);
    for (const grant of grants) {
      if (!grant.scope) continue;
      const roots = subtreeGrantRoots(grant.scope);
      if (roots.some(id => newChain.has(id)) && !roots.some(id => oldChain.has(id))) {
        throw forbidden("An owner must move a branch into an additional scoped grant");
      }
      if (grant.permissionKey !== "agents:delegate_runtime" || oldChain.has(grant.principalId) ||
        !newChain.has(grant.principalId)) continue;
      const scope = delegatedRuntimeScopeSchema.safeParse(grant.scope);
      if (!scope.success) continue;
      for (const choice of scope.data.choices) {
        if (!choice.includeDescendants) continue;
        const callerCanDelegate = grants.some(candidate => {
          if (candidate.permissionKey !== "agents:delegate_runtime" || !callerChain.has(candidate.principalId)) return false;
          const candidateScope = delegatedRuntimeScopeSchema.safeParse(candidate.scope);
          return candidateScope.success && candidateScope.data.choices.some(approved =>
            (candidate.principalId === actorId || approved.includeDescendants) &&
            approved.environmentId === choice.environmentId && approved.adapterType === choice.adapterType &&
            approved.provider === choice.provider && approved.model === choice.model);
        });
        if (!callerCanDelegate) throw forbidden("An owner must move a branch into additional resource delegation");
      }
    }
  }
}

export async function assertReportingLineConfiguration(db: Db, current: AgentConfigurationRecord, patch: AgentConfigurationPatch, actor?: AuthorizationActor, requiresReportingLinePolicy?: boolean) {
  const policy = await reportingLinePolicyFor(db, current.companyId);
  if (actor?.type === "agent" && actor.agentId === current.id && current.delegatedHire &&
    Object.keys(patch).some(key => !["name", "title", "icon", "appearance"].includes(key))) {
    throw forbidden("This configuration change requires owner access");
  }
  if (!policy) {
    if (requiresReportingLinePolicy) throw forbidden("The reporting-line policy is off");
    return;
  }
  if (actor?.type !== "agent" && patch.reportsTo === undefined) return;
  const graph = await companyGraph(db, current.companyId);
  const manager = actor?.type === "agent" && (actor.agentId !== current.id || patch.reportsTo !== undefined)
    ? await assertReportingLineActor(db, current.companyId, actor)
    : null;
  if (manager) {
    assertBranchTarget(graph, manager, current.id);
    if (current.lifecycleState === "pending_approval") throw conflict("Resolve the pending hire before changing this agent");
    const fields = Object.keys(patch);
    if (fields.some(key => key !== "reportsTo")) await assertOwnerManagedBindingsAbsent(db, current);
    if (fields.some(key => !["name", "title", "icon", "appearance", "reportsTo", "defaultEnvironmentId", "adapterConfig"].includes(key))) {
      throw forbidden("This configuration change requires owner access");
    }
    if (fields.some(key => key !== "reportsTo")) {
      await assertDelegableRuntime(db, current.companyId, graph, manager.agentId, current);
      if (patch.adapterConfig && Object.keys({ ...current.adapterConfig, ...patch.adapterConfig }).some(key =>
        key !== "provider" && key !== "model" && !Object.is(current.adapterConfig[key], patch.adapterConfig![key]) &&
        JSON.stringify(current.adapterConfig[key]) !== JSON.stringify(patch.adapterConfig![key]))) {
        throw forbidden("Only approved model and provider settings can change");
      }
      if (patch.defaultEnvironmentId !== undefined || patch.adapterConfig !== undefined) {
        await assertDelegableRuntime(db, current.companyId, graph, manager.agentId, { ...current, ...patch });
      }
    }
  }
  if (patch.reportsTo === undefined || patch.reportsTo === current.reportsTo) return;
  if (manager) {
    if (!patch.reportsTo) throw forbidden("Only an owner can move an agent to a root");
    assertBranchTarget(graph, manager, patch.reportsTo, true);
    if (graph.get(patch.reportsTo)?.lifecycleState !== "ready") throw conflict("The destination manager is not ready");
  }
  const nextGraph = new Map(graph);
  nextGraph.set(current.id, { ...current, reportsTo: patch.reportsTo });
  assertGraphLimits(nextGraph, policy, current.id);
  if (manager) await assertMovePreservesDelegation(db, current.companyId, graph, nextGraph, current.id, manager.agentId);
}

export async function assertReportingLineLifecycle(db: Db, target: AgentConfigurationRecord, command: string, actor?: AuthorizationActor) {
  if (actor?.type !== "agent") return;
  const policy = await reportingLinePolicyFor(db, target.companyId);
  if (!policy) {
    if (command === "pause" || command === "terminate" || target.delegatedHire) throw forbidden("The reporting-line policy is off");
    const decision = await authorizationService(db).decide({
      actor, action: "agent_config:update", resource: { type: "agent", companyId: target.companyId, agentId: target.id },
      scope: { requiresChangeGrant: true },
    });
    if (!decision.allowed) throw forbidden(decision.explanation);
    return;
  }
  const manager = await assertReportingLineActor(db, target.companyId, actor);
  if (command === "resume") await assertOwnerManagedBindingsAbsent(db, target);
  const graph = await companyGraph(db, target.companyId);
  assertBranchTarget(graph, manager, target.id);
  if (command === "terminate" && [...graph.values()].some(report => report.reportsTo === target.id && counts(report))) {
    throw conflict("Move or retire this agent's direct reports before retirement");
  }
  if (command === "resume") await assertDelegableRuntime(db, target.companyId, graph, manager.agentId, target);
}
