import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { chatConversations, chatDeliveries, chatEndpointResources, chatEndpoints, chatPublications, createDb, heartbeatRuns, issues, subscribeDatabaseWork } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolveExternalTestDatabaseUrl } from "./helpers/external-test-database.js";
import { createChatMilestoneFixtures } from "./helpers/chat-milestone-fixtures.js";
import { createDeliveryWorkCoordinator } from "../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../services/delivery-work-notifications.js";
import { chatRunMilestoneWork } from "../services/chat-run-milestone-work.js";
import { chatCredentialMutationLease } from "../services/chat-credential-mutation-lease.js";
import { createChatResourceReconciliation } from "../services/chat-channels/resource-reconciliation.js";
import { idleWorkSnapshot } from "../services/task-admission.js";

const external = resolveExternalTestDatabaseUrl("PAPERCLIP_MILESTONE_RESOURCE_TEST_DATABASE_URL");
const support = external ? { supported: true } : await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("chat milestones after resource recovery", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  let fixtures: ReturnType<typeof createChatMilestoneFixtures>;
  let f: Awaited<ReturnType<typeof fixtures.create>>;
  let coordinator: ReturnType<typeof createDeliveryWorkCoordinator> | undefined;
  const errors: unknown[] = [];
  beforeAll(async () => {
    if (!external) temporary = await startEmbeddedPostgresTestDatabase("chat-resource-milestones-");
    db = createDb(external ?? temporary!.connectionString, { idleTimeoutSeconds: 0, maxLifetimeSeconds: 0 });
    fixtures = createChatMilestoneFixtures(db);
  }, 60_000);
  beforeEach(async () => {
    errors.length = 0; f = await fixtures.create();
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"], shouldAdvanceTime: true });
  });
  afterEach(async () => {
    await coordinator?.stop(); coordinator = undefined; vi.useRealTimers(); vi.restoreAllMocks();
    await db.delete(chatDeliveries).where(eq(chatDeliveries.companyId, f.companyId));
    await fixtures.cleanup(); expect(errors).toEqual([]);
  });
  afterAll(async () => { await db?.$client.end({ timeout: 1 }); await temporary?.cleanup(); });
  async function flush() {
    await vi.waitFor(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      expect(idleWorkSnapshot().active).toBe(0); expect(coordinator!.nextWakeAt()).toBeNull();
    }, { timeout: 10_000 });
  }
  async function quiet() {
    const reads = vi.spyOn(db, "select"), writes = vi.spyOn(db, "transaction");
    try { await vi.advanceTimersByTimeAsync(120_000); expect(reads).not.toHaveBeenCalled(); expect(writes).not.toHaveBeenCalled(); }
    finally { reads.mockRestore(); writes.mockRestore(); }
  }
  const publications = () => db.select().from(chatPublications).where(eq(chatPublications.issueId, f.issueId));

  it.each(["inventory", "lifecycle", "github repository", "telegram migration"] as const)("wakes only reopened conversations after %s commits, preserving rollback and completed history", async path => {
    const provider = path === "github repository" ? "github" : path === "telegram migration" ? "telegram" : "slack";
    const resourceType = provider === "github" ? "repository" : provider === "telegram" ? "chat" : "channel";
    const providerResourceId = provider === "github" ? "owner/repo" : provider === "telegram" ? "-100222" : "recovered-channel";
    await db.update(chatEndpoints).set({ provider }).where(eq(chatEndpoints.id, f.endpointId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.agentId,
      responsibleUserId: f.userId, status: "failed", errorCode: "test_run_failed", updatedAt: new Date(),
      contextSnapshot: { issueId: f.issueId, source: `chat:${provider}`, endpointId: f.endpointId, wakeCommentId: f.commentId },
    });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, f.issueId));
    const [endpoint] = await db.select().from(chatEndpoints).where(eq(chatEndpoints.id, f.endpointId));
    const [resource] = await db.insert(chatEndpointResources).values({ companyId: f.companyId, endpointId: f.endpointId,
      type: resourceType, providerResourceId: provider === "telegram" ? "-111" : providerResourceId, label: "Recovered", availability: "unavailable", enabled: true,
    }).returning();
    await db.update(chatConversations).set({ resourceId: resource.id, state: "unavailable", ...(provider === "telegram" ? { externalConversationId: "telegram:-111", externalThreadId: "telegram:-111:42" } : {}) }).where(eq(chatConversations.id, f.conversationId));
    const completedId = randomUUID();
    await db.insert(chatConversations).values({ id: completedId, companyId: f.companyId, endpointId: f.endpointId,
      // Telegram migration intentionally rebinds all conversations on the old resource.
      // Unrelated completed history must remain passive.
      resourceId: provider === "telegram" ? null : resource.id, issueId: f.issueId, state: "completed", externalConversationId: completedId, externalThreadId: completedId, externalLabel: "History" });
    const [delivery] = await db.insert(chatDeliveries).values({ companyId: f.companyId, endpointId: f.endpointId,
      providerEventId: randomUUID(), deduplicationKey: randomUUID(), eventKind: "installation", normalizedEvent: {}, state: "processing", attempts: 1,
    }).returning();
    coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: () => true, canReconcile: () => true, onError: error => errors.push(error) });
    await chatRunMilestoneWork(db).register(coordinator, () => true).ready;
    await flush(); expect(await publications()).toEqual([]); await quiet();
    const withLease = chatCredentialMutationLease(db);
    const recover = (rollback: boolean, alreadyPublished = false) => withLease(endpoint, lease => db.transaction(async tx => {
      const resources = createChatResourceReconciliation(tx as unknown as typeof db, {
        endpointRecord: async () => ({ endpoint }), withCredentialMutationLease: withLease, runtimeGeneration: () => 0, maxErrorText: 1000,
      });
      if (path === "inventory") {
        await resources.reconcileProviderResourceRows(endpoint, { provider, resources: [{ type: resourceType, providerResourceId, label: "Recovered" }] }, lease);
      } else if (path === "github repository") {
        await resources.reconcileGitHubWebhookRepository(endpoint, { repository: { id: 123, full_name: providerResourceId, name: "repo", owner: { id: 321, login: "owner" } } }, lease);
      } else {
        await resources.applyProviderAvailability({ currentEndpoint: endpoint, credentialLease: lease, staleResourceEffect: false,
          claimed: delivery, candidate: { attempts: 0 }, effect: { kind: "resource", provider, providerEventId: delivery.providerEventId,
            providerResourceId, resourceType, ...(provider === "telegram" ? { previousProviderResourceId: "-111" } : {}), label: "Recovered", availability: "available" },
        });
      }
      // The owner used a nested transaction. Its savepoint release cannot publish.
      await vi.advanceTimersByTimeAsync(1000);
      expect(await publications()).toHaveLength(alreadyPublished ? 1 : 0);
      if (rollback) throw new Error("outer rollback");
    }));
    await expect(recover(true)).rejects.toThrow("outer rollback");
    await flush(); expect(await publications()).toEqual([]); await quiet();
    await recover(false); await flush();
    expect(await publications()).toEqual([expect.objectContaining({ idempotencyKey: `run:${runId}:failed:${f.endpointId}` })]);
    expect((await db.select().from(chatConversations).where(eq(chatConversations.id, completedId)))[0].state).toBe("completed");
    if (provider === "telegram") {
      expect((await db.select().from(chatConversations).where(eq(chatConversations.id, f.conversationId)))[0])
        .toMatchObject({ externalConversationId: "telegram:-100222", externalThreadId: "telegram:-100222:42", state: "active" });
    }
    await quiet();
    // Unchanged inventory must not turn a provider refresh into milestone polling.
    const notices: string[] = [];
    const unsubscribe = subscribeDatabaseWork(db, DELIVERY_QUEUES.chatRunMilestones, event => notices.push(event));
    try {
      await withLease(endpoint, lease => createChatResourceReconciliation(db, {
        endpointRecord: async () => ({ endpoint }), withCredentialMutationLease: withLease, runtimeGeneration: () => 0, maxErrorText: 1000,
      }).reconcileProviderResourceRows(endpoint, { provider, resources: [{ type: resourceType, providerResourceId, label: "Recovered" }] }, lease));
      expect(notices).toEqual([]);
      if (provider === "telegram") {
        // A duplicate migration has no old bindings left to reactivate.
        await recover(false, true);
        expect(notices).toEqual([]);
      }
    } finally { unsubscribe(); }
    await flush(); await quiet();
  });
});
