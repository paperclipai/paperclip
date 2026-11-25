import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, authUsers, companies, companyMemberships, createDb, heartbeatRuns, issues } from "@paperclipai/db";
import { createProviderLimitWait } from "../services/heartbeat/provider-limit-wait.js";
import { runProviderQuotaScope } from "../services/native-runtime/native-startup-retry.js";
import { recoveryPostgresSupport, startRecoveryPostgres } from "./helpers/recovery-postgres.js";

const describePostgres = recoveryPostgresSupport.supported ? describe : describe.skip;
if (!recoveryPostgresSupport.supported) console.warn(`Skipping swarm provider limit tests: ${recoveryPostgresSupport.reason}`);

/** Google's Antigravity CLI bills swarms to its own quota pool, so a swarm's limit holds only swarms. */
describePostgres("quota-scoped provider limit holds for /swarm", () => {
  let temporary: Awaited<ReturnType<typeof startRecoveryPostgres>>;
  let db: ReturnType<typeof createDb>;
  const SWARM = { providerQuotaScope: "antigravity_cli" };

  beforeAll(async () => {
    temporary = await startRecoveryPostgres("swarm-provider-limit-");
    db = createDb(temporary.connectionString);
  }, 60_000);

  afterAll(async () => {
    await db?.$client.end({ timeout: 0 });
    await temporary?.cleanup();
  });

  async function seed(prior: Array<Partial<typeof heartbeatRuns.$inferInsert>>) {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const userId = `limit-user-${companyId}`;
    await db.insert(authUsers).values({ id: userId, name: "Limit user", email: `${userId}@example.test`, createdAt: new Date(), updatedAt: new Date() });
    await db.insert(companies).values({ id: companyId, name: "Provider limit fixture", issuePrefix: `L${companyId.slice(0, 6)}` });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Limited agent", adapterType: "codex_local", status: "idle", adapterConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Triage the next alert", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId, issueNumber: 1 });
    for (const values of prior) {
      await db.insert(heartbeatRuns).values({ companyId, agentId, invocationSource: "automation", triggerDetail: "system", ...values });
    }
    return { companyId, agentId, issueId };
  }

  const rateLimited = (minutesAgo: number, overrides: Record<string, unknown> = {}) => ({
    status: "failed",
    startedAt: new Date(Date.now() - (minutesAgo + 2) * 60_000),
    finishedAt: new Date(Date.now() - minutesAgo * 60_000),
    errorCode: "provider_session_open_rejected",
    resultJson: { providerFailure: { schema: "paperclip.provider-failure.v1", provider: "anthropic", phase: "startup",
      category: "rate_limit", httpStatus: 429, retryability: "unknown",
      message: "API error: 429 This request would exceed your account's rate limit. Please try again later", ...overrides } },
  });
  // The live swarm refusal: Google's CLI out of quota while the same account's ordinary route answered.
  const swarmLimited = (minutesAgo: number) => ({ ...rateLimited(minutesAgo, {
    provider: "antigravity", phase: "turn", message: "Google refused the swarm: this account is out of quota for now. Try again later." }),
  errorCode: "native_provider_usage_limit" });

  async function defer(f: { companyId: string; agentId: string; issueId: string }, scope: string | null) {
    const [agent] = await db.select().from(agents).where(eq(agents.id, f.agentId));
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.companyId, agentId: f.agentId, status: "running",
      invocationSource: "automation", triggerDetail: "system", contextSnapshot: { issueId: f.issueId } }).returning();
    const deps = {
      setRunStatusIfRunning: vi.fn(async () => ({ updated: true, run: { ...run, status: "cancelled" } })),
      setWakeupStatus: vi.fn(async () => undefined),
      appendRunEvent: vi.fn(async () => undefined),
      scheduleBoundedRetryForRun: vi.fn(async () => ({ outcome: "scheduled" })),
      releaseIssueExecutionAndPromote: vi.fn(async () => undefined),
      finalizeAgentStatus: vi.fn(async () => undefined),
      providerQuotaScope: vi.fn(async () => scope),
    };
    const deferred = await createProviderLimitWait(db, deps as never)
      .deferRunForProviderLimit(run, agent, { resumingAdmittedRun: false, conversation: false });
    return { deferred, deps };
  }

  it("lets ordinary work run after a swarm hit the CLI's quota", async () => {
    const f = await seed([{ ...swarmLimited(5), contextSnapshot: SWARM }]);
    expect((await defer(f, null)).deferred).toBe(false);
  });

  it("holds the next swarm after a swarm hit the CLI's quota, in plain words", async () => {
    const f = await seed([{ ...swarmLimited(5), contextSnapshot: SWARM }]);
    const { deferred, deps } = await defer(f, "antigravity_cli");
    expect(deferred).toBe(true);
    const [, , patch] = deps.setRunStatusIfRunning.mock.calls[0] as unknown as [string, string, { error: string; resultJson: Record<string, unknown> }];
    expect(patch.error).toMatch(/^Swarms are out of quota for now\. Paperclip will try again after .+; other work on this agent continues\.$/);
    expect(patch.resultJson.providerLimitWait).toMatchObject({ quotaScope: "antigravity_cli" });
    // A later successful swarm clears it; an ordinary success does not.
    const ordinaryOk = await seed([{ ...swarmLimited(10), contextSnapshot: SWARM },
      { status: "succeeded", startedAt: new Date(Date.now() - 3 * 60_000), finishedAt: new Date(Date.now() - 2 * 60_000) }]);
    expect((await defer(ordinaryOk, "antigravity_cli")).deferred).toBe(true);
    const swarmOk = await seed([{ ...swarmLimited(10), contextSnapshot: SWARM },
      { status: "succeeded", startedAt: new Date(Date.now() - 3 * 60_000), finishedAt: new Date(Date.now() - 2 * 60_000), contextSnapshot: SWARM }]);
    expect((await defer(swarmOk, "antigravity_cli")).deferred).toBe(false);
  });

  it("does not hold a swarm for an ordinary-route limit, and old unscoped evidence still holds ordinary work", async () => {
    const f = await seed([rateLimited(5)]);
    expect((await defer(f, "antigravity_cli")).deferred).toBe(false);
    const { deferred, deps } = await defer(await seed([rateLimited(5)]), null);
    expect(deferred).toBe(true);
    expect((deps.setRunStatusIfRunning.mock.calls[0] as unknown as [string, string, { error: string }])[2].error).toMatch(/^This agent's provider usage limit/);
  });

  // Live: a Retry of a swarm started before scopes existed recorded unscoped
  // evidence, which then held this agent's ordinary work for an hour.
  it("scopes a swarm's limit by the route it executed, even when its context lacks the scope", async () => {
    const executedSwarm = { nativeExecutionInput: { provider: { kind: "acpx", agent: "antigravity", model: "gemini-3.8-flash-low", mode: "swarm" } } };
    expect(runProviderQuotaScope({ issueId: "issue" }, executedSwarm)).toBe("antigravity_cli");
    expect(runProviderQuotaScope({ issueId: "issue" }, { nativeExecutionInput: { provider: { kind: "acpx", agent: "antigravity" } } })).toBeNull();
    const oldSwarm = { ...swarmLimited(5), contextSnapshot: { antigravitySwarmCommentId: randomUUID() }, runnerProfileJson: executedSwarm };
    expect((await defer(await seed([oldSwarm]), null)).deferred).toBe(false);
    expect((await defer(await seed([oldSwarm]), "antigravity_cli")).deferred).toBe(true);
  });
});
