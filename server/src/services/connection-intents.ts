import { logActivity } from "./activity-log.js";
import { aiConnectionService } from "./ai-connections.js";
import { aiConnectionBindingSchema } from "@paperclipai/shared";
import { and, eq, desc, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  toolConnections,
  toolCatalogEntries,
  companyMemberships,
  heartbeatRuns,
  issueThreadInteractions,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  APP_STORE_DEFINITIONS,
  AGGREGATOR_PRIORITY, AGGREGATOR_NAMES, AGGREGATOR_CATALOG_SOURCES,
  findAggregatorService, explicitAggregatorQuery, normalizeConnectionQuery, parseAggregatorRoute, aggregatorProviderQuestion,
  aggregatorContinuationInstruction, isRemoteMcpConnectorId, askUserQuestionsPayloadSchema, askUserQuestionsResultSchema,
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


function availableToolConnectionMethods(
  app: (typeof CONNECTABLE_APP_DEFINITIONS)[number],
) {
  return getAvailableConnectionMethods(app).filter(
    (method) => (method.purpose ?? "tool") === "tool" && method.transport !== "runtime_auth",
  );
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

  async function managedAgent(companyId: string, agentId: string, serviceSlug: string) {
    const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId)));
    const binding = aiConnectionBindingSchema.safeParse(agent?.runtimeConfig?.aiConnection).data;
    return agent && binding?.provider === serviceSlug ? { agent, binding } : null;
  }

  async function usableConnectionForAgent(input: {
    companyId: string;
    agentId: string;
    responsibleUserId: string;
    serviceSlug: string;
    purpose?: "ai";
    inventory?: Awaited<ReturnType<typeof connectionInventory>>;
  }) {
    const managed = input.purpose === "ai" ? await managedAgent(input.companyId, input.agentId, input.serviceSlug) : null;
    if (managed) {
      try {
        const selected = await aiConnectionService(db).select({ companyId: input.companyId, agentId: input.agentId, userId: input.responsibleUserId, adapterType: managed.agent.adapterType, model: managed.agent.adapterConfig.model, runnerProvider: managed.agent.adapterConfig.provider, acpxAgent: managed.agent.adapterConfig.acpxAgent, binding: managed.binding });
        return access.getConnection(selected.connection.id, input.companyId);
      } catch (error) { if ([403, 404, 422].includes((error as { status?: number }).status ?? 0)) return null; throw error; }
    }
    if (input.purpose === "ai") return null;
    const inventory = input.inventory ?? await connectionInventory(input.companyId);
    const matching = inventory.connections.filter((connection) =>
      sourceSlugForConnection(connection, inventory.applicationsById) === input.serviceSlug
      && connection.status !== "archived" && connection.connectionPurpose !== "ai"
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

  async function resolveService(service: string, companyId: string, userId: string, agentId: string, purpose?: "ai") {
    if (!service.startsWith("connection:")) {
      const app = getAppStoreDefinition(service);
      if (!app) throw notFound("Connection service was not found");
      const methods = purpose === "ai" ? getAvailableConnectionMethods(app).filter(method => method.transport === "runtime_auth") : availableToolConnectionMethods(app);
      return { ...app, available: app.availability?.available !== false,
        searchCapabilities: methods.map((method) =>
          `${method.whenToUse} ${method.capabilityProfile?.label ?? ""} ${method.capabilityProfile?.description ?? ""}`).join(" "),
        methods: methods.map((method) => ({
          key: method.key, label: method.label ?? method.key, auth: method.auth,
        })), source: "catalog" as const };
    }
    const id = service.slice("connection:".length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw notFound("Configured connection was not found");
    }
    const connection = await access.getConnection(id, companyId);
    if (connection.connectionPurpose === "ai" && purpose !== "ai") throw notFound("AI authentication is not a tool connection");
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

  async function search(claims: ConnectionRunClaims, query: string, options: { retryProviderChoice?: boolean } = {}): Promise<ConnectionsSearchResult> {
    const { run, agent, issue } = await loadRunContext(claims);
    const normalized = query.trim().toLocaleLowerCase();
    const tokens = normalized.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    const inventory = await connectionInventory(run.companyId);
    const candidates: Array<{ item: ConnectionSearchResultItem; score: number }> = [];
    const services = [...APP_STORE_DEFINITIONS.filter(app => getAvailableConnectionMethods(app).some(method => method.transport !== "runtime_auth")).map((app) => app.slug),
      ...inventory.connections.filter((connection) =>
        sourceSlugForConnection(connection, inventory.applicationsById)?.startsWith("connection:")
        && connection.status !== "archived").map((connection) => `connection:${connection.id}`)];
    for (const service of services) {
      let app;
      try { app = await resolveService(service, run.companyId, run.responsibleUserId!, agent.id); }
      catch (error) { if (service.startsWith("connection:") && (error as { status?: number }).status === 404) continue; throw error; }
      const matching = inventory.connections.filter((connection) =>
        sourceSlugForConnection(connection, inventory.applicationsById) === service && connection.status !== "archived" && connection.connectionPurpose !== "ai");
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
    const explicit = explicitAggregatorQuery(query);
    const serviceQuery = explicit?.serviceQuery ?? query;
    const publicService = findAggregatorService(serviceQuery);
    const exact = candidates.filter(({ item }) => normalizeConnectionQuery(item.service) === normalizeConnectionQuery(query)
      || normalizeConnectionQuery(item.name) === normalizeConnectionQuery(query)
      || item.service === publicService?.slug);
    const targetService = publicService?.slug ?? normalizeConnectionQuery(serviceQuery).replaceAll(" ", "-");
    // Indexed-only app labels must be identical when requests re-search the slug.
    const targetName = publicService?.name ?? targetService.split("-").map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
    const previous = await providerSelections(run.companyId, issue.id, agent.id, run.responsibleUserId!, `connection-provider:${targetService}`);
    const explicitConsent = explicit && await hasExplicitProviderRequest(run.companyId, issue.id, run.responsibleUserId!, targetService, explicit.provider, previous[0]);
    if (exact.length && (!explicitConsent || exact.some(({ item }) => item.state === "unavailable"))) return directSearchResult(query, exact.map(({ item }) => item));
    const alternatives: ConnectionSearchResultItem[] = [];
    if (/^[a-z0-9][a-z0-9-]{0,79}$/.test(targetService)) {
      for (const provider of AGGREGATOR_PRIORITY) {
        // Broad execute/search descriptions are not evidence of app support. Only a
        // namespaced action (or an explicitly listed Executor integration) qualifies.
        const connections = inventory.connections.filter(connection => connection.status !== "archived" && connection.enabled && sourceSlugForConnection(connection, inventory.applicationsById) === provider);
        let indexedAt: Date | undefined;
        for (const connection of connections) {
          const { grants } = await access.listConnectionGrants(connection.id, run.companyId);
          if (!grants.some(grant => grant.status === "active" && (grant.kind === "organization"
            || grant.kind === "user" && grant.subjectUserId === run.responsibleUserId
            || grant.kind === "agent" && grant.subjectAgentId === agent.id))) continue;
          const entries = await indexedCatalog(connection.id, run.companyId);
          const matching = entries.filter(entry => {
            const name = entry.toolName.toLowerCase();
            return name.startsWith(targetService + "_") || name.startsWith(targetService + ".") || name.startsWith(targetService + ":")
              || provider === "executor" && entry.toolName === "execute"
                && (entry.description ?? "").split("\n").some(line => line.trim() === "- `" + targetService + "`");
          });
          for (const entry of matching) if (!indexedAt || entry.lastSeenAt > indexedAt) indexedAt = entry.lastSeenAt;
        }
        const publishedAt = publicService ? (publicService.providers as Partial<Record<string, string>>)[provider] : undefined;
        const published = Boolean(publishedAt);
        if (!published && !indexedAt) continue;
        if (await administrativeDenial(run.companyId, agent.id, provider, inventory)) continue;
        const app = await resolveService(provider, run.companyId, run.responsibleUserId!, agent.id);
        if (!app.available || !app.methods.length) continue;
        const ready = await usableConnectionForAgent({ companyId: run.companyId, agentId: agent.id, responsibleUserId: run.responsibleUserId!, serviceSlug: provider, inventory });
        alternatives.push({
          service: `via:${provider}:${targetService}`, name: `${targetName} through ${app.name}`,
          source: "aggregator", state: "available", description: `Connect ${targetName} through ${app.name}, an external service.`,
          logoUrl: app.branding.logoUrl ?? null, methods: app.methods, connectionId: ready?.id ?? null,
          reason: ready ? `${app.name} is connected; verify ${targetName} authorization and the requested action.`
            : provider === "arcade" ? "Set up an Arcade gateway with this app's tools, then authorize the app."
            : `Connect ${app.name}, then verify and authorize ${targetName}.`,
          aggregator: { provider, targetService, targetName, evidenceUrl: published ? AGGREGATOR_CATALOG_SOURCES[provider] ?? null : null,
            verifiedAt: publishedAt ?? indexedAt!.toISOString(),
            readiness: ready ? "requires_app_verification" : "requires_provider_setup" },
        });
      }
    }
    if (explicit && explicitConsent) {
      const selected = alternatives.find(item => item.aggregator?.provider === explicit.provider);
      if (!selected) return { version: 1, query, results: [], instruction: "The explicitly requested external provider is unavailable or its app support could not be verified. Explain the limitation. Do not switch providers automatically." };
      return { version: 1, query, results: [{ ...selected, service: explicit.provider }],
        instruction: `The user explicitly requested ${AGGREGATOR_NAMES[explicit.provider]}. Disclose that this external service handles the connection and requests to ${targetName}. Do not ask another provider-choice question or substitute another provider. Call connection_request with service ${explicit.provider} and targetService ${targetService}. Follow its returned instruction; app authorization is not yet verified.` };
    }
    if (!alternatives.length) return directSearchResult(query, candidates.filter(({ item, score }) => !isRemoteMcpConnectorId(item.service) && score >= tokens.length)
      .sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name)).slice(0, 20).map(({ item }) => item), true);
    const question = aggregatorProviderQuestion(targetService, targetName, alternatives);
    const latest = previous[0];
    if (latest && (latest.status === "pending" || !options.retryProviderChoice)) {
      if (latest.status === "pending") return { version: 1, query, results: alternatives, instruction: "The provider-choice question is already pending. Finish independent work, then yield. Do not ask again.", selectionInteractionId: latest.id };
      const choice = selectedProvider(latest, question);
      if (choice === "none" || latest.status === "cancelled") return { version: 1, query, results: [], instruction: "The user declined external providers for this service. Do not connect or ask again. Explain that access remains unavailable. Only if the user explicitly asks to reconsider, search again with retryProviderChoice true." };
      const selected = alternatives.find(item => item.service === choice);
      if (selected) return { version: 1, query, results: [selected], selectionInteractionId: latest.id,
        instruction: `The user selected ${selected.name}. Call connection_request with service ${selected.service} and selectionInteractionId ${latest.id}. Follow its returned instruction; underlying app access is not yet verified.` };
      if (choice) return { version: 1, query, results: [], instruction: "The chosen external provider is no longer available for this service. Explain the restriction or missing support. Do not switch providers automatically. The user may explicitly request a new provider choice." };
    }
    // An agent's query is not proof of human choice. Keep its named provider as
    // the sole confirmation option unless a saved user message proves consent.
    const offered = explicit ? alternatives.filter(item => item.aggregator?.provider === explicit.provider) : alternatives;
    if (!offered.length) return { version: 1, query, results: [], instruction: "The requested external provider is unavailable. Do not switch providers automatically." };
    return { version: 1, query, results: offered, providerQuestion: aggregatorProviderQuestion(targetService, targetName, offered),
      instruction: "No matching built-in Paperclip connection was found. Ask the responsible user with providerQuestion exactly as returned (including its id, full prompt, and options). With native request_human_input, use interactionKind questions, continuationPolicy wake_assignee, and payload {version:1, questions:[providerQuestion]}; do not add questionSet. Otherwise use ask_user_questions with the same questions payload. These are external services. Wait for the saved answer; then call connection_request with the selected service identifier and selectionInteractionId set to the answered question interaction ID. None for now means do not connect. Do not claim app access yet." };
  }

  function directSearchResult(query: string, results: ConnectionSearchResultItem[], suggestions = false): ConnectionsSearchResult {
    return { version: 1, query, results, instruction: !results.length
      ? "No verified connection route was found. Explain that support could not be verified; do not invent a provider route or request unsupported services."
      : !suggestions && isRemoteMcpConnectorId(results[0]!.service) && results[0]!.state !== "unavailable"
        ? `${results[0]!.name} is an external service. When the user explicitly names this provider, disclose that it handles the connection and requests to the requested app; no additional provider-choice question is necessary. ${results[0]!.state === "ready" ? aggregatorContinuationInstruction(results[0]!.service, "The requested app") : "Call connection_request with the returned service identifier and follow its instruction. Provider setup does not yet verify underlying app access."}`
      : suggestions ? "These are possible Paperclip matches, not an exact service match. Clarify the service if ambiguous, then search its exact name. Do not treat unrelated matches as support."
      : results[0]!.state === "ready" ? "Use the installed connection. Do not create another connection request."
      : results[0]!.state === "unavailable" ? "This connection is unavailable or administratively restricted. Explain the reason. Do not bypass it using another provider."
      : "Call connection_request with the returned service identifier. The user already asked to connect: do not ask a generic confirmation or imitate the setup card. Follow the returned instruction." };
  }

  async function providerSelections(companyId: string, issueId: string, agentId: string, userId: string, questionId: string) {
    const rows = await db.select().from(issueThreadInteractions).where(and(
      eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId),
      eq(issueThreadInteractions.kind, "ask_user_questions"), eq(issueThreadInteractions.createdByAgentId, agentId),
    )).orderBy(desc(issueThreadInteractions.createdAt));
    return rows.filter(row => (!row.addresseeUserId || row.addresseeUserId === userId)
      && (!row.resolvedByUserId || row.resolvedByUserId === userId)
      && askUserQuestionsPayloadSchema.safeParse(row.payload).success
      && (row.payload as { questions: Array<{ id: string }> }).questions.some(question => question.id === questionId));
  }

  async function hasExplicitProviderRequest(companyId: string, issueId: string, userId: string, target: string, provider: string, latest?: typeof issueThreadInteractions.$inferSelect) {
    if (latest?.status === "pending") return false;
    // Use a persisted human-authored message, never the agent-supplied query or
    // mutable task description. Conservative parsing falls back to confirmation.
    const [message] = await db.select().from(issueComments).where(and(
      eq(issueComments.companyId, companyId), eq(issueComments.issueId, issueId),
      eq(issueComments.authorUserId, userId), isNull(issueComments.authorAgentId),
      isNull(issueComments.createdByRunId), isNull(issueComments.derivedAuthorAgentId), isNull(issueComments.deletedAt),
    )).orderBy(desc(issueComments.createdAt), desc(issueComments.id)).limit(1);
    if (!message || !/^(?:please\s+)?(?:connect|use)\b/i.test(message.body.trim())) return false;
    if (latest && message.createdAt <= (latest.resolvedAt ?? latest.createdAt)) return false;
    const request = explicitAggregatorQuery(message.body);
    if (request?.provider !== provider) return false;
    const known = findAggregatorService(target);
    const requested = normalizeConnectionQuery(request.serviceQuery).replace(/^(?:please )?(?:connect|use) (?:to )?/, "");
    const names = known ? [known.slug, known.name, ...known.aliases] : [target];
    return names.some(name => requested === normalizeConnectionQuery(name));
  }

  function selectedProvider(row: typeof issueThreadInteractions.$inferSelect, expected: ReturnType<typeof aggregatorProviderQuestion>) {
    if (row.status !== "answered" || !row.resolvedByUserId || row.resolvedByAgentId) return null;
    const payload = askUserQuestionsPayloadSchema.safeParse(row.payload);
    const result = askUserQuestionsResultSchema.safeParse(row.result);
    if (!payload.success || !result.success) return null;
    const question = payload.data.questions.find(q => q.id === expected.id);
    const answer = result.data.answers.find(answer => answer.questionId === expected.id);
    if (!question || question.selectionMode !== "single" || !answer || answer.optionIds.length !== 1 || answer.otherText) return null;
    const selected = answer.optionIds[0]!;
    const option = question.options.find(option => option.id === selected);
    // A decline survives copy/catalog revisions; it can never authorize a call.
    if (selected === "none" && option?.label === "None for now") return selected;
    if (question.prompt !== expected.prompt || question.helpText !== expected.helpText) return null;
    const route = parseAggregatorRoute(selected);
    if (!route || expected.id !== `connection-provider:${route.targetService}`) return null;
    const providerName = AGGREGATOR_NAMES[route.provider];
    if (option?.label !== providerName && option?.label !== `${providerName} — Recommended`) return null;
    // Eligibility is checked separately. A changed recommendation order must not
    // erase the human's choice or silently replace it with another provider.
    return selected;
  }

  async function request(
    claims: ConnectionRunClaims,
    serviceSlug: string,
    options: { purpose?: "ai"; selectionInteractionId?: string; targetService?: string } = {},
  ): Promise<ConnectionRequestResult> {
    const context = await loadRunContext(claims);
    const route = parseAggregatorRoute(serviceSlug);
    let upstreamService: { slug: string; name: string; selectionInteractionId?: string } | undefined;
    if (options.targetService) {
      if (route || options.purpose || !isRemoteMcpConnectorId(serviceSlug)) throw unprocessable("An explicit target app requires a direct external-provider request");
      const found = await search(claims, `${options.targetService} through ${serviceSlug}`);
      const selected = found.results.find(item => item.aggregator?.provider === serviceSlug && (item.service === serviceSlug || Boolean(found.selectionInteractionId && !found.providerQuestion)));
      if (!selected?.aggregator) throw forbidden("The requested provider cannot connect this app without verified support and a recorded user choice or explicit user request");
      // Reuse the saved-answer validation below; a pending question also carries
      // an interaction ID, but is never permission to create the setup card.
      if (selected.service !== serviceSlug) return request(claims, selected.service, { selectionInteractionId: found.selectionInteractionId });
      upstreamService = { slug: selected.aggregator.targetService, name: selected.aggregator.targetName };
    }
    if (route) {
      if (options.purpose) throw unprocessable("Aggregator routes are tool connections only");
      const found = await search(claims, route.targetService);
      const selected = found.results.find(item => item.service === serviceSlug);
      if (!selected?.aggregator || !options.selectionInteractionId || found.selectionInteractionId !== options.selectionInteractionId) {
        throw forbidden("Choose an external provider using the returned provider question before requesting this connection");
      }
      const rows = await providerSelections(context.run.companyId, context.issue.id, context.agent.id, context.run.responsibleUserId!, `connection-provider:${route.targetService}`);
      const row = rows.find(row => row.id === options.selectionInteractionId);
      if (!row || row.status !== "answered" || row.resolvedByUserId !== context.run.responsibleUserId || row.resolvedByAgentId
        || found.results.length !== 1 || found.providerQuestion) throw forbidden("The provider choice is not a valid saved user answer");
      upstreamService = { slug: route.targetService, name: selected.aggregator.targetName, selectionInteractionId: options.selectionInteractionId };
      serviceSlug = route.provider;
    }
    const app = await resolveService(serviceSlug, context.run.companyId, context.run.responsibleUserId!, context.agent.id, options.purpose);
    if (!app.available || app.methods.length === 0) {
      throw unprocessable(`Connection service ${serviceSlug} is not available`);
    }
    const ready = await usableConnectionForAgent({
      companyId: context.run.companyId,
      agentId: context.agent.id,
      responsibleUserId: context.run.responsibleUserId!,
      serviceSlug: app.slug,
      purpose: options.purpose,
    });
    if (ready) {
      return {
        version: 1,
        service: app.slug,
        state: "ready",
        connectionId: ready.id,
        interactionId: null,
        instruction: isRemoteMcpConnectorId(app.slug) ? aggregatorContinuationInstruction(app.slug, upstreamService?.name ?? "The requested app") : options.purpose === "ai" ? `${app.name} authentication is available for the next execution.` : `${app.name} is connected. Use its installed tools; a native continuation will refresh tools if needed.`,
      };
    }
    if (options.purpose !== "ai" && await administrativeDenial(context.run.companyId, context.agent.id, app.slug, await connectionInventory(context.run.companyId))) {
      throw forbidden("This agent has no permitted actions for this service. Ask an administrator to review tool permissions; reconnecting will not remove a denial.");
    }
    const outcomeId = context.run.contextSnapshot?.interactionId;
    if (typeof outcomeId === "string") {
      const [outcome] = await db.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.id, outcomeId), eq(issueThreadInteractions.companyId, context.run.companyId), eq(issueThreadInteractions.issueId, context.issue.id)));
      if (outcome?.kind === "connection_intent" && outcome.status === "rejected" && connectionIntentPayloadSchema.parse(outcome.payload).serviceSlug === app.slug && connectionIntentPayloadSchema.parse(outcome.payload).purpose === options.purpose) {
        throw conflict("The user declined this connection. Pursue alternatives; do not request it again in this continuation.");
      }
    }
    const interaction = await interactions.createConnectionIntent(
      context.issue,
      {
        payload: {
          version: 1,
          serviceSlug: app.slug,
          ...(options.purpose ? { purpose: options.purpose } : {}),
          serviceName: upstreamService ? `${upstreamService.name} through ${app.name}` : app.name,
          ...(upstreamService ? { upstreamService } : {}),
          serviceLogoUrl: app.branding.logoUrl ?? null,
          serviceDarkLogoUrl: app.branding.darkLogoUrl ?? null,
          requestingAgentId: context.agent.id,
          requestingAgentName: context.agent.name,
          phase: "requested",
        },
        sourceRunId: context.run.id,
        sourceIdentityContextId: context.run.activeIdentityContextId,
        addresseeUserId: context.run.responsibleUserId!,
        idempotencyKey: `connection-intent:${context.run.id}:${context.run.responsibleUserId}:${app.slug}${upstreamService ? `:${upstreamService.slug}` : ""}${options.purpose ? ":ai" : ""}`,
      },
    );
    if (interaction.status !== "pending") throw conflict("This connection request has already been resolved. Follow its recorded outcome.");
    await logActivity(db, {
      companyId: context.run.companyId, actorType: "agent", actorId: context.agent.id,
      agentId: context.agent.id, runId: context.run.id,
      action: "issue.thread_interaction_created", entityType: "issue", entityId: context.issue.id,
      details: { interactionId: interaction.id, interactionKind: "connection_intent", purpose: options.purpose },
    });
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

  async function setupOptions(interactionId: string, options: { canManageOrganizationGrant?: boolean } = {}): Promise<ConnectionIntentSetupOptions> {
    const loaded = await loadIntent(interactionId);
    const payload = connectionIntentPayloadSchema.parse(loaded.interaction.payload);
    const app = await resolveService(payload.serviceSlug, loaded.issue.companyId, loaded.interaction.addresseeUserId!, payload.requestingAgentId, payload.purpose);
    const managed = payload.purpose === "ai" ? await managedAgent(loaded.issue.companyId, payload.requestingAgentId, app.slug) : null;
    if (payload.purpose === "ai" && !managed) throw conflict("The agent’s AI configuration changed. Start a new execution.");
    const inventory = await connectionInventory(loaded.issue.companyId);
    const usableAiConnection = managed ? await usableConnectionForAgent({
      companyId: loaded.issue.companyId, agentId: payload.requestingAgentId,
      responsibleUserId: loaded.interaction.addresseeUserId!, serviceSlug: app.slug, purpose: "ai",
    }) : null;
    const aiAccounts = managed ? await aiConnectionService(db).list(loaded.issue.companyId, loaded.interaction.addresseeUserId!) : [];
    const selectedAiAccount = managed ? aiAccounts.find((account) =>
      account.provider === managed.binding.provider && (managed.binding.mode === "responsible_user" || account.method === managed.binding.method)
      && (managed.binding.mode === "responsible_user" ? account.isDefault
        : account.id === managed.binding.connectionId && account.grantId === managed.binding.grantId)
    ) : undefined;
    const selectedAiGrant = selectedAiAccount
      ? (await access.listConnectionGrants(selectedAiAccount.id, loaded.issue.companyId)).grants.find(grant => grant.id === selectedAiAccount.grantId)
      : undefined;
    const matchingConnections = inventory.connections.filter((connection) =>
      sourceSlugForConnection(connection, inventory.applicationsById) === app.slug
      && connection.status === "active"
      && connection.enabled
    );
    const existingConnections = (await Promise.all(matchingConnections.map(async (connection) => {
      if (managed) return connection.id === usableAiConnection?.id ? connection : null;
      const { grants } = await access.listConnectionGrants(connection.id, loaded.issue.companyId);
      const eligible = grants.some((grant) =>
        grant.status === "active"
        && (grant.kind === "organization" || grant.subjectUserId === loaded.interaction.addresseeUserId
          || (grant.kind === "agent" && grant.subjectAgentId === payload.requestingAgentId))
      );
      return eligible && connection.connectionPurpose !== "ai" ? connection : null;
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
      aiConnection: managed?.binding,
      aiRepair: selectedAiAccount ? {
        connection: selectedAiAccount,
        canReconnect: selectedAiGrant?.createdByUserId === loaded.interaction.addresseeUserId
          && (selectedAiAccount.ownership === "personal"
            ? selectedAiAccount.ownerUserId === loaded.interaction.addresseeUserId
            : options.canManageOrganizationGrant === true),
      } : undefined,
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

      if (payload.purpose === "ai" && selectedConnection.connectionPurpose !== "ai") throw conflict("Select an AI account for this authentication request");
      if (selectedConnection.connectionPurpose === "ai") {
        if (payload.purpose !== "ai") throw conflict("AI authentication cannot satisfy a tool connection request");
        const managed = await managedAgent(loaded.issue.companyId, payload.requestingAgentId, payload.serviceSlug);
        if (!managed) throw conflict("Configure the agent’s AI connection before using this account");
        const service = aiConnectionService(txDb);
        if (managed.binding.mode === "responsible_user") {
          const selected = await service.select({ companyId: loaded.issue.companyId, agentId: payload.requestingAgentId, userId, adapterType: managed.agent.adapterType, model: managed.agent.adapterConfig.model, runnerProvider: managed.agent.adapterConfig.provider, acpxAgent: managed.agent.adapterConfig.acpxAgent, binding: managed.binding, allowUninstalledPersonal: true });
          if (selected.connection.id !== selectedConnection.id) throw conflict("Choose this account as your personal default in Connections first");
          const installs = await txAccess.listConnectionInstalls(selectedConnection.id, loaded.issue.companyId);
          await txAccess.putConnectionInstalls(selectedConnection.id, { installs: [...installs, { targetType: "agent", targetId: payload.requestingAgentId }] }, { actorType: "user", actorId: userId });
        }
        const selected = await service.select({ companyId: loaded.issue.companyId, agentId: payload.requestingAgentId, userId, adapterType: managed.agent.adapterType, model: managed.agent.adapterConfig.model, runnerProvider: managed.agent.adapterConfig.provider, acpxAgent: managed.agent.adapterConfig.acpxAgent, binding: managed.binding });
        if (selected.connection.id !== selectedConnection.id) throw conflict("This is not the account selected for the agent");
        return txInteractions.resolveConnectionIntent(loaded.issue, interactionId, { version: 1, outcome: "connected", connectionId: selected.connection.id }, { userId });
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
        { version: 1, outcome: "connected", connectionId: selectedConnection.id,
          ...(isRemoteMcpConnectorId(payload.serviceSlug) ? { instruction: aggregatorContinuationInstruction(payload.serviceSlug, payload.upstreamService?.name ?? "The requested app") } : {}),
        },
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
