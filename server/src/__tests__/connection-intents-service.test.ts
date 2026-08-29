import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
  companySecretBindings,
  companySecrets,
  connectionGrantDelegations,
  connectionGrants,
  createDb,
  goals,
  heartbeatRuns,
  issueThreadInteractions,
  issues,
  toolApplications,
  toolConnectionInstalls,
  toolConnections,
  toolProfileBindings,
  toolProfiles,
  userSecretDefinitions,
} from "@paperclipai/db";
import type { RuntimeToolsTokenClaims } from "../runtime-tools-token.js";
import { wakeConnectionIntentAfterResolution } from "../routes/connection-intents.js";
import { connectionIntentService } from "../services/connection-intents.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

describe("wakeConnectionIntentAfterResolution", () => {
  it("preserves resolved interaction evidence in the queued run snapshot", async () => {
    const wakeup = vi.fn().mockResolvedValue(null);
    await wakeConnectionIntentAfterResolution(
      { wakeup } as Parameters<typeof wakeConnectionIntentAfterResolution>[0],
      {
        loaded: {
          issue: { id: "issue-1", assigneeAgentId: "agent-1", status: "in_progress" },
          interaction: {
            id: "interaction-1",
            resolvedAt: "2026-08-28T13:30:00.000Z",
          },
        },
        status: "accepted",
        actorId: "user-1",
      },
    );

    expect(wakeup).toHaveBeenCalledWith("agent-1", expect.objectContaining({
      contextSnapshot: expect.objectContaining({
        interactionId: "interaction-1",
        interactionKind: "connection_intent",
        interactionStatus: "accepted",
        interactionResolvedAt: "2026-08-28T13:30:00.000Z",
        mutation: "interaction",
        wakeReason: "issue_commented",
      }),
    }));
  });
});

