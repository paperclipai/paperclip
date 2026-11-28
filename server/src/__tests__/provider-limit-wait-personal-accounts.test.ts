import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  agents, aiProviderDefaults, authUsers, companies, companyMemberships, connectionGrants, createDb, heartbeatRuns, issues,
  toolApplications, toolConnectionInstalls, toolConnections,
} from "@paperclipai/db";
import { createProviderLimitWait } from "../services/heartbeat/provider-limit-wait.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping personal account provider limit tests: ${recoveryPostgresSupport.reason}`);

/** An agent on "the responsible person's account" runs each user's work on that user's own account. */
describePostgres("provider limit holds for agents on each responsible user's own account", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  type Account = { connectionId: string; grantId: string };

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("personal-provider-limit-");
    db = createDb(temporary.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seedCompany(userNames: string[]) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Personal accounts fixture", issuePrefix: `P${companyId.slice(0, 6)}` });
    const users: Record<string, string> = {};
    for (const name of userNames) {
      const userId = `${name}-${companyId}`;
      await db.insert(authUsers).values({ id: userId, name, email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
      await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
      users[name] = userId;
    }
    await db.insert(agents).values({ id: agentId, companyId, name: "Reviewer", adapterType: "paperclip_runner", status: "idle",
      adapterConfig: { provider: "acpx", acpxAgent: "antigravity" },
      runtimeConfig: { aiConnection: { mode: "responsible_user", provider: "google", method: "subscription" } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review the pull request", status: "todo",
      assigneeAgentId: agentId, responsibleUserId: Object.values(users)[0], issueNumber: 1 });
    const [application] = await db.insert(toolApplications)
      .values({ companyId, name: `AI accounts ${randomUUID()}`, type: "mcp_http" }).returning();
    return { companyId, agentId, issueId, users, applicationId: application.id };
  }

  async function account(f: Awaited<ReturnType<typeof seedCompany>>, owner: string | null, healthStatus = "ok"): Promise<Account> {
    const [connection] = await db.insert(toolConnections).values({ companyId: f.companyId, applicationId: f.applicationId,
      uid: randomUUID(), name: owner ? `${owner} account` : "Shared account", connectionPurpose: "ai", transport: "runtime_auth",
      authKind: "none", enabled: true, status: "active", healthStatus,
      config: { ai: { provider: "google", method: "subscription" }, aiIsolatedSubscription: true } }).returning();
    const [grant] = await db.insert(connectionGrants).values({ companyId: f.companyId, connectionId: connection.id,
      ...(owner ? { kind: "user", subjectUserId: owner } : { kind: "organization" }) }).returning();
    await db.insert(toolConnectionInstalls).values({ companyId: f.companyId, connectionId: connection.id,
      targetType: "company", targetId: f.companyId });
    if (owner) await db.insert(aiProviderDefaults).values({ companyId: f.companyId, userId: owner, provider: "google", grantId: grant.id });
    return { connectionId: connection.id, grantId: grant.id };
  }

  /** A turn on `limited` that the provider refused with a quota reset days away. */
  async function quotaOn(f: Awaited<ReturnType<typeof seedCompany>>, limited: Account, responsibleUserId: string | null) {
    await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, invocationSource: "automation",
      triggerDetail: "system", status: "failed", responsibleUserId,
      startedAt: new Date(Date.now() - 7 * 60_000), finishedAt: new Date(Date.now() - 5 * 60_000),
      errorCode: "native_provider_usage_limit",
      contextSnapshot: { aiConnection: { provider: "google", method: "subscription", ...limited } },
      resultJson: { providerFailure: { schema: "paperclip.provider-failure.v1", provider: "antigravity", phase: "turn",
        category: "quota_exhausted", httpStatus: 429, providerCode: "RESOURCE_EXHAUSTED", retryability: "requires_action",
        retryAt: new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString(), message: "Usage limit reached for this account." } } });
  }

  async function heldFor(f: Awaited<ReturnType<typeof seedCompany>>, responsibleUserId: string) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
      invocationSource: "automation", triggerDetail: "system", responsibleUserId, contextSnapshot: { issueId: f.issueId } }).returning();
    return createProviderLimitWait(db, {
      setRunStatusIfRunning: async () => ({ updated: true, run: { ...run, status: "cancelled" } }),
      setWakeupStatus: async () => undefined, appendRunEvent: async () => undefined,
      scheduleBoundedRetryForRun: async () => ({ outcome: "scheduled" }),
      releaseIssueExecutionAndPromote: async () => undefined, finalizeAgentStatus: async () => undefined,
    } as never).deferRunForProviderLimit(run, agent, { resumingAdmittedRun: false, conversation: false });
  }

  it("holds only the user whose own account reported the limit", async () => {
    const f = await seedCompany(["alice", "bob"]);
    const alice = await account(f, f.users.alice);
    await account(f, f.users.bob);
    await quotaOn(f, alice, f.users.alice);
    expect(await heldFor(f, f.users.alice)).toBe(true);
    expect(await heldFor(f, f.users.bob)).toBe(false);
  });

  it("does not hold a user without an account of their own for another user's limit", async () => {
    const f = await seedCompany(["alice", "carol"]);
    const alice = await account(f, f.users.alice);
    await quotaOn(f, alice, f.users.alice);
    expect(await heldFor(f, f.users.carol)).toBe(false);
  });

  it("holds a user whose own limited account cannot be selected, and only for that account", async () => {
    const f = await seedCompany(["alice", "dave"]);
    const alice = await account(f, f.users.alice);
    const dave = await account(f, f.users.dave, "needs_attention");
    await quotaOn(f, alice, f.users.alice);
    expect(await heldFor(f, f.users.dave)).toBe(false);
    await quotaOn(f, dave, f.users.dave);
    expect(await heldFor(f, f.users.dave)).toBe(true);
  });

  it("holds every user when the agent runs on one shared account", async () => {
    const f = await seedCompany(["alice", "carol"]);
    const shared = await account(f, null);
    await db.update(agents).set({ runtimeConfig: { aiConnection: { mode: "shared", provider: "google", method: "subscription", ...shared } } })
      .where(eq(agents.id, f.agentId));
    await quotaOn(f, shared, f.users.alice);
    expect(await heldFor(f, f.users.alice)).toBe(true);
    expect(await heldFor(f, f.users.carol)).toBe(true);
  });
});
