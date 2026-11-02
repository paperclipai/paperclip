import { isUuidLike, type ConnectionRequiredUserAction } from "@paperclipai/shared";
import type { Request, RequestHandler } from "express";
import { and, eq, or, sql } from "drizzle-orm";
import { type Db, toolConnections, toolApplications, toolProfiles, toolProfileEntries, toolProfileBindings,
  toolMcpGateways, toolMcpGatewayTokens, chatEndpoints, chatConversations, connectionGrants, connectionGrantDelegations, agents, issues,
  toolConnectionInstalls, heartbeatRuns, toolPolicies, toolRuntimeSlots, toolCatalogEntries, chatSlackManagerGrants, adapterAuthSessions, companySecrets, companies, companyMemberships } from "@paperclipai/db";
import { badRequest, forbidden, notFound, HttpError } from "../errors.js";
import { assertAuthenticated, assertCompanyAccess, hasCompanyAccess, getActorInfo } from "./authz.js";
import { connectionManagementService, responsibleConnectionUser, type ConnectionManagementContext } from "../services/connection-management.js";
import type { ConnectionManagementAction, ConnectionManagementResource } from "../services/connection-management-policy.js";

const contexts = new WeakMap<Request, ConnectionManagementContext>();
export function connectionRequestContext(req: Request) { return contexts.get(req); }
export function connectionRequestUserId(req: Request) { return responsibleConnectionUser(req.actor); }
export function connectionRequestActor(req: Request) {
  return { ...getActorInfo(req), ...contexts.get(req)?.audit, responsibleUserId: connectionRequestUserId(req), managementContext: contexts.get(req) };
}


export function requiredConnectionUserAction(
  req: Request,
  resource: ConnectionRequiredUserAction["resource"],
  setupPath: string,
  reason: string,
  kind: ConnectionRequiredUserAction["kind"] = "authenticate",
): { requiredUserAction?: ConnectionRequiredUserAction } {
  if (req.actor.type !== "agent") return {};
  const userId = connectionRequestUserId(req);
  if (!userId) throw forbidden("A responsible user is required for authentication");
  return { requiredUserAction: { kind, userId, resource, setupPath, reason,
    continuation: "Inspect this saved setup after the addressed user completes the required step." } };
}

function assertBoundedManagementSelectors(body: Record<string, unknown>) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw badRequest("Resource selectors must be objects");
  const arrays = ["policyIds", "credentialRefs", "credentialSecretRefs", "installs", "bindings", "entries", "agentIds"];
  const identifiers = ["connectionId", "profileId", "gatewayId", "applicationId", "catalogEntryId", "projectId", "issueId", "routineId", "agentId", "targetAgentId", "subjectAgentId", "assignedAgentId", "secretId", "targetId"];
  const pending: Record<string, unknown>[] = [body];
  const unique = new Set<string>();
  let references = 0;
  for (let index = 0; index < pending.length; index++) {
    const selected = pending[index];
    for (const key of identifiers) {
      const value = selected[key];
      if (typeof value === "string") unique.add(`${key}:${value}`);
    }
    const keys = new Set([...arrays, ...identifiers.map(key => `${key}s`)]);
    for (const key of keys) {
      const values = selected[key];
      if (values === undefined || values === null) continue;
      if (!Array.isArray(values)) throw badRequest(`${key} must be an array`);
      references += values.length;
      if (references > 2048) throw badRequest("Connection management requests support at most 2048 resource references");
      for (const value of values) {
        if (typeof value === "string") unique.add(`${key}:${value}`);
        else if (value && typeof value === "object" && !Array.isArray(value)) pending.push(value as Record<string, unknown>);
      }
    }
    for (const key of ["selectors", "access", "binding"]) {
      const value = selected[key];
      if (value && typeof value === "object" && !Array.isArray(value)) pending.push(value as Record<string, unknown>);
    }
    if (selected === body && body.config && typeof body.config === "object" && !Array.isArray(body.config)) {
      const members = (body.config as Record<string, unknown>).members;
      if (members !== undefined) {
        if (!Array.isArray(members)) throw badRequest("Pool members must be an array");
        references += members.length;
        if (references > 2048) throw badRequest("Connection management requests support at most 2048 resource references");
        for (const member of members) if (member && typeof member === "object" && !Array.isArray(member)) pending.push(member as Record<string, unknown>);
      }
    }
    if (unique.size > 1024 || pending.length > 2049) throw badRequest("Connection management requests support at most 1024 unique resource selectors");
  }
}

