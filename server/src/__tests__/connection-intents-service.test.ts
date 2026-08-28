import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  companies,
  companyMemberships,
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
  let cleanup: (() => Promise<void>) | undefined;
  let claims!: RuntimeToolsTokenClaims;
  let runId!: string;

  beforeAll(async () => {
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-connection-intents-");
    cleanup = tempDb.cleanup;
    db = createDb(tempDb.connectionString);
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
  });

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

  it("rejects cross-company claims and tokens after the run ends", async () => {
    const service = connectionIntentService(db);
    await expect(service.search({ ...claims, company_id: randomUUID() }, "notion"))
      .rejects.toThrow("does not match its heartbeat run");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, runId));
    await expect(service.search(claims, "notion"))
      .rejects.toThrow("no longer active");
  });
});
