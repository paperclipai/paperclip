import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents, companies, companyMemberships, createDb, heartbeatRuns,
  issueComments, issueRecoveryActions, issueThreadInteractions, issues,
} from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "@paperclipai/db/test-embedded-postgres";
import { heartbeatService } from "../services/heartbeat.js";
import { aiConnectionService } from "../services/ai-connections.js";
import { prepareManagedAiRuntime } from "../services/ai-connection-runtime.js";
import { executionFailureRetryCount } from "../services/execution-recovery-attempt.js";

const execute = vi.hoisted(() => vi.fn(async () => ({
  exitCode: 0, signal: null, timedOut: false, resultJson: {},
})));
vi.mock("../adapters/index.js", async () => ({
  ...await vi.importActual<typeof import("../adapters/index.js")>("../adapters/index.js"),
  getServerAdapter: () => ({ supportsLocalAgentJwt: false, execute }),
}));

describe("heartbeat AI subscription contention", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let heartbeat: ReturnType<typeof heartbeatService>;
  let home: string;

  beforeAll(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "paperclip-subscription-contention-"));
    vi.stubEnv("PAPERCLIP_HOME", home);
    vi.stubEnv("PAPERCLIP_INSTANCE_ID", "subscription-contention-tests");
    database = await startEmbeddedPostgresTestDatabase("paperclip-subscription-contention-db-");
    db = createDb(database.connectionString);
    heartbeat = heartbeatService(db);
  }, 90_000);
  afterAll(async () => {
    await heartbeat?.drainActiveRunExecutions();
    await database?.cleanup();
    vi.unstubAllEnvs();
    if (home) await rm(home, { recursive: true, force: true });
  });

  async function fixture() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const userId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Contention fixture", issuePrefix: "SUB", defaultResponsibleUserId: userId });
    await db.insert(companyMemberships).values({ companyId, principalId: userId, principalType: "user", status: "active", membershipRole: "member" });
    const binding = { provider: "openai", method: "subscription", mode: "responsible_user" } as const;
    await db.insert(agents).values({ id: agentId, companyId, name: "CEO", adapterType: "codex_local", adapterConfig: { cwd: home }, runtimeConfig: { aiConnection: binding, heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 20 } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Child task", status: "todo", assigneeAgentId: agentId, responsibleUserId: userId });
    const account = await aiConnectionService(db).save(companyId, userId, { provider: "openai", method: "subscription", ownership: "personal", name: "Fixture subscription", loginSessionId: "fixture", allAgents: true, agentIds: [] }, JSON.stringify({ tokens: { access_token: "fixture-access", refresh_token: "fixture-refresh", id_token: "fixture-id", account_id: "fixture-account" } }));
    const parent = await prepareManagedAiRuntime(db, { companyId, agentId, responsibleUserId: userId, adapterType: "codex_local", binding, config: { cwd: home } });
    return { companyId, agentId, issueId, userId, account, parent };
  }

  it("defers a child without a reconnect blocker and executes after its parent's subscription is released", async () => {
    const f = await fixture();
    try {
      const run = await heartbeat.invoke(f.agentId, "assignment", { issueId: f.issueId, wakeReason: "issue_assigned" }, "system");
      expect(run).not.toBeNull();
      await heartbeat.drainActiveRunExecutions();
      const deferred = await heartbeat.getRun(run!.id);
      expect(deferred).toMatchObject({ status: "cancelled", errorCode: "ai_connection_busy" });
      expect(execute).not.toHaveBeenCalled();
      const [retry] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, run!.id));
      expect(retry).toMatchObject({ status: "scheduled_retry", scheduledRetryReason: "ai_connection_busy" });
      expect(executionFailureRetryCount(retry)).toBe(0);
      const [issue] = await db.select().from(issues).where(eq(issues.id, f.issueId));
      expect(issue.status).not.toBe("blocked");
      expect(issue.executionRunId).toBe(retry.id);
      expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.companyId, f.companyId))).toHaveLength(0);
      expect(await db.select().from(issueThreadInteractions).where(eq(issueThreadInteractions.companyId, f.companyId))).toHaveLength(0);
      expect(await db.select().from(issueComments).where(eq(issueComments.issueId, f.issueId))).toHaveLength(0);
      await f.parent.cleanup();
      await heartbeat.promoteDueScheduledRetries(new Date(retry.scheduledRetryAt!.getTime() + 1));
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const completed = await heartbeat.getRun(retry.id);
      expect(completed).toMatchObject({ status: "succeeded" });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(completed?.contextSnapshot?.aiConnection).toMatchObject({ grantId: f.account.grantId, identity: f.parent.identity });
    } finally {
      await f.parent.cleanup();
    }
  });
});