/** Each REST registration declares its operation; this adapter only resolves resources. */
export function connectionManagementGuard(db: Db, purpose: "tool" | "chat" | "ai") {
  const management = connectionManagementService(db);
  return (action: ConnectionManagementAction, operation: string, options: { personal?: boolean; slackManagerGrant?: boolean } = {}): RequestHandler => async (req, _res, next) => {
    const rawBody = req.body ?? {};
    const authorizeRequest = async (afterHumanAction?: boolean): Promise<ConnectionManagementContext> => {
      const authorize: typeof management.authorize = (actor, requestedAction, resolved, checkOptions) =>
        management.authorize(actor, requestedAction, resolved, { ...checkOptions, afterHumanAction });
      assertAuthenticated(req);
      if (req.actor.type === "agent" && !connectionRequestUserId(req)) throw forbidden("Connection management requires a responsible user");
      const inaccessibleMessage = operation.includes("setup-token-login-sessions") ? "Setup-token login session not found." : "Connection management resource not found";
      if (req.actor.type === "board" && req.params.companyId && !hasCompanyAccess(req, String(req.params.companyId))) {
        if (purpose === "chat" || operation.includes("setup-token-login-sessions")) throw notFound(inaccessibleMessage);
        assertCompanyAccess(req, String(req.params.companyId));
      }
      const body = purpose === "ai" && rawBody.aiConnection ? { ...rawBody, ...rawBody.aiConnection } : rawBody;
      assertBoundedManagementSelectors(body);
      const userId = connectionRequestUserId(req);
      if (req.actor.type === "agent") {
        for (const key of ["responsibleUserId", "onBehalfOfUserId", "createdByUserId", "createdByAgentId"]) {
          if (Object.hasOwn(body, key)) throw forbidden("Management identity is derived from authentication");
        }
        for (const key of ["ownerUserId", "subjectUserId"]) {
          if (body[key] != null && body[key] !== userId) throw forbidden("Personal credentials must belong to the responsible user");
        }
      }
      let applicationProvider: string | null = null;
      let companyId = typeof req.params.companyId === "string" ? req.params.companyId : null;
      const earlyCompanyId = companyId ?? req.actor.companyId;
      if (earlyCompanyId) {
        assertCompanyAccess(req, earlyCompanyId);
        if (req.actor.type === "agent") {
          const memberships = await db.select({ principalType: companyMemberships.principalType, principalId: companyMemberships.principalId }).from(companyMemberships).where(and(
            eq(companyMemberships.companyId, earlyCompanyId), eq(companyMemberships.status, "active"),
            or(and(eq(companyMemberships.principalType, "agent"), eq(companyMemberships.principalId, req.actor.agentId!)),
              and(eq(companyMemberships.principalType, "user"), eq(companyMemberships.principalId, userId!))),
          ));
          if (!memberships.some(member => member.principalType === "agent") || !memberships.some(member => member.principalType === "user")) throw forbidden("Connection management requires active agent and responsible-user memberships");
        }
      }
      const resource: ConnectionManagementResource = { type: "connection_management", companyId: companyId ?? "", purpose, operation,
        readOnly: req.method === "GET" && action !== "connections:gateway" && (action !== "connections:audit" || purpose === "chat") };
      const targets = new Set<string>();
      const extraResources: ConnectionManagementResource[] = [];
      const bindingTargets: { targetType: string; targetId: string }[] = [];
      const selectors: Record<string, unknown>[] = [];
      const policyAudiences: Record<string, unknown>[] = [];
      if (Object.hasOwn(body, "selectors")) policyAudiences.push(body.selectors ?? {});
      const selectorKeys = ["connectionId", "profileId", "gatewayId", "applicationId", "catalogEntryId", "projectId", "issueId", "routineId", "agentId", "targetAgentId", "targetType", "targetId", "agentIds", "connectionIds", "profileIds", "gatewayIds", "applicationIds", "catalogEntryIds", "projectIds", "issueIds", "routineId", "routineIds", "selectorType", "toolName", "riskLevel", "defaultAction"];
      const seenSelectors = new Set<string>();
      const addSelector = (selected: Record<string, unknown>) => {
        assertBoundedManagementSelectors(selected);
        const key = JSON.stringify(selectorKeys.map(name => selected[name]));
        if (seenSelectors.has(key)) return;
        if (selectors.length >= 1024) throw badRequest("Connection management request spans too many resources");
        seenSelectors.add(key); selectors.push(selected);
      };
      const addSelectors = (selected: Record<string, unknown>[]) => selected.forEach(addSelector);
      addSelectors([body, body.access && typeof body.access === "object" ? body.access : {}, body.selectors ?? {}, ...(Array.isArray(body.entries) ? body.entries : [])]);
      const lookupCache = new Map<string, Promise<unknown>>();
      const lookup = <T,>(key: string, read: () => PromiseLike<T>): Promise<T> => {
        let pending = lookupCache.get(key);
        if (!pending) { pending = Promise.resolve(read()); lookupCache.set(key, pending); }
        return pending as Promise<T>;
      };
      const bindCompany = (row: { companyId: string } | undefined) => {
        if (!row || (req.actor.type === "agent" && row.companyId !== req.actor.companyId) || (req.actor.type === "board" && !hasCompanyAccess(req, row.companyId))) throw notFound(inaccessibleMessage);
        if (companyId && companyId !== row.companyId) throw forbidden("Resource is outside this company");
        companyId = row.companyId;
      };
      const uuid = (value: unknown) => { if (typeof value !== "string" || !isUuidLike(value)) throw badRequest("Expected a resource identifier"); return value; };
      const text = (value: unknown) => typeof value === "string" && value ? value : null;
      let connectionId = text(req.params.connectionId) ?? text(req.query.connectionId) ?? text(body.resumeConnectionId) ?? text(body.reconnectConnectionId) ?? text(body.connectionId) ?? text(req.params.poolId) ?? (operation.includes("ai-connection-pools") ? text(body.id) : null);
      let profileId = text(req.params.profileId) ?? text(req.query.profileId) ?? text(body.profileId);
      let gatewayId = text(req.params.gatewayId) ?? text(req.query.gatewayId) ?? text(req.query.gateway);
      for (const id of new Set(Array.isArray(body.policyIds) ? body.policyIds : [])) {
        const [policy] = await db.select().from(toolPolicies).where(eq(toolPolicies.id, uuid(id)));
        if (policy && companyId && policy.companyId !== companyId && req.actor.type === "board") throw new HttpError(422, "Policies must belong to this company");
        bindCompany(policy); addSelector(policy.selectors); policyAudiences.push(policy.selectors);
      }
      if (req.params.policyId) {
        const [policy] = await db.select().from(toolPolicies).where(eq(toolPolicies.id, uuid(req.params.policyId)));
        bindCompany(policy); addSelector(policy.selectors); policyAudiences.push(policy.selectors);
      }
      if (action === "connections:runtime" && (req.params.slotId || req.params.id)) {
        const [slot] = await db.select().from(toolRuntimeSlots).where(eq(toolRuntimeSlots.id, uuid(req.params.slotId ?? req.params.id)));
        bindCompany(slot); connectionId = slot.connectionId; resource.issueId = slot.issueId;
      }
      if (purpose === "ai" && req.params.sessionId && (req.actor.type === "agent" || operation.includes("/local/attempts/"))) {
        const [session] = await db.select().from(adapterAuthSessions).where(or(eq(adapterAuthSessions.publicSessionId, String(req.params.sessionId)), ...(isUuidLike(String(req.params.sessionId)) ? [eq(adapterAuthSessions.id, String(req.params.sessionId))] : [])));
        if (!session || session.startedByUserId !== userId) throw notFound("Sign-in attempt not found");
        bindCompany(session); resource.selfServiceUserId = session.startedByUserId;
      }
      for (const ref of [...(Array.isArray(body.credentialRefs) ? body.credentialRefs : []), ...(Array.isArray(body.credentialSecretRefs) ? body.credentialSecretRefs : [])]) {
        if (!ref.secretId) continue;
        const [secret] = await lookup(`secret:${String(ref.secretId)}`, () => db.select().from(companySecrets).where(eq(companySecrets.id, uuid(ref.secretId))));
        bindCompany(secret);
        if (secret.deletedAt || secret.status !== "active" || (secret.scope === "user" && secret.ownerUserId !== userId)) throw forbidden("Credential binding is unavailable to the responsible user");
      }
      if (options.slackManagerGrant) {
        const [grant] = await db.select().from(chatSlackManagerGrants).where(eq(chatSlackManagerGrants.id, String(req.params.grantId)));
        bindCompany(grant); resource.provider = "slack";
        if (req.actor.type === "agent" && grant.userId !== userId) throw forbidden("Manager consent belongs to another user");
      }
      if (!options.slackManagerGrant && (req.params.grantId || body.grantId)) {
        const [grant] = await db.select().from(connectionGrants).where(eq(connectionGrants.id, uuid(req.params.grantId ?? body.grantId)));
        bindCompany(grant);
        if (connectionId && connectionId !== grant.connectionId) throw forbidden("Grant does not belong to this connection");
        connectionId = grant.connectionId;
        if (grant.subjectAgentId) targets.add(grant.subjectAgentId);
        if (req.actor.type === "agent" && grant.kind === "user" && grant.subjectUserId !== userId) throw forbidden("Personal account belongs to another user");
      }
      if (req.params.delegationId) {
        const [delegation] = await db.select().from(connectionGrantDelegations).where(eq(connectionGrantDelegations.id, uuid(req.params.delegationId)));
        bindCompany(delegation);
        if (delegation.grantId !== req.params.grantId) throw notFound("Connection grant delegation not found");
        targets.add(delegation.agentId);
      }
      if (req.params.issueId) {
        const [issue] = await db.select().from(issues).where(eq(issues.id, uuid(req.params.issueId)));
        bindCompany(issue); resource.issueId = issue.id; resource.projectId = issue.projectId;
      }
      if (req.params.runId) {
        const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, uuid(req.params.runId)));
        bindCompany(run);
        resource.issueId = run.issueId ?? (typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null);
      }
      if (req.params.conversationId) {
        const [conversation] = await db.select().from(chatConversations).where(eq(chatConversations.id, uuid(req.params.conversationId)));
        bindCompany(conversation);
        if (req.params.endpointId && conversation.endpointId !== req.params.endpointId) throw notFound("Conversation not found");
        resource.issueId = conversation.issueId;
      }
      if (body.reassignToProfileId) extraResources.push({ ...resource, profileId: uuid(body.reassignToProfileId) });
      if (req.params.entryId) {
        const [entry] = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.id, uuid(req.params.entryId)));
        bindCompany(entry); profileId = entry.profileId; connectionId ??= entry.connectionId;
        addSelector({ ...entry, ...body });
      }
      if (req.params.tokenId) {
        const [token] = await db.select().from(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.id, uuid(req.params.tokenId)));
        bindCompany(token); gatewayId = token.gatewayId;
      }
      if (gatewayId) {
        const [gateway] = await db.select().from(toolMcpGateways).where(eq(toolMcpGateways.id, uuid(gatewayId)));
        bindCompany(gateway); profileId ??= gateway.profileId;
        resource.gatewayId = gateway.id;
        resource.projectId = Object.hasOwn(body, "projectId") ? text(body.projectId) : gateway.projectId;
        resource.issueId = Object.hasOwn(body, "issueId") ? text(body.issueId) : gateway.issueId;
        if (gateway.agentId) targets.add(gateway.agentId);
      }
      if (req.params.applicationId || body.applicationId) {
        const [application] = await db.select().from(toolApplications).where(eq(toolApplications.id, uuid(req.params.applicationId ?? body.applicationId)));
        bindCompany(application);
        applicationProvider = text(application.metadata.sourceTemplateKey);
        resource.provider ??= applicationProvider;
        if (req.method !== "GET") {
          if (application.ownerAgentId) targets.add(application.ownerAgentId);
          const connections = await db.select({ id: toolConnections.id }).from(toolConnections).where(eq(toolConnections.applicationId, application.id)).limit(1025);
          connections.forEach(connection => extraResources.push({ ...resource, connectionId: connection.id }));
        }
      }
      if (req.params.endpointId) {
        const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, uuid(req.params.endpointId)));
        bindCompany(endpoint); connectionId = endpoint.connectionId; resource.provider = endpoint.provider;
        targets.add(endpoint.assignedAgentId);
      }
      if (connectionId) {
        const [connection] = await db.select().from(toolConnections).where((isUuidLike(connectionId) ? eq(toolConnections.id, connectionId) : eq(toolConnections.uid, connectionId)));
        bindCompany(connection); resource.connectionId = connection.id;
        resource.purpose = connection.connectionPurpose === "ai" ? "ai" : connection.connectionPurpose === "channel" ? "chat" : "tool";
        resource.provider ??= text(connection.config.sourceTemplateKey) ?? text(connection.config.provider) ?? text((connection.config.ai as Record<string, unknown> | undefined)?.provider) ?? text(connection.transportConfig.sourceTemplateKey);
        resource.selfServiceUserId = connection.createdByUserId;
        if (req.method !== "GET") {
          const installs = await db.select().from(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, connection.id));
          addSelectors(installs);
          if (operation === "PUT /tool-connections/:connectionId/installs" && Array.isArray(body.installs)) {
            const keys = (rows: Array<{ targetType: string; targetId: string }>) => new Set(rows.filter(row => row.targetType === "company").map(row => row.targetId));
            const existingCompanies = keys(installs), requestedCompanies = keys(body.installs);
            resource.requestedInstallCompanyIds = [...requestedCompanies];
            resource.selfServiceAgentInstalls = existingCompanies.size === requestedCompanies.size && [...existingCompanies].every(id => requestedCompanies.has(id));
          }
        }
        if (req.actor.type === "agent" && connection.credentialPolicy === "per_user") {
          const grants = await db.select().from(connectionGrants).where(and(eq(connectionGrants.connectionId, connection.id), eq(connectionGrants.kind, "user"), eq(connectionGrants.status, "active")));
          if (!grants.some(grant => grant.subjectUserId === userId) && connection.createdByUserId !== userId) throw forbidden("Another user's personal account is not available for delegated management");
        }
      }
      if (connectionId && operation === "POST /companies/:companyId/tools/apps/:connectionId/finish") {
        const [profile] = await db.select({ id: toolProfiles.id }).from(toolProfiles).where(and(
          eq(toolProfiles.companyId, companyId!), eq(toolProfiles.profileKey, `app:${resource.connectionId}`),
        ));
        profileId = profile?.id ?? profileId;
      }
      if (profileId) {
        const [profile] = await db.select().from(toolProfiles).where(eq(toolProfiles.id, uuid(profileId)));
        bindCompany(profile); resource.profileId = profile.id;
        if (req.method !== "GET") {
          const entries = await db.select().from(toolProfileEntries).where(eq(toolProfileEntries.profileId, profile.id));
          addSelectors(entries);
          const bindings = await db.select().from(toolProfileBindings).where(eq(toolProfileBindings.profileId, profile.id));
          for (const binding of bindings) {
            if (binding.targetType === "agent") targets.add(binding.targetId);
            if (binding.targetType === "company") {
              const companyAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, binding.companyId));
              companyAgents.forEach(agent => targets.add(agent.id));
            }
          }
        }
      }
      companyId ??= text(body.companyId) ?? text(req.query.companyId) ?? req.actor.companyId ?? null;
      if (!companyId) throw forbidden("A company is required for connection management");
      assertCompanyAccess(req, companyId);
      resource.companyId = companyId;
      if (operation === "POST /companies/:companyId/tools/connections" || operation === "POST /companies/:companyId/tools/applications") resource.provider = null;
      else if (operation.includes("/tool-applications/:applicationId")) resource.provider = applicationProvider;
      else resource.provider ??= text(body.provider) ?? text(body.galleryKey) ?? text(req.params.galleryKey);
      if (operation === "PATCH /tool-applications/:applicationId" && Object.hasOwn(body, "metadata")) resource.requestedProvider = text(body.metadata?.sourceTemplateKey);
      if (operation === "PATCH /tool-connections/:connectionId" && (body.config || body.transportConfig)) {
        const proposed = body.config ?? body.transportConfig;
        resource.requestedProvider = text(proposed.sourceTemplateKey) ?? text(proposed.provider) ?? text(proposed.ai?.provider);
      }
      for (const id of [req.params.agentId, req.query.agentId, req.query.agent, body.agentId, body.assignedAgentId, body.subjectAgentId, body.ownerAgentId, body.asAgentId, ...(Array.isArray(body.agentIds) ? body.agentIds : [])]) {
        if (text(id)) targets.add(String(id));
      }
      if (body.targetType === "agent" && text(body.targetId)) targets.add(body.targetId);
      for (const install of Array.isArray(body.installs) ? body.installs : []) {
        if (install.targetType === "agent" && text(install.targetId)) targets.add(install.targetId);
      }
      if ((operation.includes("ai-connection-pools") && req.method === "POST") || body.allAgents || body.access === "all_agents" || body.targetType === "company" || body.installs?.some?.((install: { targetType: string }) => install.targetType === "company")) {
        const companyAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId));
        companyAgents.forEach(agent => targets.add(agent.id));
      }
      resource.projectId ??= text(body.projectId) ?? text(body.executionDefaults?.projectId);
      resource.issueId ??= text(body.issueId);
      if (body.approvalIssueId) extraResources.push({ ...resource, issueId: uuid(body.approvalIssueId) });
      for (const member of Array.isArray(body.config?.members) ? body.config.members : []) addSelector(member.binding ?? {});
      for (const binding of Array.isArray(body.bindings) ? body.bindings : []) addSelector(binding);
      if (req.method !== "GET" && (operation.includes("/tools/policies") || operation.includes("/trust-rules/")) &&
          (policyAudiences.length ? policyAudiences : [{}]).some(selected => !selected.agentId && !(Array.isArray(selected.agentIds) && selected.agentIds.length))) {
        const companyAgents = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId));
        companyAgents.forEach(agent => targets.add(agent.id));
      }
      for (let index = 0; index < selectors.length; index++) {
        const selected = selectors[index];
        const profileOperation = operation.includes("profile");
        if (profileOperation && (selected.defaultAction === "allow" || selected.selectorType === "tool_name" && text(selected.toolName) || selected.selectorType === "risk_level" && text(selected.riskLevel))) {
          const connections = await lookup(`profile-catalog:${JSON.stringify([selected.defaultAction, selected.selectorType, selected.toolName, selected.riskLevel])}`, () => db.selectDistinct({ connectionId: toolCatalogEntries.connectionId }).from(toolCatalogEntries).where(and(
            eq(toolCatalogEntries.companyId, resource.companyId), eq(toolCatalogEntries.status, "active"),
            selected.defaultAction === "allow" ? undefined : selected.selectorType === "tool_name" ? eq(toolCatalogEntries.toolName, String(selected.toolName)) : sql`${toolCatalogEntries.riskLevel} = ${String(selected.riskLevel)}`,
          )).limit(1025));
          connections.forEach(connection => addSelector(connection));
        }
        // Expand each advertised plural selector. A permission over one member
        // cannot authorize a policy that also changes another member's access.
        for (const key of ["connectionId", "profileId", "gatewayId", "applicationId", "catalogEntryId", "projectId", "issueId", "routineId"] as const) {
          for (const id of Array.isArray(selected[`${key}s`]) ? selected[`${key}s`] as unknown[] : []) addSelector({ [key]: uuid(id) });
        }
        if (selected.applicationId) {
          const [application] = await lookup(`application:${String(selected.applicationId)}`, () => db.select().from(toolApplications).where(eq(toolApplications.id, uuid(selected.applicationId))));
          bindCompany(application);
          const connections = await lookup(`application-connections:${application.id}`, () => db.select({ id: toolConnections.id }).from(toolConnections).where(eq(toolConnections.applicationId, application.id)).limit(1025));
          connections.forEach(connection => addSelector({ connectionId: connection.id }));
        }
        if (text(selected.profileId) && selected.profileId !== profileId) extraResources.push({ ...resource, profileId: uuid(selected.profileId) });
        if (text(selected.gatewayId) && selected.gatewayId !== gatewayId) extraResources.push({ ...resource, gatewayId: uuid(selected.gatewayId) });
        if (text(selected.issueId)) extraResources.push({ ...resource, issueId: uuid(selected.issueId) });
        for (const id of [selected.agentId, selected.targetAgentId, ...(Array.isArray(selected.agentIds) ? selected.agentIds : [])]) {
          if (text(id)) targets.add(String(id));
        }
        if (selected.targetType === "agent" && text(selected.targetId)) targets.add(String(selected.targetId));
        if (selected.targetType === "company") {
          if (text(selected.targetId) && selected.targetId !== companyId) throw forbidden("Target company does not match");
          const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.companyId, companyId));
          rows.forEach(row => targets.add(row.id));
        }
        let selectedConnectionId = text(selected.connectionId);
        if (selected.catalogEntryId) {
          const [entry] = await lookup(`catalog:${String(selected.catalogEntryId)}`, () => db.select().from(toolCatalogEntries).where(eq(toolCatalogEntries.id, uuid(selected.catalogEntryId))));
          bindCompany(entry); selectedConnectionId = entry.connectionId;
          if (profileOperation && entry.applicationId) addSelector({ applicationId: entry.applicationId });
        }
        if (selectedConnectionId && selectedConnectionId !== connectionId) {
          const [connection] = await lookup(`connection:${selectedConnectionId}`, () => db.select({ id: toolConnections.id, companyId: toolConnections.companyId, createdByUserId: toolConnections.createdByUserId,
            sourceTemplateKey: sql<string | null>`${toolConnections.config}->>'sourceTemplateKey'`, provider: sql<string | null>`${toolConnections.config}->>'provider'`,
          }).from(toolConnections).where(eq(toolConnections.id, selectedConnectionId)));
          bindCompany(connection);
          extraResources.push({ ...resource, connectionId: connection.id,
            provider: text(connection.sourceTemplateKey) ?? text(connection.provider),
            selfServiceUserId: connection.createdByUserId,
          });
        }
        if (["project", "issue", "routine", "gateway"].includes(String(selected.targetType)) && text(selected.targetId)) bindingTargets.push({ targetType: String(selected.targetType), targetId: uuid(selected.targetId) });
        if (text(selected.routineId)) extraResources.push({ ...resource, routineId: uuid(selected.routineId) });
        if (selected.targetType === "project" && text(selected.targetId)) extraResources.push({ ...resource, projectId: String(selected.targetId) });
        if (text(selected.projectId)) extraResources.push({ ...resource, projectId: String(selected.projectId) });
      }
      if (!connectionId && options.personal && (body.ownership === "personal" || body.grantKind === "user" || req.method === "GET")) resource.selfServiceUserId = userId;
      for (const targetId of targets) uuid(targetId);
      const context = await authorize(req.actor, action, resource, { targetAgentIds: [...targets], mutation: req.method !== "GET" });
      if (action === "connections:profiles" && resource.connectionId && req.method !== "GET" && (req.actor.type === "agent" || !resource.selfServiceAgentInstalls)) {
        await authorize(req.actor, "connections:configure", resource, { targetAgentIds: [...targets] });
      }
      // Clearing a binding or audience still changes access. Check field
      // presence so null, false and empty arrays cannot bypass profile authority.
      const changesGatewayBindings = action === "connections:gateway" &&
        ["profileId", "agentId", "projectId", "issueId"].some(key => Object.hasOwn(body, key));
      if (changesGatewayBindings) {
        await authorize(req.actor, "connections:profiles", resource, { targetAgentIds: [...targets], mutation: req.method !== "GET" });
      }
      const changesAudience = req.actor.type === "agent" && req.method !== "GET" && action === "connections:configure" && (
        ["allAgents", "agentIds", "assignedAgentId", "installs", "bindings", "ownership", "grantKind", "credentialPolicy", "access"].some(key => Object.hasOwn(body, key)) ||
        operation.includes("ai-connection-pools"));
      if (changesAudience) await authorize(req.actor, "connections:profiles", resource, { targetAgentIds: [...targets] });
      const uniqueResources = new Map(extraResources.map(referenced => [JSON.stringify([
        referenced.connectionId, referenced.profileId, referenced.gatewayId, referenced.projectId, referenced.issueId, referenced.routineId, referenced.provider, referenced.purpose,
      ]), referenced]));
      if (uniqueResources.size > 1024) throw badRequest("Connection management request spans too many resources");
      const authorizeReferenced = async (afterHumanAction?: boolean) => {
        for (const referenced of uniqueResources.values()) {
          const resolved = { ...referenced, companyId: resource.companyId };
          const checkOptions = { targetAgentIds: [...targets], mutation: req.method !== "GET", afterHumanAction };
          await authorize(req.actor, action, resolved, checkOptions);
          if (changesGatewayBindings || changesAudience) await authorize(req.actor, "connections:profiles", resolved, checkOptions);
          if (action === "connections:profiles" && resolved.connectionId && req.method !== "GET" && (req.actor.type === "agent" || !resolved.selfServiceAgentInstalls)) {
            await authorize(req.actor, "connections:configure", resolved, checkOptions);
          }
        }
      };
      for (const binding of bindingTargets) await management.authorizeBindingTarget(req.actor, action, resource, binding, { targetAgentIds: [...targets], mutation: req.method !== "GET", afterHumanAction });
      await authorizeReferenced();
      context.reauthorize = async (continuation) => {
        const current = await authorizeRequest(continuation?.afterHumanAction);
        context.workContext = current.workContext;
        context.resource = current.resource;
        context.decision = current.decision;
        context.audit = current.audit;
        contexts.set(req, current);
      };
      return context;
    };
    try {
      contexts.set(req, await authorizeRequest());
      next();
    } catch (error) { next(error); }
  };
}

