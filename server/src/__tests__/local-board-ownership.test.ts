import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agents, authUsers, companies, companyMemberships, companySecrets,
  connectionGrants, createDb, heartbeatRuns, instanceUserRoles, issueComments, issues,
  routineRevisions, routines, toolApplications, toolConnectionInstalls, toolConnections, userSecretDefinitions,
} from "@paperclipai/db";
import {
  claimBoardOwnership, getBoardClaimWarningUrl, initializeBoardClaimChallenge,
} from "../board-claim.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;

describePostgres("local-board ownership migration", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-local-board-ownership-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    await initializeBoardClaimChallenge(db, { deploymentMode: "local_trusted" });
    await db.transaction(async (tx) => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate table ${companies} cascade`);
    });
    await db.delete(instanceUserRoles);
    await db.delete(authUsers);
  });

  afterAll(async () => { await tempDb?.cleanup(); });

  async function user() {
    const id = randomUUID();
    await db.insert(authUsers).values({
      id, name: "Operator", email: `${id}@example.test`, createdAt: new Date(), updatedAt: new Date(),
    });
    return id;
  }

  async function legacyCompany() {
    const [company] = await db.insert(companies).values({
      name: "Migrated company", issuePrefix: `M${randomUUID().slice(0, 6)}`,
      defaultResponsibleUserId: "local-board",
    }).returning();
    const companyId = company!.id;
    const [agent] = await db.insert(agents).values({ companyId, name: "Worker", role: "engineer" }).returning();
    const [issue] = await db.insert(issues).values({
      companyId, title: "Onboarding", createdByUserId: "local-board", responsibleUserId: "local-board",
    }).returning();
    const [humanTask] = await db.insert(issues).values({
      companyId, title: "Board task", assigneeUserId: "local-board", responsibleUserId: "local-board",
    }).returning();
    const [routine] = await db.insert(routines).values({
      companyId, title: "Agent-created routine", createdByAgentId: agent!.id, responsibleUserId: "local-board",
    }).returning();
    const [revision] = await db.insert(routineRevisions).values({
      companyId, routineId: routine!.id, title: routine!.title, revisionNumber: 1,
      responsibleUserId: "local-board", snapshot: {
        version: 1, triggers: [], routine: {
          id: routine!.id, companyId, title: routine!.title, description: null,
          projectId: null, goalId: null, parentIssueId: null, assigneeAgentId: agent!.id,
          priority: "medium", status: "active", concurrencyPolicy: "coalesce_if_active",
          catchUpPolicy: "skip_missed", activityGatePolicy: "always", activityGateScope: "company",
          variables: [], env: null, responsibleUserId: "local-board",
        },
      },
    }).returning();
    const [definition] = await db.insert(userSecretDefinitions).values({ companyId, key: "token", name: "Token" }).returning();
    const [secret] = await db.insert(companySecrets).values({
      companyId, scope: "user", ownerUserId: "local-board", userSecretDefinitionId: definition!.id,
      key: "token", name: "Local token", provider: "local_encrypted",
    }).returning();
    const [application] = await db.insert(toolApplications).values({
      companyId, name: "AI", type: "rest_api", ownerUserId: "local-board",
    }).returning();
    const [connection] = await db.insert(toolConnections).values({
      companyId, applicationId: application!.id, name: "AI account", uid: randomUUID(),
      transport: "runtime_auth", connectionPurpose: "ai", createdByUserId: "local-board",
    }).returning();
    const [grant] = await db.insert(connectionGrants).values({
      companyId, connectionId: connection!.id, kind: "user", subjectUserId: "local-board", createdByUserId: "local-board",
    }).returning();
    const [run] = await db.insert(heartbeatRuns).values({
      companyId, agentId: agent!.id, invocationSource: "on_demand", status: "succeeded", responsibleUserId: "local-board",
    }).returning();
    return { companyId, agentId: agent!.id, issue: issue!, humanTask: humanTask!, routine: routine!, revision: revision!,
      secret: secret!, application: application!, connection: connection!, grant: grant!, run: run! };
  }

  async function owner(companyId: string, userId: string) {
    await db.insert(companyMemberships).values({
      companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "owner",
    });
  }

  function challenge() {
    const url = new URL(getBoardClaimWarningUrl("127.0.0.1", 3100)!);
    return { token: url.pathname.split("/").pop()!, code: url.searchParams.get("code")! };
  }

  async function chat(companyId: string, agentId: string, userId: string) {
    const [row] = await db.insert(issues).values({
      companyId, title: "Chat with worker", conversationAgentId: agentId, conversationUserId: userId,
      conversationState: "waiting", status: "in_review", assigneeAgentId: agentId,
      responsibleUserId: userId, createdByUserId: userId,
    }).returning();
    return row!;
  }

  async function migrate(companyId: string, userId: string, mode: "claim" | "repair") {
    if (mode === "repair") {
      await owner(companyId, userId);
      await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    } else {
      await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    }
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    if (mode === "claim") {
      await expect(claimBoardOwnership(db, { ...challenge(), userId })).resolves.toMatchObject({ status: "claimed" });
    }
  }

  it.each(["claim", "repair"] as const)("transfers existing chat ownership during %s", async (mode) => {
    const { issueService } = await import("../services/issues.js");
    const userId = await user();
    const f = await legacyCompany();
    const legacy = await chat(f.companyId, f.agentId, "local-board");
    await db.insert(issueComments).values({ companyId: f.companyId, issueId: legacy.id, authorUserId: "local-board", body: "Saved history" });
    await migrate(f.companyId, userId, mode);
    const saved = await issueService(db).getConversation(f.companyId, f.agentId, userId);
    expect(saved).toMatchObject({ id: legacy.id, conversationUserId: userId, responsibleUserId: userId });
    expect(await issueService(db).listConversations(f.companyId, userId)).toMatchObject([{ id: legacy.id }]);
    expect((await db.select().from(issueComments))[0]).toMatchObject({ issueId: legacy.id, authorUserId: "local-board", body: "Saved history" });
  });

  it.each(["claim", "repair"] as const)("retains conflicting legacy chat history as a private task during %s", async (mode) => {
    const { issueService } = await import("../services/issues.js");
    const { canActorReadIssuePrivacy } = await import("../services/authorization.js");
    const userId = await user();
    const outsiderId = await user();
    const f = await legacyCompany();
    await db.insert(companyMemberships).values({ companyId: f.companyId, principalType: "user", principalId: outsiderId, status: "active", membershipRole: "operator" });
    const legacy = await chat(f.companyId, f.agentId, "local-board");
    const personal = await chat(f.companyId, f.agentId, userId);
    const [message] = await db.insert(issueComments).values({ companyId: f.companyId, issueId: legacy.id, authorUserId: "local-board", body: "Legacy private history" }).returning();
    await migrate(f.companyId, userId, mode);
    expect((await db.select().from(issues).where(eq(issues.id, personal.id)))[0]).toEqual(personal);
    const [history] = await db.select().from(issues).where(eq(issues.id, legacy.id));
    expect(history).toMatchObject({ conversationAgentId: null, conversationUserId: null, conversationState: null,
      visibility: "private", privacyRootIssueId: legacy.id, responsibleUserId: userId, assigneeAgentId: f.agentId });
    expect((await db.select().from(issueComments).where(eq(issueComments.id, message!.id)))[0]).toEqual(message);
    const actor = (id: string) => ({ type: "board" as const, userId: id, source: "session" as const, companyIds: [f.companyId] });
    expect(await canActorReadIssuePrivacy(db, actor(userId), history!)).toBe(true);
    expect(await canActorReadIssuePrivacy(db, actor(outsiderId), history!)).toBe(false);
    expect(await issueService(db).listConversations(f.companyId, userId)).toMatchObject([{ id: personal.id }]);
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });

  async function expectTransferred(f: Awaited<ReturnType<typeof legacyCompany>>, userId: string) {
    expect((await db.select().from(companies).where(eq(companies.id, f.companyId)))[0]?.defaultResponsibleUserId).toBe(userId);
    expect((await db.select().from(issues).where(eq(issues.id, f.issue.id)))[0]).toMatchObject({
      responsibleUserId: userId, createdByUserId: "local-board",
    });
    expect((await db.select().from(issues).where(eq(issues.id, f.humanTask.id)))[0]?.assigneeUserId).toBe(userId);
    expect((await db.select().from(routines).where(eq(routines.id, f.routine.id)))[0]?.responsibleUserId).toBe(userId);
    expect((await db.select().from(routineRevisions).where(eq(routineRevisions.id, f.revision.id)))[0]).toMatchObject({
      responsibleUserId: userId, snapshot: { routine: { responsibleUserId: userId } },
    });
    expect((await db.select().from(companySecrets).where(eq(companySecrets.id, f.secret.id)))[0]?.ownerUserId).toBe(userId);
    expect((await db.select().from(toolApplications).where(eq(toolApplications.id, f.application.id)))[0]?.ownerUserId).toBe(userId);
    expect((await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id)))[0]?.createdByUserId).toBe(userId);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id)))[0]?.createdByUserId).toBe(userId);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.run.id)))[0]?.responsibleUserId).toBe("local-board");
  }

  it("transfers operational ownership with the authenticated board claim", async () => {
    const userId = await user();
    const f = await legacyCompany();
    await db.insert(companyMemberships).values({
      companyId: f.companyId, principalType: "user", principalId: userId, status: "active", membershipRole: "viewer",
    });
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    await expect(claimBoardOwnership(db, { ...challenge(), code: "incorrect", userId })).resolves.toEqual({ status: "invalid" });
    expect((await db.select().from(companies))[0]?.defaultResponsibleUserId).toBe("local-board");
    await expect(claimBoardOwnership(db, { ...challenge(), userId })).resolves.toMatchObject({ status: "claimed" });
    await expectTransferred(f, userId);
    expect(await db.select().from(companyMemberships)).toMatchObject([{ principalId: userId, membershipRole: "owner" }]);
    expect((await db.select().from(connectionGrants))[0]?.subjectUserId).toBe(userId);
    expect(await db.select().from(activityLog)).toMatchObject([{ action: "company.local_board_ownership_transferred", responsibleUserId: userId }]);
  });

  it("repairs an already-claimed instance on startup without replacing personal credentials or reviving revoked grants", async () => {
    const userId = await user();
    const f = await legacyCompany();
    await owner(f.companyId, userId);
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.id, f.grant.id));
    const [personal] = await db.insert(connectionGrants).values({
      companyId: f.companyId, connectionId: f.connection.id, kind: "user", subjectUserId: userId,
    }).returning();
    const otherCompany = await legacyCompany();
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    await expectTransferred(f, userId);
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, f.grant.id)))[0]).toMatchObject({
      subjectUserId: "local-board", status: "revoked",
    });
    expect((await db.select().from(connectionGrants).where(eq(connectionGrants.id, personal!.id)))[0]).toEqual(personal);
    expect((await db.select().from(companies).where(eq(companies.id, otherCompany.companyId)))[0]?.defaultResponsibleUserId).toBe("local-board");
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });

  it("does not guess ownership in local trusted mode or with multiple administrators", async () => {
    const userId = await user();
    const f = await legacyCompany();
    await owner(f.companyId, userId);
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "local_trusted" });
    expect((await db.select().from(companies))[0]?.defaultResponsibleUserId).toBe("local-board");
    await db.insert(instanceUserRoles).values({ userId: await user(), role: "instance_admin" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    expect((await db.select().from(companies))[0]?.defaultResponsibleUserId).toBe("local-board");
    expect(await db.select().from(activityLog)).toHaveLength(0);
  });

  it("resolves the operator's managed GitHub identity for migrated task and routine responsibility", async () => {
    const { resolveManagedGitHubIdentitySelection } = await import("../services/git-credentials.js");
    const userId = await user();
    const f = await legacyCompany();
    await owner(f.companyId, userId);
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    const [github] = await db.insert(toolConnections).values({
      companyId: f.companyId, applicationId: f.application.id, uid: randomUUID(), name: "GitHub",
      transport: "rest_api", status: "active", enabled: true, config: { sourceTemplateKey: "github" },
    }).returning();
    await db.insert(toolConnectionInstalls).values({
      companyId: f.companyId, connectionId: github!.id, targetType: "company", targetId: f.companyId,
    });
    const [grant] = await db.insert(connectionGrants).values({
      companyId: f.companyId, connectionId: github!.id, kind: "user", subjectUserId: userId,
    }).returning();
    expect(await resolveManagedGitHubIdentitySelection(db, f.companyId, { responsibleUserId: "local-board" }))
      .toMatchObject({ configured: true, error: "No managed GitHub identity is available for this run" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const [company] = await db.select().from(companies).where(eq(companies.id, f.companyId));
    const [routine] = await db.select().from(routineRevisions).where(eq(routineRevisions.id, f.revision.id));
    const [task] = await db.select().from(issues).where(eq(issues.id, f.issue.id));
    for (const responsibleUserId of [company!.defaultResponsibleUserId, routine!.responsibleUserId, task!.responsibleUserId]) {
      expect(await resolveManagedGitHubIdentitySelection(db, f.companyId, { responsibleUserId }))
        .toMatchObject({ configured: true, identitySource: "personal", grant: { id: grant!.id, subjectUserId: userId } });
    }
    expect(await resolveManagedGitHubIdentitySelection(db, f.companyId, { responsibleUserId: await user() }))
      .toMatchObject({ configured: true, error: "No managed GitHub identity is available for this run" });
  });

  it("preserves explicit defaults, personal secrets, and grant revocations on repair", async () => {
    const userId = await user();
    const f = await legacyCompany();
    const explicitUserId = await user();
    await db.update(companies).set({ defaultResponsibleUserId: explicitUserId }).where(eq(companies.id, f.companyId));
    const [personalSecret] = await db.insert(companySecrets).values({
      companyId: f.companyId, scope: "user", ownerUserId: userId,
      userSecretDefinitionId: f.secret.userSecretDefinitionId, key: "token", name: "Personal token", provider: "local_encrypted",
    }).returning();
    await db.update(connectionGrants).set({ status: "revoked", revokedAt: new Date() }).where(eq(connectionGrants.id, f.grant.id));
    await owner(f.companyId, userId);
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    expect((await db.select().from(companies))[0]?.defaultResponsibleUserId).toBe(explicitUserId);
    expect((await db.select().from(companySecrets).where(eq(companySecrets.id, personalSecret!.id)))[0]).toEqual(personalSecret);
    expect((await db.select().from(companySecrets).where(eq(companySecrets.id, f.secret.id)))[0]?.ownerUserId).toBe("local-board");
    expect((await db.select().from(connectionGrants))[0]).toMatchObject({ subjectUserId: userId, status: "revoked" });
  });

  it("requires reconnection when a transferred grant references a conflicting legacy secret", async () => {
    const userId = await user();
    const f = await legacyCompany();
    await db.insert(companySecrets).values({
      companyId: f.companyId, scope: "user", ownerUserId: userId,
      userSecretDefinitionId: f.secret.userSecretDefinitionId, key: "token", name: "Personal token", provider: "local_encrypted",
    });
    await db.update(connectionGrants).set({
      credentialSecretRefs: [{ secretId: f.secret.id, configPath: "oauth.access_token" }],
    }).where(eq(connectionGrants.id, f.grant.id));
    await owner(f.companyId, userId);
    await db.insert(instanceUserRoles).values({ userId, role: "instance_admin" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    expect((await db.select().from(connectionGrants))[0]).toMatchObject({ subjectUserId: userId, status: "needs_reauthorization" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });

  it("commits only one owner when two signed-in users claim concurrently", async () => {
    const first = await user();
    const second = await user();
    const f = await legacyCompany();
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const credentials = challenge();
    const results = await Promise.all([first, second].map(userId => claimBoardOwnership(db, { ...credentials, userId })));
    const winner = results.find(result => result.status === "claimed")?.claimedByUserId;
    expect(results.filter(result => result.status === "claimed")).toHaveLength(1);
    expect(await db.select().from(instanceUserRoles)).toMatchObject([{ userId: winner }]);
    expect(await db.select().from(companyMemberships)).toMatchObject([{ principalId: winner, membershipRole: "owner" }]);
    await expectTransferred(f, winner!);
    expect(await db.select().from(activityLog)).toHaveLength(1);
    const loser = first === winner ? second : first;
    await expect(claimBoardOwnership(db, { ...credentials, userId: loser })).resolves.toEqual({
      status: "claimed", claimedByUserId: winner,
    });
    expect(await db.select().from(activityLog)).toHaveLength(1);
  });

  it("rolls back access and ownership together if a transfer fails", async () => {
    const userId = await user();
    const f = await legacyCompany();
    await db.insert(instanceUserRoles).values({ userId: "local-board", role: "instance_admin" });
    await initializeBoardClaimChallenge(db, { deploymentMode: "authenticated" });
    const credentials = challenge();
    await db.execute(sql`create function reject_owner_transfer() returns trigger language plpgsql as
      $$ begin raise exception 'injected transfer failure'; end $$`);
    await db.execute(sql`create trigger reject_owner_transfer before update on ${toolConnections}
      for each row execute function reject_owner_transfer()`);
    try {
      await expect(claimBoardOwnership(db, { ...credentials, userId })).rejects.toThrow();
      expect(await db.select().from(instanceUserRoles)).toMatchObject([{ userId: "local-board" }]);
      expect(await db.select().from(companyMemberships)).toHaveLength(0);
      expect((await db.select().from(companies))[0]?.defaultResponsibleUserId).toBe("local-board");
      expect((await db.select().from(routines))[0]?.responsibleUserId).toBe("local-board");
      expect(await db.select().from(activityLog)).toHaveLength(0);
    } finally {
      await db.execute(sql`drop trigger reject_owner_transfer on ${toolConnections}`);
      await db.execute(sql`drop function reject_owner_transfer()`);
    }
    await expect(claimBoardOwnership(db, { ...credentials, userId })).resolves.toMatchObject({ status: "claimed" });
    await expectTransferred(f, userId);
  });
});
