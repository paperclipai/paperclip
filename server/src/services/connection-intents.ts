import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
} from "@paperclipai/db";
import {
  CONNECTABLE_APP_DEFINITIONS,
  connectionIntentPayloadSchema,
  getAvailableConnectionMethods,
  getConnectableAppDefinition,
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
  return text(connection.config?.sourceTemplateKey)
    ?? text(connection.transportConfig?.sourceTemplateKey)
    ?? sourceSlugForApplication(applications.get(connection.applicationId));
}

function displayDescription(app: (typeof CONNECTABLE_APP_DEFINITIONS)[number]) {
  return text(app.description) ?? null;
}

export function connectionIntentService(db: Db) {
  const interactions = issueThreadInteractionService(db);
  const access = toolAccessService(db);

  async function loadRunContext(claims: RuntimeToolsTokenClaims) {
    const run = await db
      .select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        responsibleUserId: heartbeatRuns.responsibleUserId,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, claims.run_id))
      .then((rows) => rows[0] ?? null);
    if (
      !run
      || run.companyId !== claims.company_id
      || run.agentId !== claims.sub
      || run.responsibleUserId !== claims.responsible_user_id
    ) throw forbidden("Runtime tool token does not match its heartbeat run");
    if (run.status !== "running") throw forbidden("Runtime tool token is no longer active");
    const snapshot = record(run.contextSnapshot);
    const issueId = text(snapshot?.issueId) ?? text(snapshot?.taskId);
    if (!issueId) throw unprocessable("Connection requests require a task-bound heartbeat run");
    const [issue, agent] = await Promise.all([
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
    ]);
    if (!issue || !agent) throw notFound("Runtime task or agent was not found");
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
      && connection.status === "active"
      && connection.enabled
    );
    if (matching.length === 0) return null;
    const effective = await access.getEffectiveProfilesForAgent(input.companyId, input.agentId);
    const installedIds = new Set(effective.installedConnections.map((connection) => connection.id));
    for (const connection of matching) {
      if (!installedIds.has(connection.id)) continue;
      const { grants } = await access.listConnectionGrants(connection.id, input.companyId);
      const usable = grants.some((grant) => {
        if (grant.status !== "active") return false;
        if (grant.kind === "organization") return true;
        return grant.subjectUserId === input.responsibleUserId
          && grant.delegations.some((delegation) => delegation.agentId === input.agentId);
      });
      if (usable) return connection;
    }
    return null;
  }

  async function search(claims: RuntimeToolsTokenClaims, query: string): Promise<ConnectionsSearchResult> {
    const { run, agent } = await loadRunContext(claims);
    const normalized = query.trim().toLocaleLowerCase();
    const inventory = await connectionInventory(run.companyId);
    const results = await Promise.all(CONNECTABLE_APP_DEFINITIONS
      .filter((app) => !normalized
        || app.slug.toLocaleLowerCase().includes(normalized)
        || app.name.toLocaleLowerCase().includes(normalized)
        || displayDescription(app)?.toLocaleLowerCase().includes(normalized))
      .map(async (app) => {
        const methods = getAvailableConnectionMethods(app);
        const matching = inventory.connections.filter((connection) =>
          sourceSlugForConnection(connection, inventory.applicationsById) === app.slug
          && connection.status !== "archived"
        );
        const ready = await usableConnectionForAgent({
          companyId: run.companyId,
          agentId: agent.id,
          responsibleUserId: run.responsibleUserId!,
          serviceSlug: app.slug,
          inventory,
        });
        return {
          service: app.slug,
          name: app.name,
          description: displayDescription(app),
          logoUrl: app.branding.logoUrl ?? null,
          methods: methods.map((method) => ({
            key: method.key,
            label: method.label ?? method.key,
            auth: method.auth,
          })),
          state: app.availability?.available === false || methods.length === 0
            ? "unavailable" as const
            : ready
              ? "ready" as const
              : matching.length > 0
                ? "needs_user_action" as const
                : "available" as const,
          connectionId: ready?.id ?? null,
        };
      }));
    return { version: 1, query, results };
  }

  async function request(
    claims: RuntimeToolsTokenClaims,
    serviceSlug: string,
  ): Promise<ConnectionRequestResult> {
    const context = await loadRunContext(claims);
    const app = getConnectableAppDefinition(serviceSlug);
    if (!app || app.availability?.available === false || getAvailableConnectionMethods(app).length === 0) {
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
        instruction: `${app.name} is connected and available in this run.`,
      };
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
        addresseeUserId: context.run.responsibleUserId!,
        idempotencyKey: `connection-intent:${context.run.id}:${app.slug}`,
      },
    );
    return {
      version: 1,
      service: app.slug,
      state: "needs_user_action",
      connectionId: null,
      interactionId: interaction.id,
      instruction: `A connection card was sent to the responsible user. End this run and wait for continuation.`,
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
    const app = getConnectableAppDefinition(payload.serviceSlug);
    if (!app) throw notFound("Connection service is no longer available");
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
        && (grant.kind === "organization" || grant.subjectUserId === loaded.interaction.addresseeUserId)
      );
      return eligible ? connection : null;
    }))).filter((connection): connection is ToolConnection => connection !== null);
    return {
      version: 1,
      interaction: loaded.interaction,
      service: {
        service: app.slug,
        name: app.name,
        description: displayDescription(app),
        logoUrl: app.branding.logoUrl ?? null,
        methods: getAvailableConnectionMethods(app).map((method) => ({
          key: method.key,
          label: method.label ?? method.key,
          auth: method.auth,
        })),
        state: existingConnections.length > 0 ? "needs_user_action" : "available",
        connectionId: null,
      },
      existingConnections,
      requestedAgentId: payload.requestingAgentId,
    };
  }

  async function complete(
    interactionId: string,
    connectionId: string,
    userId: string,
    options: { canManageOrganizationGrant?: boolean } = {},
  ) {
    const loaded = await loadIntent(interactionId);
    if (loaded.interaction.status !== "pending") throw conflict("Connection intent is already resolved");
    if (loaded.interaction.addresseeUserId !== userId) throw forbidden("Only the addressed user can connect this service");
    const payload = connectionIntentPayloadSchema.parse(loaded.interaction.payload);
    let inventory = await connectionInventory(loaded.issue.companyId);
    let connection = inventory.connections.find((candidate) => candidate.id === connectionId);
    if (!connection || sourceSlugForConnection(connection, inventory.applicationsById) !== payload.serviceSlug) {
      throw notFound("Connection does not match this intent");
    }
    if (connection.status !== "active" || !connection.enabled) {
      throw conflict("Finish and test this connection before using it for the task");
    }

    let { grants } = await access.listConnectionGrants(connection.id, loaded.issue.companyId);
    const pendingPersonalGrant = grants.find((grant) =>
      grant.kind === "user" && grant.status === "active" && grant.subjectUserId === userId
    );
    if (connection.authKind === "oauth" && pendingPersonalGrant) {
      await access.finalizeOAuthAccess(
        loaded.issue.companyId,
        connection.id,
        { grantKind: "user" },
        { actorType: "user", actorId: userId },
      );
      inventory = await connectionInventory(loaded.issue.companyId);
      connection = inventory.connections.find((candidate) => candidate.id === connectionId);
      if (!connection) throw notFound("Connection disappeared while finishing authorization");
      ({ grants } = await access.listConnectionGrants(connection.id, loaded.issue.companyId));
    }
    const personalGrant = grants.find((grant) =>
      grant.kind === "user" && grant.status === "active" && grant.subjectUserId === userId
    );
    const organizationGrant = grants.find((grant) => grant.kind === "organization" && grant.status === "active");
    if (personalGrant) {
      await access.createConnectionGrantDelegation(connection.id, personalGrant.id, payload.requestingAgentId, userId);
    } else if (!organizationGrant) {
      throw conflict("This connection has no usable identity grant");
    } else if (!options.canManageOrganizationGrant) {
      throw forbidden("Sharing a company connection requires connection-management authority");
    }

    const installs = await access.listConnectionInstalls(connection.id, loaded.issue.companyId);
    const requestedInstall = { targetType: "agent" as const, targetId: payload.requestingAgentId };
    const additiveInstalls = installs.some((install) =>
      install.targetType === requestedInstall.targetType && install.targetId === requestedInstall.targetId
    ) ? installs : [...installs, requestedInstall];
    await access.putConnectionInstalls(connection.id, { installs: additiveInstalls }, {
      actorType: "user",
      actorId: userId,
    });

    return interactions.resolveConnectionIntent(
      loaded.issue,
      interactionId,
      { version: 1, outcome: "connected", connectionId: connection.id },
      { userId },
    );
  }

  async function decline(interactionId: string, userId: string, reason?: string) {
    const loaded = await loadIntent(interactionId);
    if (loaded.interaction.addresseeUserId !== userId) throw forbidden("Only the addressed user can decline this request");
    return interactions.resolveConnectionIntent(
      loaded.issue,
      interactionId,
      { version: 1, outcome: "declined", reason: reason?.trim() || null },
      { userId },
    );
  }

  return {
    validate: loadRunContext,
    search,
    request,
    loadIntent,
    setupOptions,
    complete,
    decline,
    updatePhase: async (interactionId: string, phase: "requested" | "authorizing" | "needs_retry", userId: string) => {
      const loaded = await loadIntent(interactionId);
      if (loaded.interaction.addresseeUserId !== userId) throw forbidden("Only the addressed user can update this request");
      return interactions.updateConnectionIntentPhase(loaded.issue, interactionId, phase, { userId });
    },
  };
}