export async function aiLoginUserAction(db: Db, req: Request, companyId: string, sessionId: string) {
  if (req.actor.type !== "agent") return {};
  const [company] = await db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, companyId));
  if (!company) throw notFound("Company not found");
  return requiredConnectionUserAction(req, { type: "ai_login", id: sessionId, companyId },
    `/${encodeURIComponent(company.prefix)}/apps/connect?aiLogin=${encodeURIComponent(sessionId)}`,
    "Complete the provider sign-in for this saved AI account.");
}

/** Collection projections use the same resolved-resource policy as individual reads. */
export async function filterConnectionManagementRows<T>(db: Db, req: Request, action: ConnectionManagementAction,
  rows: T[], resource: (row: T) => Partial<ConnectionManagementResource>): Promise<T[]> {
  if (req.actor.type !== "agent") return rows;
  const context = connectionRequestContext(req);
  if (!context) throw forbidden("Connection management authority is required");
  const visible: T[] = [];
  for (const row of rows) {
    const decision = await connectionManagementService(db).capability(req.actor, action, { ...context.resource, ...resource(row) }, { mutation: false, readContext: context });
    if (decision.allowed) visible.push(row);
  }
  return visible;
}

/** Policies may name several private resources; omit the entire rule if any is hidden. */
export async function filterConnectionManagementPolicies<T extends { selectors: Record<string, unknown> }>(db: Db, req: Request, rows: T[]): Promise<T[]> {
  if (req.actor.type !== "agent") return rows;
  const context = connectionRequestContext(req);
  if (!context) throw forbidden("Connection management authority is required");
  const visible: T[] = [];
  for (const row of rows) {
    const resources: Partial<ConnectionManagementResource>[] = [{}];
    const ids = (key: string) => [row.selectors[key], ...(Array.isArray(row.selectors[`${key}s`]) ? row.selectors[`${key}s`] as unknown[] : [])].filter((id): id is string => typeof id === "string");
    for (const key of ["connectionId", "profileId", "gatewayId", "projectId", "issueId", "routineId"] as const) for (const id of ids(key)) resources.push({ [key]: id });
    for (const id of ids("agentId")) resources.push({ targetAgentId: id });
    for (const applicationId of ids("applicationId")) {
      const connections = await db.select({ connectionId: toolConnections.id }).from(toolConnections).where(and(eq(toolConnections.applicationId, applicationId), eq(toolConnections.companyId, context.resource.companyId)));
      resources.push(...connections);
    }
    for (const id of ids("catalogEntryId")) {
      const [entry] = await db.select({ connectionId: toolCatalogEntries.connectionId }).from(toolCatalogEntries).where(and(eq(toolCatalogEntries.id, id), eq(toolCatalogEntries.companyId, context.resource.companyId)));
      if (entry) resources.push(entry);
    }
    let allowed = true;
    for (const resource of resources) {
      if (!(await connectionManagementService(db).capability(req.actor, "connections:profiles", { ...context.resource, ...resource }, { mutation: false, readContext: context })).allowed) { allowed = false; break; }
    }
    if (allowed) visible.push(row);
  }
  return visible;
}
