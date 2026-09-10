import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  toolConnections,
  toolCatalogEntries,
  companyMemberships,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  APP_STORE_DEFINITIONS,
  CONNECTABLE_APP_DEFINITIONS,
  connectionIntentPayloadSchema,
  getAvailableConnectionMethods,
  isToolConnectionAttentionHealth,
  type ConnectionSearchResultItem,
  getAppStoreDefinition,
  type ConnectionIntentInteraction,
  type ConnectionIntentSetupOptions,
  type ConnectionRequestResult,
  type ConnectionsSearchResult,
  type ToolApplication,
  type ToolConnection,
} from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";
import { toolAccessService } from "./tool-access.js";
import { captureRunIdentity } from "./run-identity.js";
import { resolveManagedGitHubIdentitySelection } from "./git-credentials.js";

type ConnectionRunClaims = Pick<RuntimeToolsTokenClaims, "sub" | "company_id" | "run_id" | "responsible_user_id">;

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function text(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function sourceSlugForApplication(application: ToolApplication | undefined) {
  return text(application?.metadata?.sourceTemplateKey) ?? text(application?.metadata?.galleryKey);
}

function sourceSlugForConnection(
  connection: ToolConnection,
  applications: ReadonlyMap<string, ToolApplication>,
) {
  const source = text(connection.config?.sourceTemplateKey)
    ?? text(connection.transportConfig?.sourceTemplateKey)
    ?? sourceSlugForApplication(applications.get(connection.applicationId));
  return source && getAppStoreDefinition(source) ? source : `connection:${connection.id}`;
}


export function connectionIntentService(db: Db) {
  const interactions = issueThreadInteractionService(db);
  const access = toolAccessService(db);

  async function assertCurrentUserWriteAccess(
    companyId: string,
    userId: string,
    bypassCurrentMembershipCheck = false,
  ) {
    if (bypassCurrentMembershipCheck) return;
    const membership = await db
      .select({
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
      ))
      .then((rows) => rows[0] ?? null);
    if (
      !membership
      || membership.status !== "active"
      || !membership.membershipRole
      || membership.membershipRole === "viewer"
    ) {
      throw forbidden("Addressed user is no longer authorized for company write access");
    }
  }

  async function lockCurrentUserWriteAccess(
    tx: DbTransaction,
    companyId: string,
    userId: string,
    bypassCurrentMembershipCheck = false,
  ) {
    if (bypassCurrentMembershipCheck) return;
    const membership = await tx
      .select({
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      })
      .from(companyMemberships)
      .where(and(
        eq(companyMemberships.companyId, companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, userId),
      ))
      .for("update")
      .then((rows) => rows[0] ?? null);
    if (
      !membership
      || membership.status !== "active"
      || !membership.membershipRole
      || membership.membershipRole === "viewer"
    ) {
      throw forbidden("Addressed user is no longer authorized for company write access");
    }
  }

  async function loadRunContext(claims: ConnectionRunClaims) {
    let run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        responsibleUserId: heartbeatRuns.responsibleUserId,
        activeIdentityContextId: heartbeatRuns.activeIdentityContextId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, claims.run_id))
      .then((rows) => rows[0] ?? null);
    if (
      !run
      || run.companyId !== claims.company_id
      || run.agentId !== claims.sub
      || (!run.activeIdentityContextId && run.responsibleUserId !== claims.responsible_user_id)
    ) throw forbidden("Runtime tool token does not match its heartbeat run");
    if (run.status !== "running") throw forbidden("Runtime tool token is no longer active");
    if (run.activeIdentityContextId) {
      const current = await captureRunIdentity(db, { companyId: run.companyId, agentId: run.agentId, runId: run.id });
      run = { ...run, responsibleUserId: current.run.responsibleUserId };
    }
    if (!run.responsibleUserId) throw forbidden("This task needs a responsible user to connect a service");
    const snapshot = record(run.contextSnapshot);
    const issueId = text(snapshot?.issueId) ?? text(snapshot?.taskId);
    if (!issueId) throw unprocessable("Connection requests require a task-bound heartbeat run");
    const [issue, agent, responsibleMembership] = await Promise.all([
      db.select({
        id: issues.id,
        companyId: issues.companyId,
        status: issues.status,
        assigneeAgentId: issues.assigneeAgentId,
      }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId))).then((rows) => rows[0] ?? null),
      db.select({ id: agents.id, companyId: agents.companyId, name: agents.name })
        .from(agents)
        .where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)))
        .then((rows) => rows[0] ?? null),
      db.select({
        status: companyMemberships.status,
        membershipRole: companyMemberships.membershipRole,
      }).from(companyMemberships).where(and(
        eq(companyMemberships.companyId, run.companyId),
        eq(companyMemberships.principalType, "user"),
        eq(companyMemberships.principalId, run.responsibleUserId!),
      )).then((rows) => rows[0] ?? null),
    ]);
    if (!issue || !agent) throw notFound("Runtime task or agent was not found");
    if (
      !responsibleMembership
      || responsibleMembership.status !== "active"
      || !responsibleMembership.membershipRole
      || responsibleMembership.membershipRole === "viewer"
    ) {
      throw forbidden("Responsible user is no longer authorized for company write access");
    }
    if (issue.assigneeAgentId !== agent.id) throw conflict("The requesting agent no longer owns this task");
    if (issue.status === "done" || issue.status === "cancelled") {
      throw conflict("Connection requests cannot be created on a closed task");
    }
    return { run, issue, agent };
  }

  async function connectionInventory(companyId: string) {
    const [applications, connections] = await Promise.all([
      access.listApplications(companyId),
      access.listConnections(companyId),
    ]);
    return {
      applications,
      connections,
      applicationsById: new Map(applications.map((application) => [application.id, application] as const)),
    };
  }

  async function usableConnectionForAgent(input: {
    companyId: string;
    agentId: string;
    responsibleUserId: string;
    serviceSlug: string;
    inventory?: Awaited<ReturnType<typeof connectionInventory>>;
  }) {
    const inventory = input.inventory ?? await connectionInventory(input.companyId);
    const matching = inventory.connections.filter((connection) =>
      sourceSlugForConnection(connection, inventory.applicationsById) === input.serviceSlug
      && connection.status !== "archived"
    );
    if (matching.length === 0) return null;
    const effective = await access.getEffectiveProfilesForAgent(input.companyId, input.agentId);
    const installedIds = new Set(effective.installedConnections.map((connection) => connection.id));
    const permittedIds = new Set(effective.allowedTools.map((tool) => tool.connectionId));
    const usable = (connection: ToolConnection | undefined) => connection
      && installedIds.has(connection.id) && permittedIds.has(connection.id)
      && connection.status === "active" && connection.enabled
      && ["mcp_remote", "local_stdio"].includes(connection.transport)
      && !isToolConnectionAttentionHealth(connection.healthStatus) ? connection : null;
    if (input.serviceSlug === "github") {
      const selection = await resolveManagedGitHubIdentitySelection(db, input.companyId, {
        agentId: input.agentId, responsibleUserId: input.responsibleUserId,
      });
      return usable(matching.find((connection) => connection.id === selection.grant?.connectionId));
    }
    const installed = matching.filter((connection) => installedIds.has(connection.id));
    const grantsByConnection = await Promise.all(installed.map(async (connection) => ({
      connection,
      grants: (await access.listConnectionGrants(connection.id, input.companyId)).grants,
    })));

    // Keep readiness aligned with runtime identity resolution. A dedicated
    // agent identity wins over the responsible person's personal identity,
    // while an inactive or ambiguous higher-priority identity fails closed.
    const dedicated = grantsByConnection.flatMap(({ connection, grants }) => grants
      .filter((grant) => grant.kind === "agent" && grant.subjectAgentId === input.agentId)
      .map((grant) => ({ connection, grant })));
    if (dedicated.length > 0) {
      const active = dedicated.filter(({ grant }) => grant.status === "active");
      return active.length === 1 ? usable(active[0]!.connection) : null;
    }

    const personal = grantsByConnection.flatMap(({ connection, grants }) => grants
      .filter((grant) => grant.kind === "user" && grant.subjectUserId === input.responsibleUserId)
      .map((grant) => ({ connection, grant })));
    if (personal.length > 0) {
      const active = personal.filter(({ grant }) => grant.status === "active");
      return active.length === 1 ? usable(active[0]!.connection) : null;
    }

    const organization = grantsByConnection.flatMap(({ connection, grants }) => grants
      .filter((grant) => grant.kind === "organization")
      .map((grant) => ({ connection, grant })));
    const activeOrganization = organization.filter(({ grant }) => grant.status === "active");
    return activeOrganization.length === 1 ? usable(activeOrganization[0]!.connection) : null;
  }

  async function administrativeDenial(companyId: string, agentId: string, serviceSlug: string, inventory: Awaited<ReturnType<typeof connectionInventory>>) {
    const effective = await access.getEffectiveProfilesForAgent(companyId, agentId);
    const installed = effective.installedConnections.filter((connection) => sourceSlugForConnection(connection, inventory.applicationsById) === serviceSlug);
    if (!installed.length || effective.allowedTools.some((tool) => installed.some((connection) => connection.id === tool.connectionId))) return false;
    for (const connection of installed) {
      if ((await indexedCatalog(connection.id, companyId)).some((tool) => tool.entryKind === "tool")) return true;
    }
    return false;
  }

  function indexedCatalog(connectionId: string, companyId: string) {
    // Discovery must not contact providers or mutate their health/cache state.
    return db.select().from(toolCatalogEntries).where(and(
      eq(toolCatalogEntries.companyId, companyId), eq(toolCatalogEntries.connectionId, connectionId),
      eq(toolCatalogEntries.status, "active"),
    ));
  }

  async function resolveService(service: string, companyId: string, userId: string, agentId: string) {
    if (!service.startsWith("connection:")) {
      const app = getAppStoreDefinition(service);
      if (!app) throw notFound("Connection service was not found");
      return { ...app, available: app.availability?.available !== false,
        searchCapabilities: getAvailableConnectionMethods(app).map((method) =>
          `${method.whenToUse} ${method.capabilityProfile?.label ?? ""} ${method.capabilityProfile?.description ?? ""}`).join(" "),
        methods: getAvailableConnectionMethods(app).map((method) => ({
          key: method.key, label: method.label ?? method.key, auth: method.auth,
        })), source: "catalog" as const };
    }
    const id = service.slice("connection:".length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw notFound("Configured connection was not found");
    }
    const connection = await access.getConnection(id, companyId);
    const { grants } = await access.listConnectionGrants(id, companyId);
    if (connection.status === "archived" || !grants.some((grant) => grant.status === "active" && (
      grant.kind === "organization" || (grant.kind === "user" && grant.subjectUserId === userId)
      || (grant.kind === "agent" && grant.subjectAgentId === agentId)
    ))) throw notFound("Configured connection was not found");
    const application = await access.getApplication(connection.applicationId, companyId);
    return {
      slug: service, name: connection.name, description: application.description, searchCapabilities: "",
      branding: { logoUrl: undefined, darkLogoUrl: undefined },
      available: connection.enabled,
      methods: [{ key: "configured", label: "Use configured connection", auth:
        connection.authKind === "oauth" ? "oauth" as const : connection.authKind === "none" ? "none" as const : "api_key" as const }],
      source: "configured" as const,
    };
  }

  async function search(claims: ConnectionRunClaims, query: string): Promise<ConnectionsSearchResult> {
    const { run, agent } = await loadRunContext(claims);
    const normalized = query.trim().toLocaleLowerCase();
    const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const inventory = await connectionInventory(run.companyId);
    const candidates: Array<{ item: ConnectionSearchResultItem; score: number }> = [];
    const services = [...APP_STORE_DEFINITIONS.map((app) => app.slug),
      ...inventory.connections.filter((connection) =>
        sourceSlugForConnection(connection, inventory.applicationsById)?.startsWith("connection:")
        && connection.status !== "archived").map((connection) => `connection:${connection.id}`)];
    for (const service of services) {
      let app;
      try { app = await resolveService(service, run.companyId, run.responsibleUserId!, agent.id); }
      catch (error) { if (service.startsWith("connection:") && (error as { status?: number }).status === 404) continue; throw error; }
      const matching = inventory.connections.filter((connection) =>
        sourceSlugForConnection(connection, inventory.applicationsById) === service && connection.status !== "archived");
      // Indexed descriptions can contain private workspace metadata, including
      // for catalog providers. Check each configured connection's audience first.
      const catalogs = await Promise.all(matching.map(async (connection) => {
        const { grants } = await access.listConnectionGrants(connection.id, run.companyId);
        const authorized = grants.some((grant) => grant.status === "active" && (
          grant.kind === "organization" || (grant.kind === "user" && grant.subjectUserId === run.responsibleUserId)
          || (grant.kind === "agent" && grant.subjectAgentId === agent.id)
        ));
        return authorized ? indexedCatalog(connection.id, run.companyId) : [];
      }));
      const catalog = catalogs.flat().filter((entry) => entry.status === "active");
      const haystack = `${app.slug} ${app.name} ${app.description ?? ""} ${app.searchCapabilities} ${catalog.map((tool) => `${tool.toolName} ${tool.description ?? ""}`).join(" ")}`.toLocaleLowerCase();
      const score = !normalized ? 1 : app.slug === normalized || app.name.toLocaleLowerCase() === normalized
        ? 1000 : tokens.reduce((sum, token) => sum + (haystack.includes(token) ? 1 : 0), 0);
      if (!score) continue;
      const ready = await usableConnectionForAgent({ companyId: run.companyId, agentId: agent.id,
        responsibleUserId: run.responsibleUserId!, serviceSlug: service, inventory });
      const denied = !ready && matching.length > 0 && await administrativeDenial(run.companyId, agent.id, service, inventory);
      candidates.push({ score, item: {
        service, name: app.name, description: app.description ?? null, logoUrl: app.branding.logoUrl ?? null,
        methods: app.methods, source: app.source,
        state: ready ? "ready" : denied ? "unavailable" : !app.available || !app.methods.length ? "unavailable"
          : matching.length ? "needs_user_action" : "available",
        reason: ready ? "Connection is installed and usable by this agent" : denied ? "An administrator has not permitted executable tools for this agent; reconnecting cannot grant that permission" : !app.available ? "Connection is disabled or unavailable"
          : matching.some((connection) => isToolConnectionAttentionHealth(connection.healthStatus)) ? "Connection needs attention"
          : matching.length ? "Review identity and access for this agent" : "Connect this service to continue",
        connectionId: ready?.id ?? null,
      }});
    }
    return { version: 1, query, results: candidates.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name)).slice(0, 20).map(({ item }) => item) };
  }

  async function request(
    claims: ConnectionRunClaims,
    serviceSlug: string,
  ): Promise<ConnectionRequestResult> {
    const context = await loadRunContext(claims);
    const app = await resolveService(serviceSlug, context.run.companyId, context.run.responsibleUserId!, context.agent.id);
    if (!app.available || app.methods.length === 0) {
      throw unprocessable(`Connection service ${serviceSlug} is not available`);
    }
    const ready = await usableConnectionForAgent({
      companyId: context.run.companyId,
      agentId: context.agent.id,
      responsibleUserId: context.run.responsibleUserId!,
      serviceSlug: app.slug,
    });
    if (ready) {
      return {
        version: 1,
        service: app.slug,
        state: "ready",
        connectionId: ready.id,
        interactionId: null,
        instruction: `${app.name} is connected. Use its installed tools; a native continuation will refresh tools if needed.`,
      };
    }
    if (await administrativeDenial(context.run.companyId, context.agent.id, app.slug, await connectionInventory(context.run.companyId))) {
      throw forbidden("This agent has no permitted actions for this service. Ask an administrator to review tool permissions; reconnecting will not remove a denial.");
    }
    const outcomeId = context.run.contextSnapshot?.interactionId;
    if (typeof outcomeId === "string") {
      const [outcome] = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, outcomeId), eq(issueThreadInteractions.companyId, context.run.companyId), eq(issueThreadInteractions.issueId, context.issue.id)));
      if (outcome?.kind === "connection_intent" && outcome.status === "rejected" && connectionIntentPayloadSchema.parse(outcome.payload).serviceSlug === app.slug) {
        throw conflict("The user declined this connection. Pursue alternatives; do not request it again in this continuation.");
      }
    }
    const interaction = await interactions.createConnectionIntent(
      context.issue,
      {
        payload: {
          version: 1,
          serviceSlug: app.slug,
          serviceName: app.name,
          serviceLogoUrl: app.branding.logoUrl ?? null,
          serviceDarkLogoUrl: app.branding.darkLogoUrl ?? null,
          requestingAgentId: context.agent.id,
          requestingAgentName: context.agent.name,
          phase: "requested",
        },
        sourceRunId: context.run.id,
        sourceIdentityContextId: context.run.activeIdentityContextId,
        addresseeUserId: context.run.responsibleUserId!,
        idempotencyKey: `connection-intent:${context.run.id}:${context.run.responsibleUserId}:${app.slug}`,
      },
    );
    if (interaction.status !== "pending") throw conflict("This connection request has already been resolved. Follow its recorded outcome.");
    return {
      version: 1,
      service: app.slug,
      state: "needs_user_action",
      connectionId: null,
      interactionId: interaction.id,
      instruction: `A connection card was sent to the responsible user. Finish independent work, then yield and wait for continuation. Do not repeat this request.`,
    };
  }

  async function loadIntent(interactionId: string) {
    const row = await db
      .select({ interaction: issueThreadInteractions, issue: issues })
      .from(issueThreadInteractions)
      .innerJoin(issues, eq(issueThreadInteractions.issueId, issues.id))
      .where(eq(issueThreadInteractions.id, interactionId))
      .then((rows) => rows[0] ?? null);
    if (!row || row.interaction.kind !== "connection_intent") throw notFound("Connection intent not found");
    const interaction = await interactions.getForIssue(row.issue, interactionId) as ConnectionIntentInteraction;
    return { ...row, interaction };
  }

  async function setupOptions(interactionId: string): Promise<ConnectionIntentSetupOptions> {
    const loaded = await loadIntent(interactionId);
    const payload = connectionIntentPayloadSchema.parse(loaded.interaction.payload);
    const app = await resolveService(payload.serviceSlug, loaded.issue.companyId, loaded.interaction.addresseeUserId!, payload.requestingAgentId);
    const inventory = await connectionInventory(loaded.issue.companyId);
    const matchingConnections = inventory.connections.filter((connection) =>
      sourceSlugForConnection(connection, inventory.applicationsById) === app.slug
      && connection.status === "active"
      && connection.enabled
    );
    const existingConnections = (await Promise.all(matchingConnections.map(async (connection) => {
      const { grants } = await access.listConnectionGrants(connection.id, loaded.issue.companyId);
      const eligible = grants.some((grant) =>
        grant.status === "active"
        && (grant.kind === "organization" || grant.subjectUserId === loaded.interaction.addresseeUserId
          || (grant.kind === "agent" && grant.subjectAgentId === payload.requestingAgentId))
      );
      return eligible ? connection : null;
    }))).filter((connection): connection is ToolConnection => connection !== null);
    return {
      version: 1,
      interaction: loaded.interaction,
      service: {
        service: app.slug,
        name: app.name,
        description: app.description ?? null,
        logoUrl: app.branding.logoUrl ?? null,
        methods: app.methods,
        source: app.source,
        state: existingConnections.length > 0 ? "needs_user_action" : "available",
        connectionId: null,
      },
      existingConnections: existingConnections.map(({ id, applicationId, name, status, enabled }) => ({
        id, applicationId, name, status, enabled,
      })),
      requestedAgentId: payload.requestingAgentId,
    };
  }

  async function complete(
    interactionId: string,
    connectionId: string,
    userId: string,
    options: {
      canManageOrganizationGrant?: boolean;
      bypassCurrentMembershipCheck?: boolean;
    } = {},
  ) {
    const loaded = await loadIntent(interactionId);
    if (loaded.interaction.status !== "pending") {
      if (loaded.interaction.status === "accepted" && loaded.interaction.result?.connectionId === connectionId && loaded.interaction.addresseeUserId === userId) return loaded.interaction;
      throw conflict("Connection intent is already resolved");
    }
    if (loaded.interaction.addresseeUserId !== userId) throw forbidden("Only the addressed user can connect this service");
    await assertCurrentUserWriteAccess(
      loaded.issue.companyId,
      userId,
      options.bypassCurrentMembershipCheck,
    );
    const payload = connectionIntentPayloadSchema.parse(loaded.interaction.payload);
    return db.transaction(async (tx) => {
      const [task] = await tx.select().from(issues).where(and(eq(issues.id, loaded.issue.id), eq(issues.companyId, loaded.issue.companyId))).for("update");
      if (!task || task.assigneeAgentId !== payload.requestingAgentId || ["done", "cancelled"].includes(task.status)) throw conflict("Connection request no longer belongs to an active task");
      // Membership downgrade/removal takes the same row lock. Whichever side
      // commits first is authoritative: a completed revocation makes this
      // revalidation fail, while completion holds authority through OAuth
      // finalization, every install/delegation, and intent resolution.
      await lockCurrentUserWriteAccess(
        tx,
        loaded.issue.companyId,
        userId,
        options.bypassCurrentMembershipCheck,
      );
      const txDb = tx as unknown as Db;
      const txAccess = toolAccessService(txDb);
      const txInteractions = issueThreadInteractionService(txDb);
      await tx.select({ id: toolConnections.id }).from(toolConnections).where(and(eq(toolConnections.id, connectionId), eq(toolConnections.companyId, loaded.issue.companyId))).for("update");
      let selectedConnection = await txAccess.getConnection(connectionId, loaded.issue.companyId);
      const selectedApplication = await txAccess.getApplication(
        selectedConnection.applicationId,
        loaded.issue.companyId,
      );
      if (sourceSlugForConnection(
        selectedConnection,
        new Map([[selectedApplication.id, selectedApplication]]),
      ) !== payload.serviceSlug) {
        throw notFound("Connection does not match this intent");
      }
      if (selectedConnection.status !== "active" || !selectedConnection.enabled || isToolConnectionAttentionHealth(selectedConnection.healthStatus)) {
        throw conflict("Finish and test this connection before using it for the task");
      }

      let { grants } = await txAccess.listConnectionGrants(
        selectedConnection.id,
        loaded.issue.companyId,
      );
      const pendingPersonalGrant = grants.find((grant) =>
        grant.kind === "user" && grant.status === "active" && grant.subjectUserId === userId
      );
      if (selectedConnection.authKind === "oauth" && pendingPersonalGrant) {
        // txAccess is bound to the outer transaction. Its internal transactions
        // become savepoints, so activation, credential bindings, and the
        // requesting agent's access roll back with any later failure.
        await txAccess.finalizeOAuthAccess(
          loaded.issue.companyId,
          selectedConnection.id,
          { grantKind: "user" },
          { actorType: "user", actorId: userId },
          payload.requestingAgentId,
        );
        selectedConnection = await txAccess.getConnection(
          selectedConnection.id,
          loaded.issue.companyId,
        );
        ({ grants } = await txAccess.listConnectionGrants(
          selectedConnection.id,
          loaded.issue.companyId,
        ));
      }
      const personalGrant = grants.find((grant) =>
        grant.kind === "user" && grant.status === "active" && grant.subjectUserId === userId
      );
      const organizationGrant = grants.find((grant) =>
        grant.kind === "organization" && grant.status === "active"
      );
      const dedicatedGrant = grants.find((grant) => grant.kind === "agent" && grant.status === "active" && grant.subjectAgentId === payload.requestingAgentId);
      if (!personalGrant && !organizationGrant && !dedicatedGrant) {
        throw conflict("This connection has no usable identity grant");
      }
      if (!personalGrant && !dedicatedGrant && !options.canManageOrganizationGrant) {
        throw forbidden("Sharing a company connection requires connection-management authority");
      }

      if (personalGrant) {
        await txAccess.createConnectionGrantDelegation(
          selectedConnection.id,
          personalGrant.id,
          payload.requestingAgentId,
          userId,
        );
      }

      const installs = await txAccess.listConnectionInstalls(
        selectedConnection.id,
        loaded.issue.companyId,
      );
      const requestedInstall = { targetType: "agent" as const, targetId: payload.requestingAgentId };
      const additiveInstalls = installs.some((install) =>
        install.targetType === requestedInstall.targetType && install.targetId === requestedInstall.targetId
      ) ? installs : [...installs, requestedInstall];
      await txAccess.putConnectionInstalls(selectedConnection.id, { installs: additiveInstalls }, {
        actorType: "user",
        actorId: userId,
      });

      const effective = await txAccess.getEffectiveProfilesForAgent(loaded.issue.companyId, payload.requestingAgentId);
      if (!effective.allowedTools.some((tool) => tool.connectionId === selectedConnection.id)) throw conflict("This connection has no permitted tools. Review its action permissions before continuing.");

      const runtimeConnection = await connectionIntentService(txDb).usableConnectionForAgent({
        companyId: loaded.issue.companyId, agentId: payload.requestingAgentId,
        responsibleUserId: userId, serviceSlug: payload.serviceSlug,
      });
      if (runtimeConnection?.id !== selectedConnection.id) throw conflict("This identity is not the connection this agent can execute. Resolve conflicting identities before continuing.");

      return txInteractions.resolveConnectionIntent(
        loaded.issue,
        interactionId,
        { version: 1, outcome: "connected", connectionId: selectedConnection.id },
        { userId },
      );
    });
  }

  async function decline(
    interactionId: string,
    userId: string,
    reason?: string,
    options: { bypassCurrentMembershipCheck?: boolean } = {},
  ) {
    const loaded = await loadIntent(interactionId);
    if (loaded.interaction.addresseeUserId !== userId) throw forbidden("Only the addressed user can decline this request");
    await assertCurrentUserWriteAccess(
      loaded.issue.companyId,
      userId,
      options.bypassCurrentMembershipCheck,
    );
    return interactions.resolveConnectionIntent(
      loaded.issue,
      interactionId,
      { version: 1, outcome: "declined", reason: reason?.trim() || null },
      { userId },
    );
  }

  return {
    validate: loadRunContext,
    usableConnectionForAgent,
    search,
    request,
    loadIntent,
    setupOptions,
    complete,
    decline,
    updatePhase: async (
      interactionId: string,
      phase: "requested" | "authorizing" | "needs_retry",
      userId: string,
      options: { bypassCurrentMembershipCheck?: boolean } = {},
    ) => {
      const loaded = await loadIntent(interactionId);
      if (loaded.interaction.addresseeUserId !== userId) throw forbidden("Only the addressed user can update this request");
      await assertCurrentUserWriteAccess(
        loaded.issue.companyId,
        userId,
        options.bypassCurrentMembershipCheck,
      );
      return interactions.updateConnectionIntentPhase(loaded.issue, interactionId, phase, { userId });
    },
  };
}
