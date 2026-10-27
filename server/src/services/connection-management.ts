import { and, eq, inArray, or } from "drizzle-orm";
import { isUuidLike } from "@paperclipai/shared";
import { agents, agentApiKeys, heartbeatRuns, runIdentityContexts, issues, projects, toolApplications, toolCatalogEntries, toolConnections, toolConnectionInstalls, toolProfiles, toolProfileEntries, toolProfileBindings, toolMcpGateways, aiConnectionPools, connectionGrants, routines, type Db } from "@paperclipai/db";
import { forbidden } from "../errors.js";
import { authorizationService, canActorReadIssuePrivacy, canActorReadProjectPrivacy, type AuthorizationActor, type AuthorizationDecision } from "./authorization.js";
import { captureRunIdentity, runIdentityTaskFields, type RunIdentityCapture } from "./run-identity.js";
import type { LogActivityInput } from "./activity-log.js";
import type { ConnectionManagementAction, ConnectionManagementResource } from "./connection-management-policy.js";

export type ConnectionManagementContext = {
  actor: AuthorizationActor;
  responsibleUserId: string | null;
  resource: ConnectionManagementResource;
  workContext: { runId: string | null; issueId: string | null; projectId: string | null };
  decision: AuthorizationDecision;
  audit: Pick<LogActivityInput, "actorType" | "actorId" | "agentId" | "runId" | "agentApiKeyId" | "responsibleUserIdOverride" | "authorization">;
  reauthorize: (continuation?: { afterHumanAction: true }) => Promise<void>;
};

type CapturedConnectionRun = RunIdentityCapture<"task_authorization">;
const connectionReadRuns = new WeakMap<ConnectionManagementContext, CapturedConnectionRun>();

export function responsibleConnectionUser(actor: AuthorizationActor): string | null {
  return (actor.type === "agent" ? actor.onBehalfOfUserId : actor.userId) ?? null;
}

