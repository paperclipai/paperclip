import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issues,
  principalPermissionGrants,
  projects,
  toolApplications,
  toolCatalogEntries,
  toolConnections,
  toolPolicies,
  toolProfileBindings,
  toolProfileEntries,
  toolProfiles,
  toolMcpGatewayTokens,
} from "@paperclipai/db";
import { eq } from "drizzle-orm";
import type { ToolAccessDecisionInput } from "@paperclipai/shared";
import {
  createToolAccessDecisionCache,
  toolAccessPolicyService,
} from "../services/tool-access-policy.js";
import { createToolGatewayService } from "../services/tool-gateway.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

import { createListingFixture, recordingDb } from "./helpers/tool-gateway-listing-fixture.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

type Db = ReturnType<typeof createDb>;

describeEmbeddedPostgres("tool gateway listing memory", () => {
  let db!: Db;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-tool-gateway-listing-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function measureNamedGatewayListing(fixture: Awaited<ReturnType<typeof createListingFixture>>) {
    const listing = {
      gatewayId: fixture.namedGateway.id,
      bearerToken: fixture.token.token,
    };
    // Warm module-level state so that both measurements take the same path.
    await createToolGatewayService(db).listToolsForNamedGateway(listing);
    const recorder = recordingDb(db);
    const { tools } = await createToolGatewayService(recorder.db).listToolsForNamedGateway(listing);
    return { tools, statements: recorder.statements, statementParams: recorder.statementParams };
  }

  it("does not load task text when authenticating a named gateway listing", async () => {
    const fixture = await createListingFixture(db, 3);
    const { statements } = await measureNamedGatewayListing(fixture);
    const runReads = statements.filter((query) => query.includes('from "heartbeat_runs"'));
    expect(runReads.length).toBeGreaterThan(0);
    expect(runReads.filter((query) => /"context_snapshot"\s*(?:,|from\b)/.test(query))).toEqual([]);
  });

  it("stops an abandoned listing before catalog reads", async () => {
    const fixture = await createListingFixture(db, 3);
    const recorder = recordingDb(db);
    const controller = new AbortController();
    controller.abort();
    await expect(createToolGatewayService(recorder.db).listToolsForNamedGateway({
      gatewayId: fixture.namedGateway.id, bearerToken: fixture.token.token,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(recorder.statements.some((query) => query.includes('from "tool_catalog_entries"'))).toBe(false);
  });

  it("records a fixed-size discovery summary instead of all tool names", async () => {
    const fixture = await createListingFixture(db, 50);
    const { tools } = await measureNamedGatewayListing(fixture);
    const events = await db.select().from(activityLog).where(eq(activityLog.runId, fixture.run.id));
    const event = events.find((row) => row.action === "tool_gateway.discovery");
    expect(event?.details).toMatchObject({
      visibleToolCount: tools.length, visibleToolsHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(event?.details).not.toHaveProperty("visibleTools");
  });

  it("keeps query growth bounded with several connections", async () => {
    const small = await createListingFixture(db, 50, { connectionCount: 4 });
    const large = await createListingFixture(db, 500, { connectionCount: 4 });
    const smallListing = await measureNamedGatewayListing(small);
    const largeListing = await measureNamedGatewayListing(large);
    expect(largeListing.statements.length).toBe(smallListing.statements.length);
    expect(largeListing.statements.length).toBeLessThan(100);
    expect(largeListing.tools.filter((tool) => tool.catalogEntryId)).toHaveLength(498);
  });

  it("cleans expired named tokens in bounded batches and retains valid tokens", async () => {
    const fixture = await createListingFixture(db, 3);
    const service = createToolGatewayService(db);
    const expired = await service.createNamedGatewayToken({
      companyId: fixture.company.id, gatewayId: fixture.namedGateway.id,
      body: { name: "Expired test token", clientLabel: "test", ownerNote: "test" },
    });
    const now = new Date();
    await db.update(toolMcpGatewayTokens).set({ expiresAt: new Date(now.getTime() - 1) })
      .where(eq(toolMcpGatewayTokens.id, expired.id));
    await service.cleanupExpiredSessions({ now });
    expect(await db.select().from(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.id, expired.id))).toEqual([]);
    expect(await db.select().from(toolMcpGatewayTokens).where(eq(toolMcpGatewayTokens.id, fixture.token.id))).toHaveLength(1);
    await expect(service.cleanupExpiredSessions({ now })).resolves.toMatchObject({ deletedCount: 0 });
  });

  it("completes an admitted listing after token expiry cleanup without losing its audit", async () => {
    const fixture = await createListingFixture(db, 6);
    const service = createToolGatewayService(db);
    let started!: () => void;
    let resume!: () => void;
    const admitted = new Promise<void>((resolve) => { started = resolve; });
    const gate = new Promise<void>((resolve) => { resume = resolve; });
    const transaction = db.transaction.bind(db);
    const spy = vi.spyOn(db, "transaction").mockImplementationOnce(async (work, config) => {
      started();
      await gate;
      return transaction(work, config);
    });
    const listing = service.listToolsForNamedGateway({ gatewayId: fixture.namedGateway.id, bearerToken: fixture.token.token });
    const outcome = listing.then(({ tools }) => ({ tools }), (error: unknown) => ({ error }));
    try {
      await admitted;
      await db.update(toolMcpGatewayTokens).set({ expiresAt: new Date(Date.now() - 1) })
        .where(eq(toolMcpGatewayTokens.id, fixture.token.id));
      await service.cleanupExpiredSessions();
      resume();
      const result = await outcome;
      expect(result).not.toHaveProperty("error");
      expect("tools" in result && result.tools.length).toBeGreaterThan(0);
      const audits = await db.select().from(activityLog).where(eq(activityLog.companyId, fixture.company.id));
      expect(audits.some((audit) => audit.action === "tool_gateway.discovery")).toBe(true);
      await expect(service.listToolsForNamedGateway({ gatewayId: fixture.namedGateway.id, bearerToken: fixture.token.token }))
        .rejects.toMatchObject({ status: 401 });
    } finally {
      resume();
      await outcome;
      spy.mockRestore();
    }
  });

  it("keeps the query count of a named gateway listing constant from 50 to 500 catalog tools", async () => {
    const small = await createListingFixture(db, 50);
    const large = await createListingFixture(db, 500);

    const smallListing = await measureNamedGatewayListing(small);
    const largeListing = await measureNamedGatewayListing(large);

    const connectedTools = (listing: typeof smallListing, connectionId: string) =>
      listing.tools.filter((tool) => tool.connectionId === connectionId);
    // One tool is excluded by the gateway profile and one is blocked by policy.
    expect(connectedTools(smallListing, small.connection.id)).toHaveLength(48);
    expect(connectedTools(largeListing, large.connection.id)).toHaveLength(498);
    expect(connectedTools(smallListing, small.connection.id).map((tool) => tool.catalogEntryId))
      .not.toContain(small.entries[1]!.id);
    expect(connectedTools(smallListing, small.connection.id).map((tool) => tool.catalogEntryId))
      .not.toContain(small.entries[2]!.id);
    const approvalTool = connectedTools(smallListing, small.connection.id)
      .find((tool) => tool.catalogEntryId === small.entries[0]!.id);
    expect(approvalTool?.description).toMatch(/approval/i);

    expect(largeListing.statements.length).toBe(smallListing.statements.length);
    expect(largeListing.statements.length).toBeLessThan(100);
  });

  it("reads the catalog without repeating the connection row for each tool", async () => {
    const fixture = await createListingFixture(db, 20);
    // An eligible connection without catalog tools adds nothing to a listing.
    const emptyConnection = await db.insert(toolConnections).values({
      companyId: fixture.company.id,
      applicationId: fixture.application.id,
      name: "Connection without tools",
      uid: `test/${randomUUID()}`,
      transport: "mcp_remote",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      config: { url: "https://8.8.8.8/mcp" },
    }).returning().then((rows) => rows[0]!);
    const { statements, statementParams } = await measureNamedGatewayListing(fixture);

    const catalogReads = statements.filter((statement) =>
      statement.includes('from "tool_catalog_entries"')
      && statement.includes('"tool_catalog_entries"."input_schema"'));
    expect(catalogReads.length).toBeGreaterThan(0);
    for (const statement of catalogReads) {
      expect(statement).not.toContain('"tool_connections"."config"');
    }
    const connectionReadParams = statements.flatMap((statement, index) =>
      statement.includes('from "tool_connections"') && statement.includes('"tool_connections"."config"')
        ? [statementParams[index]!]
        : []);
    expect(connectionReadParams).toHaveLength(1);
    expect(connectionReadParams[0]).toContain(fixture.connection.id);
    expect(connectionReadParams[0]).not.toContain(emptyConnection.id);
  });

  it("never selects the whole run snapshot or result when it decides access", async () => {
    // Without agent or company bindings, the project binding is the narrowest match.
    const fixture = await createListingFixture(db, 3, { broadBindings: false });
    const recorder = recordingDb(db);
    const policy = toolAccessPolicyService(recorder.db);
    const projectProfile = await db.insert(toolProfiles).values({
      companyId: fixture.company.id,
      profileKey: `project-${randomUUID()}`,
      name: `Project profile ${randomUUID()}`,
      defaultAction: "allow",
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolProfileBindings).values({
      companyId: fixture.company.id,
      profileId: projectProfile.id,
      targetType: "project",
      targetId: fixture.project.id,
    });
    // The input names only the run. The project comes from the run snapshot,
    // so the project-bound profile allows the tool only if the policy check
    // reads the snapshot ids correctly.
    const input: ToolAccessDecisionInput = {
      companyId: fixture.company.id,
      actor: { actorType: "agent", actorId: fixture.agent.id, agentId: fixture.agent.id },
      runContext: { heartbeatRunId: fixture.run.id },
      request: {
        catalogEntryId: fixture.entries[1]!.id,
        connectionId: fixture.connection.id,
        toolName: "tool_0001",
        arguments: {},
      },
    };

    for (const cache of [undefined, createToolAccessDecisionCache()]) {
      recorder.statements.length = 0;
      const decision = await policy.decide(input, { cache });
      expect(decision).toMatchObject({
        allowed: true,
        reasonCode: "allow_profile",
        effectiveProfileIds: [projectProfile.id],
      });
      await policy.writeAudit(input, decision);
      const recorded = await policy.recordInvocation(input, decision);
      expect(recorded.invocation).toMatchObject({
        runId: fixture.run.id,
        issueId: fixture.issue.id,
      });

      expect(recorder.statements.some((statement) => statement.includes('"heartbeat_runs"'))).toBe(true);
      for (const statement of recorder.statements) {
        expect(statement).not.toMatch(/"context_snapshot"(?!\s*->)/);
        expect(statement).not.toContain("result_json");
        expect(statement).not.toContain('"input_schema"');
      }
    }
  });

  it("reads run context ids from the snapshot with the same rules as before", async () => {
    const fixture = await createListingFixture(db, 3, { broadBindings: false });
    const policy = toolAccessPolicyService(db);
    const otherIssue = await db.insert(issues).values({
      companyId: fixture.company.id,
      projectId: fixture.project.id,
      title: "Other work",
      status: "in_progress",
    }).returning().then((rows) => rows[0]!);
    const projectProfile = await db.insert(toolProfiles).values({
      companyId: fixture.company.id,
      profileKey: `project-${randomUUID()}`,
      name: `Project profile ${randomUUID()}`,
      defaultAction: "allow",
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolProfileBindings).values({
      companyId: fixture.company.id,
      profileId: projectProfile.id,
      targetType: "project",
      targetId: fixture.project.id,
    });
    const runWithSnapshot = (contextSnapshot: Record<string, unknown>) =>
      db.insert(heartbeatRuns).values({
        companyId: fixture.company.id,
        agentId: fixture.agent.id,
        invocationSource: "assignment",
        status: "running",
        contextSnapshot,
      }).returning().then((rows) => rows[0]!);
    const decideForRun = (runId: string, runContext: Partial<NonNullable<ToolAccessDecisionInput["runContext"]>> = {}) =>
      policy.decide({
        companyId: fixture.company.id,
        actor: { actorType: "agent", actorId: fixture.agent.id, agentId: fixture.agent.id },
        runContext: { heartbeatRunId: runId, ...runContext },
        request: {
          catalogEntryId: fixture.entries[1]!.id,
          connectionId: fixture.connection.id,
          toolName: "tool_0001",
          arguments: {},
        },
      });

    // The issue id alone resolves the project through the issue row.
    const issueOnly = await runWithSnapshot({ issueId: fixture.issue.id });
    expect(await decideForRun(issueOnly.id)).toMatchObject({ reasonCode: "allow_profile" });

    // Non-string and blank ids are ignored, as before.
    const malformed = await runWithSnapshot({ issueId: 42, projectId: "  ", routineId: { id: "x" } });
    expect(await decideForRun(malformed.id)).toMatchObject({ reasonCode: "deny_default" });
    expect(await decideForRun(malformed.id, { projectId: fixture.project.id }))
      .toMatchObject({ reasonCode: "allow_profile" });

    // A supplied context that disagrees with the stored snapshot is denied.
    expect(await decideForRun(issueOnly.id, { issueId: otherIssue.id }))
      .toMatchObject({ reasonCode: "deny_run_context_mismatch" });
  });

  it("returns the same decisions with a shared cache as without one", async () => {
    const fixture = await createListingFixture(db, 6);
    const other = await createListingFixture(db, 3);
    const secondAgent = await db.insert(agents).values({
      companyId: fixture.company.id,
      name: `Second Agent ${randomUUID()}`,
      role: "engineer",
      adapterType: "process",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning().then((rows) => rows[0]!);
    const agentProfile = await db.insert(toolProfiles).values({
      companyId: fixture.company.id,
      profileKey: `second-agent-${randomUUID()}`,
      name: `Second agent profile ${randomUUID()}`,
      defaultAction: "allow",
    }).returning().then((rows) => rows[0]!);
    await db.insert(toolProfileBindings).values({
      companyId: fixture.company.id,
      profileId: agentProfile.id,
      targetType: "agent",
      targetId: secondAgent.id,
    });
    const disabledConnection = await db.insert(toolConnections).values({
      companyId: fixture.company.id,
      applicationId: fixture.application.id,
      name: "Disabled connection",
      uid: `test/${randomUUID()}`,
      transport: "mcp_remote",
      status: "disabled",
      enabled: false,
      healthStatus: "ok",
      config: { url: "https://8.8.8.8/mcp" },
    }).returning().then((rows) => rows[0]!);
    const disabledEntry = await db.insert(toolCatalogEntries).values({
      companyId: fixture.company.id,
      applicationId: fixture.application.id,
      connectionId: disabledConnection.id,
      name: "disabled_tool",
      toolName: "disabled_tool",
      riskLevel: "read",
      versionHash: randomUUID(),
    }).returning().then((rows) => rows[0]!);
    // Listings never show a quarantined entry, so a cached decision for it
    // takes the direct query.
    const quarantinedEntry = await db.insert(toolCatalogEntries).values({
      companyId: fixture.company.id,
      applicationId: fixture.application.id,
      connectionId: fixture.connection.id,
      name: "quarantined_tool",
      toolName: "quarantined_tool",
      riskLevel: "read",
      status: "quarantined",
      quarantinedAt: new Date(),
      versionHash: randomUUID(),
    }).returning().then((rows) => rows[0]!);

    const requestFor = (entry: { id: string; connectionId: string; toolName: string }) => ({
      catalogEntryId: entry.id,
      connectionId: entry.connectionId,
      toolName: entry.toolName,
      arguments: {},
    });
    const firstAgentActor = { actorType: "agent" as const, actorId: fixture.agent.id, agentId: fixture.agent.id };
    const secondAgentActor = { actorType: "agent" as const, actorId: secondAgent.id, agentId: secondAgent.id };
    const inputs: ToolAccessDecisionInput[] = [
      ...fixture.entries.map((entry) => ({
        companyId: fixture.company.id,
        actor: firstAgentActor,
        runContext: { heartbeatRunId: fixture.run.id, gatewayId: fixture.namedGateway.id },
        request: requestFor(entry),
      })),
      ...fixture.entries.map((entry) => ({
        companyId: fixture.company.id,
        actor: secondAgentActor,
        request: requestFor(entry),
      })),
      {
        companyId: fixture.company.id,
        actor: secondAgentActor,
        // The run belongs to the first agent.
        runContext: { heartbeatRunId: fixture.run.id },
        request: requestFor(fixture.entries[3]!),
      },
      {
        companyId: fixture.company.id,
        actor: secondAgentActor,
        request: requestFor(disabledEntry),
      },
      {
        companyId: fixture.company.id,
        actor: secondAgentActor,
        request: requestFor(quarantinedEntry),
      },
      {
        companyId: fixture.company.id,
        actor: secondAgentActor,
        // A catalog entry of another company is not in this company's catalog.
        request: requestFor(other.entries[0]!),
      },
      {
        companyId: fixture.company.id,
        actor: secondAgentActor,
        request: { connectionId: fixture.connection.id, toolName: "tool_0004", arguments: {} },
      },
      {
        companyId: fixture.company.id,
        actor: secondAgentActor,
        // The database matches a uuid in any letter case.
        request: { ...requestFor(fixture.entries[4]!), catalogEntryId: fixture.entries[4]!.id.toUpperCase() },
      },
      {
        companyId: fixture.company.id,
        actor: { actorType: "system", actorId: fixture.company.id },
        request: requestFor(fixture.entries[4]!),
      },
    ];

    const policy = toolAccessPolicyService(db);
    const uncached = [];
    for (const input of inputs) uncached.push(await policy.decide(input));
    // One cache across mixed actors and runs: the keys must keep them apart.
    const cache = createToolAccessDecisionCache();
    const cached = await Promise.all(inputs.map((input) => policy.decide(input, { cache })));

    expect(cached).toEqual(uncached);
    expect(new Set(uncached.map((decision) => decision.reasonCode))).toEqual(new Set([
      "allow_profile",
      "deny_default",
      "deny_policy_block",
      "requires_approval_policy",
      "deny_run_context_mismatch",
      "deny_disabled_connection",
      "deny_missing_tool",
    ]));
  });

  it("reads fresh rows for a decision that consumes a rate limit", async () => {
    const fixture = await createListingFixture(db, 3);
    const policy = toolAccessPolicyService(db);
    const cache = createToolAccessDecisionCache();

    await policy.decide({
      companyId: fixture.company.id,
      actor: { actorType: "agent", actorId: fixture.agent.id, agentId: fixture.agent.id },
      runContext: { heartbeatRunId: fixture.run.id },
      request: {
        catalogEntryId: fixture.entries[0]!.id,
        connectionId: fixture.connection.id,
        toolName: "tool_0000",
        arguments: {},
      },
      consumeRateLimit: true,
    }, { cache });

    expect(cache.size).toBe(0);
  });
});
