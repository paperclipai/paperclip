import { randomUUID } from "node:crypto";
import { expect, vi } from "vitest";
import { agents, companies, companyMemberships, connectionGrants, databaseWorkPending, issueThreadInteractions, issues, toolApplications,
  toolCatalogEntries, toolConnectionInstalls, toolConnections, toolProfileBindings, toolProfiles, type Db } from "@paperclipai/db";
import { connectionIntentDeliveryService } from "../../services/connection-intent-delivery.js";
import { createDeliveryWorkCoordinator } from "../../services/delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "../../services/delivery-work-notifications.js";

const RETRY_MS = 600_000;

export async function seedPendingAccessRequest(db: Db, owner: string) {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Connections", issuePrefix: "CON", defaultResponsibleUserId: owner });
  await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: owner, status: "active", membershipRole: "member" });
  await db.insert(agents).values({ id: agentId, companyId, name: "Assignee", role: "engineer", adapterType: "claude_local", status: "idle", runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
  await db.insert(issues).values({ id: issueId, companyId, title: "Use Sentry", status: "in_review", assigneeAgentId: agentId, responsibleUserId: owner });
  const [app] = await db.insert(toolApplications).values({ companyId, applicationKey: "sentry", name: "Sentry", type: "mcp_http", status: "active", metadata: { sourceTemplateKey: "sentry" } }).returning();
  const [connection] = await db.insert(toolConnections).values({ companyId, applicationId: app!.id, name: "Existing Sentry", uid: "sentry", transport: "mcp_remote",
    authKind: "api_key", credentialPolicy: "per_user", status: "active", enabled: true, healthStatus: "ok", config: { sourceTemplateKey: "sentry" } }).returning();
  await db.insert(connectionGrants).values({ companyId, connectionId: connection!.id, kind: "user", subjectUserId: owner, status: "active" });
  await db.insert(toolConnectionInstalls).values({ companyId, connectionId: connection!.id, targetType: "agent", targetId: agentId });
  const [tool] = await db.insert(toolCatalogEntries).values({ companyId, connectionId: connection!.id, toolName: "sentry-read", name: "sentry-read", versionHash: "v1", status: "active", entryKind: "tool" }).returning();
  const [profile] = await db.insert(toolProfiles).values({ companyId, profileKey: "reads", name: "Reads", defaultAction: "deny", status: "active" }).returning();
  await db.insert(toolProfileBindings).values({ companyId, profileId: profile!.id, targetType: "agent", targetId: agentId });
  const accessRequest = { connectionId: connection!.id, connectionName: "Existing Sentry", tools: [{ catalogEntryId: tool!.id, toolName: tool!.toolName, versionHash: "v1", permission: "allowed" as const }] };
  const [intent] = await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "connection_intent", status: "pending", addresseeUserId: owner,
    requestedResolverPolicy: "human_only", effectiveResolverPolicy: "human_only", payload: { version: 1, serviceSlug: "sentry", serviceName: "Sentry",
      requestingAgentId: agentId, requestingAgentName: "Assignee", phase: "requested", accessRequest } }).returning();
  return { companyId, agentId, issueId, intent: intent!, connection: connection!, tool: tool! };
}

export async function startConnectionDelivery(db: Db, options: { canRun?: () => boolean; beforeSweep?: () => Promise<void> } = {}) {
  const startedAt = Date.now();
  const wakeup = vi.fn().mockResolvedValue(null);
  const service = connectionIntentDeliveryService(db, { wakeup });
  const errors: unknown[] = [];
  let sweeps = 0, accountedSweeps = 0;
  let running = false;
  const coordinator = createDeliveryWorkCoordinator({ owner: db, canRun: options.canRun ?? (() => true), onError: error => { errors.push(error); } });
  const worker = coordinator.register(DELIVERY_QUEUES.connection, { retryMs: RETRY_MS, nextRunAt: () => null, hasPending: async () => { try { return await service.hasPending(); } finally { running = false; } },
    run: async () => { sweeps += 1; running = true; try { await options.beforeSweep?.(); return await service.sweepPending(); } catch (error) { running = false; throw error; } } });
  const quiet = () => !running && !databaseWorkPending(db, DELIVERY_QUEUES.connection)
    && (coordinator.nextWakeAt() ?? Infinity) > Date.now() + RETRY_MS / 2;
  async function settle(minSweeps = 0) {
    const limit = Date.now() + 5_000;
    while (!quiet() || sweeps < minSweeps) {
      if (Date.now() > limit) throw new Error("Connection delivery did not settle");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    accountedSweeps = sweeps;
  }
  await worker.ready;
  await settle(1);
  return {
    wakeup, wake: worker.wake, settle,
    get sweeps() { return sweeps; },
    async stop() {
      await coordinator.stop();
      expect(sweeps).toBe(accountedSweeps);
      expect(errors).toEqual([]);
      expect(Date.now() - startedAt).toBeLessThan(RETRY_MS / 2);
    },
  };
}