/** Used at HTTP and service boundaries; capability probes call the same evaluator. */
export function connectionManagementService(db: Db) {
  const authorization = authorizationService(db);

  async function authorize(
    actor: AuthorizationActor,
    action: ConnectionManagementAction,
    resource: ConnectionManagementResource,
    options: { targetAgentIds?: string[]; mutation?: boolean; afterHumanAction?: boolean; expandedProfile?: boolean; gatewayContextChecked?: boolean; readContext?: ConnectionManagementContext; capabilityProbe?: boolean } = {},
  ): Promise<ConnectionManagementContext> {
    const responsibleUserId = responsibleConnectionUser(actor);
    let workContext: ConnectionManagementContext["workContext"] = { runId: null, issueId: null, projectId: null };
    let capturedRun: CapturedConnectionRun | undefined;
    if (actor.type === "agent") {
      if (!responsibleUserId || !actor.agentId || actor.companyId !== resource.companyId) {
        throw forbidden("Connection management requires a responsible user in this company");
      }
      const [agent] = await db.select().from(agents).where(and(eq(agents.id, actor.agentId), eq(agents.companyId, resource.companyId)));
      if (!agent || ["terminated", "pending_approval", "paused"].includes(agent.status)) throw forbidden("Agent is not active");
      if (actor.keyId) {
        const [key] = await db.select().from(agentApiKeys).where(and(eq(agentApiKeys.id, actor.keyId), eq(agentApiKeys.agentId, actor.agentId), eq(agentApiKeys.companyId, resource.companyId)));
        if (!key || key.revokedAt || key.responsibleUserId !== responsibleUserId || (key.scopeConfig && key.scopeConfig.kind !== "standard")) throw forbidden("Agent key authority is no longer valid");
      }
      if (actor.runId) {
        const reusable = options.capabilityProbe && !options.afterHumanAction && options.readContext?.actor === actor && options.readContext.resource.companyId === resource.companyId
          ? connectionReadRuns.get(options.readContext) : undefined;
        const captured = reusable ?? (options.afterHumanAction ? await (async () => {
          const [run] = await db.select(runIdentityTaskFields).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, actor.runId!), eq(heartbeatRuns.agentId, actor.agentId!), eq(heartbeatRuns.companyId, resource.companyId)));
          if (!run || !["running", "succeeded"].includes(run.status)) throw forbidden("The originating run cannot continue this authentication");
          const [pending] = await db.select().from(runIdentityContexts).where(and(eq(runIdentityContexts.runId, run.id), eq(runIdentityContexts.status, "pending")));
          if (pending) throw forbidden("Run identity is being reconciled");
          return { run, context: null };
        })() : await captureRunIdentity(db, { companyId: resource.companyId, agentId: actor.agentId, runId: actor.runId }, { readScope: "task_authorization" }));
        capturedRun = captured;
        const { run, context } = captured;
        if ((context?.responsibleUserId ?? run.responsibleUserId) !== responsibleUserId) throw forbidden("Run responsible-user authority has changed");
        const snapshot = run.contextSnapshot ?? {};
        const issueId = run.issueId ?? (typeof snapshot.issueId === "string" ? snapshot.issueId : typeof snapshot.taskId === "string" ? snapshot.taskId : null);
        const [issue] = issueId ? await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, resource.companyId))) : [];
        workContext = { runId: run.id, issueId, projectId: issue?.projectId ?? null };
        if (issueId && (!issue || issue.assigneeAgentId !== actor.agentId || ["cancelled", "done"].includes(issue.status))) throw forbidden("Run no longer owns an eligible task");
        if (snapshot.paperclipSkillTest || issue?.workMode === "skill_test") throw forbidden("Skill tests cannot administer connections");
        if ((options.mutation ?? action !== "connections:read") && issue && issue.workMode !== "standard") throw forbidden("Connection changes are unavailable in Ask and Plan modes");
      }
    }
    const expandedTargets = new Set(options.targetAgentIds ?? []);
    const referencedConnections: string[] = [];
    let currentGatewayResource: ConnectionManagementResource | undefined;
    if (resource.gatewayId && !options.gatewayContextChecked) {
      const [gateway] = await db.select().from(toolMcpGateways).where(and(eq(toolMcpGateways.id, resource.gatewayId), eq(toolMcpGateways.companyId, resource.companyId)));
      if (!gateway) throw forbidden("Gateway is unavailable in this company");
      // Explicit null is the proposed cleared binding, not an omitted selector.
      resource = { ...resource,
        profileId: Object.hasOwn(resource, "profileId") ? resource.profileId : gateway.profileId,
        projectId: Object.hasOwn(resource, "projectId") ? resource.projectId : gateway.projectId,
        issueId: Object.hasOwn(resource, "issueId") ? resource.issueId : gateway.issueId,
      };
      if (gateway.agentId) expandedTargets.add(gateway.agentId);
      // Authorize both sides of a binding change. The saved side is read afresh
      // on reauthorization, even when the request context holds an older binding.
      if (resource.profileId !== gateway.profileId || resource.projectId !== gateway.projectId || resource.issueId !== gateway.issueId) {
        currentGatewayResource = { ...resource, profileId: gateway.profileId, projectId: gateway.projectId, issueId: gateway.issueId };
      }
    }
    if (resource.profileId && !options.expandedProfile) {
      const [profile] = await db.select().from(toolProfiles).where(and(eq(toolProfiles.id, resource.profileId), eq(toolProfiles.companyId, resource.companyId)));
      if (!profile) throw forbidden("Profile is unavailable in this company");
      // Managed installation profiles can be empty while their labels still
      // identify the connection they administer.
      if (profile.profileKey.startsWith("app:") && isUuidLike(profile.profileKey.slice(4))) referencedConnections.push(profile.profileKey.slice(4));
      const bindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, profile.id));
      for (const binding of bindings) {
        if (binding.targetType === "agent") expandedTargets.add(binding.targetId);
        if (binding.targetType === "company") {
          const companyAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, resource.companyId));
          companyAgents.forEach(agent => expandedTargets.add(agent.id));
        }
        if (["project", "issue", "routine", "gateway"].includes(binding.targetType)) {
          await authorizeBindingTarget(actor, action, resource, binding, options);
        }

      }
      const linkedGateways = await db.select({ id: toolMcpGateways.id }).from(toolMcpGateways).where(and(eq(toolMcpGateways.companyId, resource.companyId), eq(toolMcpGateways.profileId, profile.id)));
      for (const gateway of linkedGateways) await authorizeBindingTarget(actor, action, resource, { targetType: "gateway", targetId: gateway.id }, options);
      const entries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
      for (const entry of entries) if (entry.connectionId) referencedConnections.push(entry.connectionId);
      const applicationIds = new Set(entries.flatMap(entry => entry.selectorType === "application" && entry.applicationId ? [entry.applicationId] : []));
      const catalogIds = new Set(entries.flatMap(entry => entry.catalogEntryId ? [entry.catalogEntryId] : []));
      if (catalogIds.size) {
        const selected = await db.select({ id: toolCatalogEntries.id, connectionId: toolCatalogEntries.connectionId, applicationId: toolCatalogEntries.applicationId }).from(toolCatalogEntries)
          .where(and(eq(toolCatalogEntries.companyId, resource.companyId), inArray(toolCatalogEntries.id, [...catalogIds])));
        if (selected.length !== catalogIds.size) throw forbidden("Profile catalog selection is unavailable in this company");
        for (const entry of selected) {
          referencedConnections.push(entry.connectionId);
          // New-tool review also covers other connections in the selected
          // catalog entry's application, not just its original connection.
          if (entry.applicationId) applicationIds.add(entry.applicationId);
        }
      }
      if (applicationIds.size) {
        const selected = await db.select({ id: toolApplications.id }).from(toolApplications).where(and(eq(toolApplications.companyId, resource.companyId), inArray(toolApplications.id, [...applicationIds])));
        if (selected.length !== applicationIds.size) throw forbidden("Profile application selection is unavailable in this company");
        const connections = await db.select({ id: toolConnections.id }).from(toolConnections).where(and(eq(toolConnections.companyId, resource.companyId), inArray(toolConnections.applicationId, [...applicationIds])));
        connections.forEach(connection => referencedConnections.push(connection.id));
      }
      const toolNames = entries.flatMap(entry => entry.selectorType === "tool_name" && entry.toolName ? [entry.toolName] : []);
      const riskLevels = entries.flatMap(entry => entry.selectorType === "risk_level" && entry.riskLevel ? [entry.riskLevel] : []);
      if (profile.defaultAction === "allow" || toolNames.length || riskLevels.length) {
        const selected = await db.selectDistinct({ connectionId: toolCatalogEntries.connectionId }).from(toolCatalogEntries).where(and(
          eq(toolCatalogEntries.companyId, resource.companyId), eq(toolCatalogEntries.status, "active"),
          profile.defaultAction === "allow" ? undefined : or(toolNames.length ? inArray(toolCatalogEntries.toolName, toolNames) : undefined, riskLevels.length ? inArray(toolCatalogEntries.riskLevel, riskLevels) : undefined),
        ));
        selected.forEach(entry => referencedConnections.push(entry.connectionId));
      }
    }
    if (resource.connectionId) {
      const [connection] = await db.select().from(toolConnections).where(and(eq(toolConnections.id, resource.connectionId), eq(toolConnections.companyId, resource.companyId)));
      if (!connection) throw forbidden("Connection is unavailable in this company");
      resource = { ...resource, selfServiceUserId: connection.createdByUserId,
        purpose: connection.connectionPurpose === "ai" ? "ai" : connection.connectionPurpose === "channel" ? "chat" : "tool",
        provider: typeof connection.config.sourceTemplateKey === "string" ? connection.config.sourceTemplateKey
          : typeof connection.config.provider === "string" ? connection.config.provider
            : typeof (connection.config.ai as Record<string, unknown> | undefined)?.provider === "string" ? String((connection.config.ai as Record<string, unknown>).provider)
              : typeof connection.transportConfig.sourceTemplateKey === "string" ? connection.transportConfig.sourceTemplateKey : null,
      };
      if (options.mutation ?? action !== "connections:read") {
        const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id));
        for (const install of installs) {
          if (install.targetType === "agent") expandedTargets.add(install.targetId);
          if (install.targetType === "company") {
            const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, resource.companyId));
            rows.forEach(agent => expandedTargets.add(agent.id));
          }
        }
        if (resource.requestedInstallCompanyIds) {
          const current = new Set(installs.filter(install => install.targetType === "company").map(install => install.targetId));
          resource = { ...resource, selfServiceAgentInstalls: current.size === resource.requestedInstallCompanyIds.length && resource.requestedInstallCompanyIds.every(id => current.has(id)) };
        }
      }
      if (connection.connectionPurpose === "ai") {
        const [pool] = await db.select().from(aiConnectionPools).where(eq(aiConnectionPools.id, connection.id));
        for (const member of pool?.config.members ?? []) referencedConnections.push(member.binding.connectionId);
      }
      if (responsibleUserId && (connection.credentialPolicy === "per_user" || resource.selfServiceAgentInstalls || resource.operation.includes("/grants/"))) {
        const [ownGrant] = await db.select({ id: connectionGrants.id }).from(connectionGrants).where(and(
          eq(connectionGrants.connectionId, connection.id), eq(connectionGrants.status, "active"),
          eq(connectionGrants.kind, "user"), eq(connectionGrants.subjectUserId, responsibleUserId),
        ));
        if (ownGrant) resource.selfServiceUserId = responsibleUserId;
      }
      if (resource.selfServiceAgentInstalls) {
        const [access] = await db.select({ id: connectionGrants.id }).from(connectionGrants).where(and(
          eq(connectionGrants.connectionId, connection.id), eq(connectionGrants.status, "active"),
          or(eq(connectionGrants.kind, "organization"), and(eq(connectionGrants.kind, "user"), eq(connectionGrants.subjectUserId, responsibleUserId ?? ""))),
        ));
        if (!access && resource.selfServiceUserId !== responsibleUserId) throw forbidden("You need access to this connection before you can install it on an agent");
      }
      if (actor.type === "agent" && connection.credentialPolicy === "per_user" && connection.createdByUserId !== responsibleUserId) {
        const [grant] = await db.select({ id: connectionGrants.id }).from(connectionGrants).where(and(
          eq(connectionGrants.connectionId, connection.id), eq(connectionGrants.status, "active"),
          eq(connectionGrants.kind, "user"), eq(connectionGrants.subjectUserId, responsibleUserId!),
        ));
        if (!grant) throw forbidden("This personal connection is unavailable to the responsible user");
      }
    }
    if (resource.routineId) {
      const [routine] = await db.select().from(routines).where(and(eq(routines.id, resource.routineId), eq(routines.companyId, resource.companyId)));
      if (!routine) throw forbidden("Routine is unavailable in this company");
      resource = { ...resource, projectId: routine.projectId, issueId: routine.parentIssueId };
      if (routine.assigneeAgentId) expandedTargets.add(routine.assigneeAgentId);
      else if (options.mutation ?? action !== "connections:read") {
        const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, resource.companyId));
        rows.forEach(row => expandedTargets.add(row.id));
      }
    }
    if (actor.type === "agent") {
      if (resource.projectId) {
        const [project] = await db.select().from(projects).where(and(eq(projects.id, resource.projectId), eq(projects.companyId, resource.companyId)));
        if (!project || !(await canActorReadProjectPrivacy(db, actor, project))) throw forbidden("Project is unavailable to this delegated principal");
      }
      if (resource.issueId) {
        const [issue] = await db.select().from(issues).where(and(eq(issues.id, resource.issueId), eq(issues.companyId, resource.companyId)));
        if (!issue || !(await canActorReadIssuePrivacy(db, actor, issue))) throw forbidden("Task is unavailable to this delegated principal");
        if (options.mutation ?? action !== "connections:read") {
          if (issue.assigneeAgentId) expandedTargets.add(issue.assigneeAgentId);
          else {
            const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, resource.companyId));
            rows.forEach(row => expandedTargets.add(row.id));
          }
        }
        if (issue.projectId && issue.projectId !== resource.projectId) {
          const [project] = await db.select().from(projects).where(and(eq(projects.id, issue.projectId), eq(projects.companyId, resource.companyId)));
          if (!project || !(await canActorReadProjectPrivacy(db, actor, project))) throw forbidden("Task project is unavailable to this delegated principal");
        }
        resource = { ...resource, projectId: resource.projectId ?? issue.projectId };
        if (issue.workMode === "skill_test" || ((options.mutation ?? action !== "connections:read") && issue.workMode !== "standard")) throw forbidden("Connection changes require a standard task");
      }
    }
    const targets = [...new Set([...expandedTargets, ...(resource.targetAgentId ? [resource.targetAgentId] : [])])];
    let decision: AuthorizationDecision | undefined;
    for (const targetAgentId of targets.length ? targets : [undefined]) {
      const resolved = { ...resource, ...(targetAgentId ? { targetAgentId } : {}) };
      decision = await authorization.decide({ actor, action, resource: resolved, scope: { ...resolved } });
      if (!decision.allowed) throw forbidden(decision.explanation, { reason: decision.reason, code: decision.code, operation: resource.operation });
      if (Object.hasOwn(resource, "requestedProvider") && resource.requestedProvider !== resource.provider) {
        const proposed = { ...resolved, provider: resource.requestedProvider };
        const proposedDecision = await authorization.decide({ actor, action, resource: proposed, scope: { ...proposed } });
        if (!proposedDecision.allowed) throw forbidden(proposedDecision.explanation, { reason: proposedDecision.reason, code: proposedDecision.code, operation: resource.operation });
      }
      if (actor.type === "agent" && actor.runId && (resolved.projectId || resolved.issueId)) {
        const resourceTrust = await authorization.decide({ actor: { ...actor, runId: undefined }, action, resource: resolved, scope: { ...resolved } });
        if (!resourceTrust.allowed) throw forbidden(resourceTrust.explanation);
      }
      if (targetAgentId) {
        const [target] = await db.select({ id: agents.id }).from(agents).where(and(eq(agents.id, targetAgentId), eq(agents.companyId, resource.companyId)));
        if (!target) throw forbidden("Target agent is outside this company");
        // Explicitly enforce both principals even when unrelated authorization is in shadow mode.
        // Existing human routes retain their domain-specific target authority.
        // Delegation additionally checks both the acting agent and its human.
        const principals: AuthorizationActor[] = actor.type === "agent" || resource.selfServiceAgentInstalls ? [actor] : [];
        if (actor.type === "agent") principals.push({ type: "board", userId: responsibleUserId, source: "session", ignoreInstanceAdmin: true });
        for (const principal of principals) {
          const targetDecision = await authorization.decide({ actor: principal, action: "agent_config:update", resource: { type: "agent", companyId: resource.companyId, agentId: targetAgentId }, scope: { targetAgentId } });
          if (!targetDecision.allowed) throw forbidden(targetDecision.explanation);
        }
      }
    }
    if (action === "connections:profiles" && resource.requestedInstallCompanyIds && !resource.selfServiceAgentInstalls) {
      await authorize(actor, "connections:configure", resource, options);
    }
    for (const connectionId of new Set(referencedConnections)) {
      if (connectionId !== resource.connectionId) await authorize(actor, action, { ...resource, connectionId }, { ...options, targetAgentIds: [...expandedTargets], expandedProfile: true, gatewayContextChecked: options.gatewayContextChecked || Boolean(resource.gatewayId) });
    }
    if (currentGatewayResource) {
      await authorize(actor, action, currentGatewayResource, { ...options, targetAgentIds: [...expandedTargets], expandedProfile: false, gatewayContextChecked: true });
    }
    const context: ConnectionManagementContext = {
      actor, responsibleUserId, resource, workContext, decision: decision!,
      audit: { authorization: { action, operation: resource.operation, reason: decision!.reason }, actorType: actor.type === "agent" ? "agent" : "user", actorId: actor.type === "agent" ? actor.agentId! : actor.userId ?? "board",
        agentId: actor.agentId ?? null, runId: actor.runId ?? null, agentApiKeyId: actor.keyId ?? null, responsibleUserIdOverride: responsibleUserId },
      reauthorize: async (continuation) => {
        const current = await authorize(actor, action, resource, { ...options, afterHumanAction: continuation?.afterHumanAction ?? options.afterHumanAction });
        context.workContext = current.workContext;
        const snapshot = connectionReadRuns.get(current);
        if (snapshot) connectionReadRuns.set(context, snapshot);
      },
    };
    if (capturedRun) connectionReadRuns.set(context, capturedRun);
    return context;
  }

  async function authorizeBindingTarget(actor: AuthorizationActor, action: ConnectionManagementAction,
    resource: ConnectionManagementResource, binding: { targetType: string; targetId: string },
    options: NonNullable<Parameters<typeof authorize>[3]> = {}): Promise<ConnectionManagementContext> {
    let resolved = { ...resource };
    const checkOptions = { ...options, expandedProfile: true };
    if (binding.targetType === "project") {
      resolved.projectId = binding.targetId;
      const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, resource.companyId));
      checkOptions.targetAgentIds = [...new Set([...(options.targetAgentIds ?? []), ...rows.map(row => row.id)])];
    }
    else if (binding.targetType === "issue") resolved.issueId = binding.targetId;
    else if (binding.targetType === "routine") resolved.routineId = binding.targetId;
    else if (binding.targetType === "gateway") {
      const [gateway] = await db.select().from(toolMcpGateways).where(and(eq(toolMcpGateways.id, binding.targetId), eq(toolMcpGateways.companyId, resource.companyId)));
      if (!gateway) throw forbidden("Binding gateway is unavailable in this company");
      resolved = { ...resolved, gatewayId: gateway.id, projectId: gateway.projectId, issueId: gateway.issueId };
      checkOptions.gatewayContextChecked = true;
      const targets = new Set(options.targetAgentIds ?? []);
      if (gateway.agentId) targets.add(gateway.agentId);
      else {
        const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, resource.companyId));
        rows.forEach(row => targets.add(row.id));
      }
      checkOptions.targetAgentIds = [...targets];
    } else throw forbidden("Unsupported profile binding target");
    return authorize(actor, action, resolved, checkOptions);
  }

  async function capability(...args: Parameters<typeof authorize>) {
    try {
      const context = await authorize(args[0], args[1], args[2], { ...args[3], capabilityProbe: true });
      return { allowed: true, reason: context.decision.reason, operation: args[2].operation };
    } catch (error) {
      // Database/provider faults are not authorization denials.
      if (!(error instanceof Error && "status" in error && error.status === 403)) throw error;
      return { allowed: false, reason: error.message, operation: args[2].operation };
    }
  }
  return { authorize, authorizeBindingTarget, capability };
}

/** A pending provider login can finish after a successful yielding run. This
 * keeps its original actor, user, task, trust and grant checks; it is never an
 * option accepted from an HTTP caller. Cancelled tasks/runs remain ineligible. */
export function continuingConnectionManagement(context?: ConnectionManagementContext): ConnectionManagementContext | undefined {
  if (!context) return undefined;
  const continuation: ConnectionManagementContext = { ...context, reauthorize: async () => {
    await context.reauthorize({ afterHumanAction: true });
    continuation.workContext = context.workContext;
    continuation.resource = context.resource;
    continuation.decision = context.decision;
    continuation.audit = context.audit;
  } };
  return continuation;
}