describeEmbeddedPostgres("connectionIntentService", () => {
  let db!: ReturnType<typeof createDb>;
  let connectionString!: string;
  let cleanup: (() => Promise<void>) | undefined;
  let claims!: RuntimeToolsTokenClaims;
  let runId!: string;

  beforeAll(async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-connection-intents-");
    cleanup = tempDb.cleanup;
    connectionString = tempDb.connectionString;
    db = createDb(connectionString);
    const companyId = randomUUID();
    const agentId = randomUUID();
    const goalId = randomUUID();
    const issueId = randomUUID();
    runId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Connection tests",
      issuePrefix: "CONN",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: "responsible-user",
      status: "active",
      membershipRole: "member",
    });
    await db.insert(goals).values({
      id: goalId,
      companyId,
      title: "Connect a service",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Researcher",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      goalId,
      title: "Read Notion",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      status: "running",
      responsibleUserId: "responsible-user",
      contextSnapshot: { issueId },
    });
    claims = {
      sub: agentId,
      company_id: companyId,
      run_id: runId,
      responsible_user_id: "responsible-user",
      scope: "connection_intents",
      iat: 1,
      exp: 2,
      instance_id: "test",
    };
  }, 20_000);

  afterAll(async () => {
    await cleanup?.();
  });

  async function waitForBlockedMembershipLock() {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const [waiting] = await db.execute<{ waiting: boolean }>(sql`
        SELECT EXISTS (
          SELECT 1
          FROM pg_stat_activity
          WHERE state = 'active'
            AND wait_event_type = 'Lock'
            AND query ILIKE '%company_memberships%'
            AND query ILIKE '%for update%'
        ) AS waiting
      `);
      if (waiting?.waiting) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  it("searches first-party definitions without leaking run identity", async () => {
    const result = await connectionIntentService(db).search(claims, "notion");
    expect(result.results).toEqual([
      expect.objectContaining({ service: "notion", state: "available" }),
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("responsible-user");
    expect(serialized).not.toContain(claims.sub);
  });

  it("creates one addressed request, resolves only after delegation and install, and then reports ready", async () => {
    const service = connectionIntentService(db);
    const first = await service.request(claims, "notion");
    const repeated = await service.request(claims, "notion");
    expect(repeated.interactionId).toBe(first.interactionId);
    const [row] = await db.select().from(issueThreadInteractions)
      .where(eq(issueThreadInteractions.id, first.interactionId!));
    expect(row).toMatchObject({
      kind: "connection_intent",
      addresseeUserId: "responsible-user",
      sourceRunId: runId,
      status: "pending",
    });

    const [application] = await db.insert(toolApplications).values({
      companyId: claims.company_id,
      applicationKey: `notion-${randomUUID()}`,
      name: "Notion",
      type: "mcp_http",
      status: "active",
      metadata: { sourceTemplateKey: "notion" },
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: claims.company_id,
      applicationId: application!.id,
      name: "Responsible user's Notion",
      uid: `notion/${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "api_key",
      credentialPolicy: "per_user",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      config: { sourceTemplateKey: "notion" },
      transportConfig: { sourceTemplateKey: "notion" },
    }).returning();
    const [grant] = await db.insert(connectionGrants).values({
      companyId: claims.company_id,
      connectionId: connection!.id,
      kind: "user",
      subjectUserId: claims.responsible_user_id,
      status: "active",
      isDefault: false,
    }).returning();
    const [otherAgent] = await db.insert(agents).values({
      companyId: claims.company_id,
      name: "Existing Notion user",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    }).returning();
    await db.insert(toolConnectionInstalls).values({
      companyId: claims.company_id,
      connectionId: connection!.id,
      targetType: "agent",
      targetId: otherAgent!.id,
    });

    await expect(service.complete(first.interactionId!, connection!.id, "someone-else"))
      .rejects.toThrow("Only the addressed user");
    expect(await db.select().from(connectionGrantDelegations)).toHaveLength(0);
    expect(await db.select().from(issueThreadInteractions).where(
      eq(issueThreadInteractions.id, first.interactionId!),
    )).toEqual([expect.objectContaining({ status: "pending" })]);

    const resolved = await service.complete(
      first.interactionId!,
      connection!.id,
      claims.responsible_user_id,
    );
    expect(resolved).toMatchObject({
      status: "accepted",
      result: { outcome: "connected", connectionId: connection!.id },
    });
    expect(await db.select().from(connectionGrantDelegations).where(
      eq(connectionGrantDelegations.grantId, grant!.id),
    )).toEqual([
      expect.objectContaining({
        agentId: claims.sub,
        createdByUserId: claims.responsible_user_id,
      }),
    ]);
    const installs = await db.select().from(toolConnectionInstalls).where(
      eq(toolConnectionInstalls.connectionId, connection!.id),
    );
    expect(installs).toHaveLength(2);
    expect(installs).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetType: "agent", targetId: claims.sub }),
      expect.objectContaining({ targetType: "agent", targetId: otherAgent!.id }),
    ]));

    const continuationRunId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: continuationRunId,
      companyId: claims.company_id,
      agentId: claims.sub,
      status: "running",
      responsibleUserId: claims.responsible_user_id,
      contextSnapshot: { issueId: row!.issueId },
    });
    const continuationClaims: RuntimeToolsTokenClaims = {
      ...claims,
      run_id: continuationRunId,
    };
    const readySearch = await service.search(continuationClaims, "notion");
    expect(readySearch.results).toEqual([
      expect.objectContaining({ service: "notion", state: "ready", connectionId: connection!.id }),
    ]);
    const readyRequest = await service.request(continuationClaims, "notion");
    expect(readyRequest).toMatchObject({
      state: "ready",
      interactionId: null,
      connectionId: connection!.id,
    });
    expect(await db.select().from(issueThreadInteractions)).toHaveLength(1);
    await expect(service.complete(first.interactionId!, connection!.id, claims.responsible_user_id))
      .rejects.toThrow("already resolved");
    await expect(service.request(claims, "unknown-service"))
      .rejects.toThrow("is not available");
    expect((await service.search(claims, "github")).results).toEqual([]);
    await expect(service.request(claims, "github"))
      .rejects.toThrow("is not available");
  });

  it("serializes OAuth intent completion behind addressed-user membership revocation", async () => {
    const raceCompanyId = randomUUID();
    const raceAgentId = randomUUID();
    const raceGoalId = randomUUID();
    const raceIssueId = randomUUID();
    const raceRunId = randomUUID();
    const raceUserId = `race-user-${randomUUID()}`;
    await db.insert(companies).values({
      id: raceCompanyId,
      name: "Connection intent authority race",
      issuePrefix: `RACE${randomUUID().slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId: raceCompanyId,
      principalType: "user",
      principalId: raceUserId,
      status: "active",
      membershipRole: "member",
    });
    await db.insert(goals).values({
      id: raceGoalId,
      companyId: raceCompanyId,
      title: "Connect Notion during authority race",
      level: "task",
      status: "active",
    });
    await db.insert(agents).values({
      id: raceAgentId,
      companyId: raceCompanyId,
      name: "Race agent",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: raceIssueId,
      companyId: raceCompanyId,
      goalId: raceGoalId,
      title: "Use Notion",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: raceAgentId,
    });
    await db.insert(heartbeatRuns).values({
      id: raceRunId,
      companyId: raceCompanyId,
      agentId: raceAgentId,
      status: "running",
      responsibleUserId: raceUserId,
      contextSnapshot: { issueId: raceIssueId },
    });
    const raceClaims: RuntimeToolsTokenClaims = {
      sub: raceAgentId,
      company_id: raceCompanyId,
      run_id: raceRunId,
      responsible_user_id: raceUserId,
      scope: "connection_intents",
      iat: 1,
      exp: 2,
      instance_id: "test",
    };
    const completionDb = createDb(connectionString, { maxConnections: 1 });
    const revocationDb = createDb(connectionString, { maxConnections: 1 });
    const service = connectionIntentService(completionDb);
    const pending = await service.request(raceClaims, "notion");
    const [application] = await db.insert(toolApplications).values({
      companyId: raceClaims.company_id,
      applicationKey: `notion-race-${randomUUID()}`,
      name: "Notion",
      type: "mcp_http",
      status: "active",
      metadata: { sourceTemplateKey: "notion" },
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId: raceClaims.company_id,
      applicationId: application!.id,
      name: "Personal Notion OAuth",
      uid: `notion-race/${randomUUID()}`,
      transport: "mcp_remote",
      authKind: "oauth",
      credentialPolicy: "shared",
      status: "active",
      enabled: true,
      healthStatus: "ok",
      config: { sourceTemplateKey: "notion", connectionMethodKey: "mcp-oauth" },
      transportConfig: { sourceTemplateKey: "notion", connectionMethodKey: "mcp-oauth" },
    }).returning();
    const [secretDefinition] = await db.insert(userSecretDefinitions).values({
      companyId: raceClaims.company_id,
      key: `notion-oauth-${randomUUID()}`,
      name: "Notion OAuth access token",
    }).returning();
    const [accessSecret] = await db.insert(companySecrets).values({
      companyId: raceClaims.company_id,
      scope: "user",
      ownerUserId: raceClaims.responsible_user_id,
      userSecretDefinitionId: secretDefinition!.id,
      key: `notion-oauth-${randomUUID()}`,
      name: `Notion OAuth ${randomUUID()}`,
    }).returning();
    await db.insert(connectionGrants).values({
      companyId: raceClaims.company_id,
      connectionId: connection!.id,
      kind: "user",
      subjectUserId: raceClaims.responsible_user_id,
      credentialSecretRefs: [{
        secretId: accessSecret!.id,
        versionSelector: "latest",
        configPath: "oauth.access_token",
        required: true,
        label: "OAuth access token",
      }],
      status: "active",
      isDefault: false,
    });
    const expectNoOAuthCompletionWrites = async () => {
      await expect(db.select().from(toolConnections).where(
        eq(toolConnections.id, connection!.id),
      )).resolves.toEqual([expect.objectContaining({
        credentialPolicy: "shared",
        credentialRefs: [],
        credentialSecretRefs: [],
        status: "active",
        enabled: true,
      })]);
      await expect(db.select().from(companySecretBindings).where(and(
        eq(companySecretBindings.companyId, raceClaims.company_id),
        eq(companySecretBindings.targetType, "tool_connection"),
        eq(companySecretBindings.targetId, connection!.id),
      ))).resolves.toHaveLength(0);
      await expect(db.select().from(toolProfiles).where(and(
        eq(toolProfiles.companyId, raceClaims.company_id),
        eq(toolProfiles.profileKey, `app:${connection!.id}`),
      ))).resolves.toHaveLength(0);
      await expect(db.select().from(toolProfileBindings).where(
        eq(toolProfileBindings.companyId, raceClaims.company_id),
      )).resolves.toHaveLength(0);
      await expect(db.select().from(toolConnectionInstalls).where(
        eq(toolConnectionInstalls.connectionId, connection!.id),
      )).resolves.toHaveLength(0);
      await expect(db.select().from(connectionGrantDelegations).where(
        eq(connectionGrantDelegations.companyId, raceClaims.company_id),
      )).resolves.toHaveLength(0);
      await expect(db.select().from(issueThreadInteractions).where(
        eq(issueThreadInteractions.id, pending.interactionId!),
      )).resolves.toEqual([expect.objectContaining({ status: "pending" })]);
    };
    let releaseRevocation!: () => void;
    const revocationMayCommit = new Promise<void>((resolve) => {
      releaseRevocation = resolve;
    });
    let membershipLocked!: () => void;
    const membershipIsLocked = new Promise<void>((resolve) => {
      membershipLocked = resolve;
    });
    let revocation: Promise<void> | null = null;
    let completion: Promise<{ value: unknown; error: unknown }> | null = null;

    try {
      revocation = revocationDb.transaction(async (tx) => {
        await tx
          .select({ id: companyMemberships.id })
          .from(companyMemberships)
          .where(and(
            eq(companyMemberships.companyId, raceClaims.company_id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, raceClaims.responsible_user_id),
          ))
          .for("update");
        membershipLocked();
        await revocationMayCommit;
        await tx
          .update(companyMemberships)
          .set({ membershipRole: "viewer", updatedAt: new Date() })
          .where(and(
            eq(companyMemberships.companyId, raceClaims.company_id),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, raceClaims.responsible_user_id),
          ));
      });

      await membershipIsLocked;
      completion = service.complete(
        pending.interactionId!,
        connection!.id,
        raceClaims.responsible_user_id,
        { canManageOrganizationGrant: true },
      ).then(
        (value) => ({ value, error: null }),
        (error: unknown) => ({ value: null, error }),
      );

      expect(await waitForBlockedMembershipLock()).toBe(true);
      await expectNoOAuthCompletionWrites();

      releaseRevocation();
      await revocation;
      const outcome = await completion;
      expect(outcome.value).toBeNull();
      expect(outcome.error).toMatchObject({
        status: 403,
        message: expect.stringContaining("no longer authorized"),
      });
      await expectNoOAuthCompletionWrites();
    } finally {
      releaseRevocation();
      await revocation?.catch(() => undefined);
      await completion?.catch(() => undefined);
      await completionDb.$client.end({ timeout: 0 }).catch(() => undefined);
      await revocationDb.$client.end({ timeout: 0 }).catch(() => undefined);
    }
  }, 15_000);

  it("revalidates the responsible user's active write membership for every token use", async () => {
    const service = connectionIntentService(db);
    try {
      await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(
        companyMemberships.principalId,
        claims.responsible_user_id,
      ));
      await expect(service.search(claims, "notion"))
        .rejects.toThrow("no longer authorized for company write access");

      await db.update(companyMemberships).set({ membershipRole: "member", status: "inactive" }).where(eq(
        companyMemberships.principalId,
        claims.responsible_user_id,
      ));
      await expect(service.request(claims, "notion"))
        .rejects.toThrow("no longer authorized for company write access");
    } finally {
      await db.update(companyMemberships).set({ membershipRole: "member", status: "active" }).where(eq(
        companyMemberships.principalId,
        claims.responsible_user_id,
      ));
    }
  });

  it("rejects every addressed-user mutation after write membership is revoked", async () => {
    const service = connectionIntentService(db);
    const pending = await service.request(claims, "posthog");
    expect(pending.interactionId).toBeTruthy();
    try {
      await db.update(companyMemberships).set({ membershipRole: "viewer" }).where(eq(
        companyMemberships.principalId,
        claims.responsible_user_id,
      ));
      await expect(service.updatePhase(
        pending.interactionId!,
        "authorizing",
        claims.responsible_user_id,
      )).rejects.toThrow("no longer authorized for company write access");
      await expect(service.decline(
        pending.interactionId!,
        claims.responsible_user_id,
      )).rejects.toThrow("no longer authorized for company write access");
      await expect(service.complete(
        pending.interactionId!,
        randomUUID(),
        claims.responsible_user_id,
      )).rejects.toThrow("no longer authorized for company write access");
    } finally {
      await db.update(companyMemberships).set({ membershipRole: "member", status: "active" }).where(eq(
        companyMemberships.principalId,
        claims.responsible_user_id,
      ));
    }
  });

  it("rejects cross-company claims and tokens after the run ends", async () => {
    const service = connectionIntentService(db);
    await expect(service.search({ ...claims, company_id: randomUUID() }, "notion"))
      .rejects.toThrow("does not match its heartbeat run");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    await expect(service.search(claims, "notion"))
      .rejects.toThrow("no longer active");
  });
});
