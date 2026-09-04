import {
  connectionEventDeliveries,
  connectionGrants,
  externalObjects,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import { logActivity } from "./activity-log.js";
import {
  createPaperclipCloudConnector,
  paperclipCloudConnectorConfigFromEnv,
  type PaperclipCloudConnector,
  type SealedConnectorEvents,
} from "./paperclip-cloud-connector.js";
import { issueThreadInteractionService } from "./issue-thread-interactions.js";

type LeasedEvent = SealedConnectorEvents["events"][number];
type GitHubBinding = {
  id: string;
  companyId: string;
  connectionId: string;
  grantId: string;
  subject: string;
  installationId: string;
  providerTenant: NonNullable<typeof connectionGrants.$inferSelect.providerTenant>;
};

export type GitHubConnectionEventPollResult = {
  leased: number;
  processed: number;
  duplicate: number;
  ignored: number;
  failed: number;
};

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function bindingRows(rows: Array<{
  grant: typeof connectionGrants.$inferSelect;
  connection: typeof toolConnections.$inferSelect;
}>): GitHubBinding[] {
  return rows.flatMap(({ grant, connection }) => {
    const config = record(connection.config);
    const oauth = record(config.oauth);
    if (config.sourceTemplateKey !== "github" || oauth.connectorProfile !== "github.code") return [];
    const github = grant.providerTenant?.github;
    if (!github || grant.status !== "active") return [];
    const subject = grant.kind === "agent" && grant.subjectAgentId
      ? `agent:${grant.subjectAgentId}`
      : grant.kind === "user" && grant.subjectUserId
        ? grant.subjectUserId
        : null;
    if (!subject) return [];
    return github.installationIds.map((installationId) => ({
      id: `${grant.id}_${installationId}`,
      companyId: grant.companyId,
      connectionId: connection.id,
      grantId: grant.id,
      subject,
      installationId,
      providerTenant: grant.providerTenant!,
    }));
  });
}

function githubSnapshotUpdate(payload: Record<string, unknown>) {
  const repository = stringValue(payload.repository);
  const number = positiveInteger(payload.number);
  if (!repository || !number) return null;
  const state = stringValue(payload.state) ?? "unknown";
  const merged = payload.merged === true;
  const [owner, repo, ...extra] = repository.split("/");
  if (!owner || !repo || extra.length > 0) return null;
  return {
    repository,
    owner,
    repo,
    number,
    externalId: `${repository}#pull/${number}`,
    state,
    merged,
    statusKey: merged ? "merged" : state === "closed" ? "closed" : "open",
    statusLabel: merged ? "Merged" : state === "closed" ? "Closed" : "Open",
    statusCategory: merged ? "succeeded" : state === "closed" ? "closed" : "open",
    statusTone: merged ? "success" : state === "closed" ? "muted" : "info",
    statusIconKey: merged ? "git-merge" : state === "closed" ? "x-circle" : "git-pull-request",
    data: {
      provider: "github",
      owner,
      repo,
      number,
      state,
      merged,
      ...(stringValue(payload.url) ? { url: stringValue(payload.url) } : {}),
      ...(stringValue(payload.mergedAt) ? { mergedAt: stringValue(payload.mergedAt) } : {}),
      ...(stringValue(payload.headRef) ? { headRef: stringValue(payload.headRef) } : {}),
      ...(stringValue(payload.headSha) ? { headSha: stringValue(payload.headSha) } : {}),
      ...(stringValue(payload.baseRef) ? { baseRef: stringValue(payload.baseRef) } : {}),
      ...(stringValue(payload.baseSha) ? { baseSha: stringValue(payload.baseSha) } : {}),
    },
    remoteVersion: stringValue(payload.updatedAt),
  } as const;
}

export function githubConnectionEventService(
  db: Db,
  options: {
    connector?: PaperclipCloudConnector;
    env?: NodeJS.ProcessEnv;
    now?: () => Date;
    wakeup?: NonNullable<Parameters<typeof issueThreadInteractionService>[1]>["wakeup"];
  } = {},
) {
  const now = options.now ?? (() => new Date());
  let nextPollAt = 0;
  let emptyPolls = 0;

  async function activeBindings() {
    const rows = await db.select({ grant: connectionGrants, connection: toolConnections })
      .from(connectionGrants)
      .innerJoin(toolConnections, and(
        eq(toolConnections.id, connectionGrants.connectionId),
        eq(toolConnections.companyId, connectionGrants.companyId),
      ))
      .where(and(
        eq(connectionGrants.status, "active"),
        eq(toolConnections.status, "active"),
        eq(toolConnections.enabled, true),
      ));
    return bindingRows(rows);
  }

  async function applyPullRequestEvent(companyId: string, event: LeasedEvent) {
    const snapshot = githubSnapshotUpdate(event.payload);
    if (!snapshot) return;
    const appliedAt = now();
    await db.update(externalObjects).set({
      statusKey: snapshot.statusKey,
      statusLabel: snapshot.statusLabel,
      statusCategory: snapshot.statusCategory,
      statusTone: snapshot.statusTone,
      statusIconKey: snapshot.statusIconKey,
      isTerminal: snapshot.merged || snapshot.state === "closed",
      data: sql`${externalObjects.data} || ${JSON.stringify(snapshot.data)}::jsonb`,
      remoteVersion: snapshot.remoteVersion,
      lastResolvedAt: appliedAt,
      lastChangedAt: appliedAt,
      nextRefreshAt: appliedAt,
      updatedAt: appliedAt,
    }).where(and(
      eq(externalObjects.companyId, companyId),
      eq(externalObjects.providerKey, "github"),
      eq(externalObjects.objectType, "pull_request"),
      sql`lower(${externalObjects.externalId}) = lower(${snapshot.externalId})`,
    ));
    if (snapshot.merged && event.action === "closed") {
      await issueThreadInteractionService(db, { wakeup: options.wakeup })
        .sweepMergedPullRequestConfirmations([{
          companyId,
          owner: snapshot.owner,
          repo: snapshot.repo,
          number: snapshot.number,
        }]);
    }
  }

  async function applyInstallationEvent(binding: GitHubBinding, event: LeasedEvent) {
    const github = binding.providerTenant.github!;
    const unavailable = event.event === "installation" && (event.action === "deleted" || event.action === "suspend");
    const installationIds = unavailable
      ? github.installationIds.filter((id) => id !== binding.installationId)
      : [...new Set([...github.installationIds, binding.installationId])];
    const added = Array.isArray(event.payload.repositoriesAdded) ? event.payload.repositoriesAdded.length : 0;
    const removed = Array.isArray(event.payload.repositoriesRemoved) ? event.payload.repositoriesRemoved.length : 0;
    const repositoryCount = Math.max(
      0,
      unavailable && installationIds.length === 0
        ? 0
        : unavailable
          ? github.repositoryCount
          : github.repositoryCount + added - removed,
    );
    const providerTenant = {
      ...binding.providerTenant,
      github: {
        ...github,
        installationIds,
        installationCount: installationIds.length,
        repositoryCount,
        repositorySelection: repositoryCount === 0 ? "none" as const : github.repositorySelection,
        lastWebhookAt: now().toISOString(),
        webhookHealth: unavailable ? "unhealthy" as const : "healthy" as const,
      },
    };
    await db.update(connectionGrants).set({ providerTenant, updatedAt: now() })
      .where(and(eq(connectionGrants.id, binding.grantId), eq(connectionGrants.companyId, binding.companyId)));
    await db.update(toolConnections).set({
      healthStatus: unavailable ? "failed" : "ok",
      healthMessage: unavailable
        ? "GitHub installation access was removed or suspended. Manage repository access on GitHub."
        : "GitHub installation and repository access are available.",
      healthCheckedAt: now(),
      lastHealthAt: now(),
      lastError: unavailable ? "GitHub installation unavailable" : null,
      updatedAt: now(),
    }).where(and(eq(toolConnections.id, binding.connectionId), eq(toolConnections.companyId, binding.companyId)));
  }

  async function processForCompany(companyId: string, bindings: GitHubBinding[], event: LeasedEvent) {
    const receiptAt = now();
    const [receipt] = await db.insert(connectionEventDeliveries).values({
      companyId,
      provider: event.provider,
      providerDeliveryId: event.id,
      event: event.event,
      action: event.action,
      installationId: event.installationId,
      repositoryId: event.repositoryId,
      normalizedPayload: event.payload,
      providerCreatedAt: new Date(event.createdAt),
      status: "received",
      attempts: 1,
      updatedAt: receiptAt,
    }).onConflictDoNothing().returning();
    if (!receipt) {
      const [existing] = await db.select().from(connectionEventDeliveries).where(and(
        eq(connectionEventDeliveries.companyId, companyId),
        eq(connectionEventDeliveries.provider, event.provider),
        eq(connectionEventDeliveries.providerDeliveryId, event.id),
      )).limit(1);
      if (existing?.status === "processed") return "duplicate" as const;
      await db.update(connectionEventDeliveries).set({
        status: "received",
        attempts: sql`${connectionEventDeliveries.attempts} + 1`,
        lastError: null,
        updatedAt: receiptAt,
      }).where(eq(connectionEventDeliveries.id, existing!.id));
    }
    try {
      if (event.event === "pull_request") await applyPullRequestEvent(companyId, event);
      if (event.event === "installation" || event.event === "installation_repositories") {
        for (const binding of bindings) await applyInstallationEvent(binding, event);
      } else {
        const touchedAt = now();
        for (const binding of bindings) {
          const github = binding.providerTenant.github;
          if (!github) continue;
          await db.update(connectionGrants).set({
            providerTenant: {
              ...binding.providerTenant,
              github: { ...github, lastWebhookAt: touchedAt.toISOString(), webhookHealth: "healthy" },
            },
            updatedAt: touchedAt,
          }).where(and(eq(connectionGrants.id, binding.grantId), eq(connectionGrants.companyId, companyId)));
        }
      }
      const finishedAt = now();
      await db.update(connectionEventDeliveries).set({
        status: "processed",
        processedAt: finishedAt,
        lastError: null,
        updatedAt: finishedAt,
      }).where(and(
        eq(connectionEventDeliveries.companyId, companyId),
        eq(connectionEventDeliveries.provider, event.provider),
        eq(connectionEventDeliveries.providerDeliveryId, event.id),
      ));
      await logActivity(db, {
        companyId,
        actorType: "system",
        actorId: "system:github-webhook",
        action: "tool_connection.webhook_processed",
        entityType: "tool_connection",
        entityId: bindings[0]!.connectionId,
        details: {
          provider: "github",
          event: event.event,
          action: event.action,
          deliveryId: event.id,
          installationId: event.installationId,
          repositoryId: event.repositoryId,
        },
      });
      return "processed" as const;
    } catch (error) {
      await db.update(connectionEventDeliveries).set({
        status: "failed",
        lastError: error instanceof Error ? error.message.slice(0, 500) : "GitHub event processing failed",
        updatedAt: now(),
      }).where(and(
        eq(connectionEventDeliveries.companyId, companyId),
        eq(connectionEventDeliveries.provider, event.provider),
        eq(connectionEventDeliveries.providerDeliveryId, event.id),
      ));
      throw error;
    }
  }

  return {
    async pollOnce(): Promise<GitHubConnectionEventPollResult> {
      if (now().getTime() < nextPollAt) {
        return { leased: 0, processed: 0, duplicate: 0, ignored: 0, failed: 0 };
      }
      const bindings = await activeBindings();
      if (bindings.length === 0) {
        nextPollAt = now().getTime() + 5 * 60_000;
        return { leased: 0, processed: 0, duplicate: 0, ignored: 0, failed: 0 };
      }
      const config = options.connector ? null : paperclipCloudConnectorConfigFromEnv(options.env);
      const connector = options.connector ?? (config ? createPaperclipCloudConnector({ config }) : null);
      if (!connector) {
        nextPollAt = now().getTime() + 5 * 60_000;
        return { leased: 0, processed: 0, duplicate: 0, ignored: 0, failed: 0 };
      }
      const first = bindings[0]!;
      const lease = await connector.leaseEvents({ subject: first.subject, companyId: first.companyId });
      if (!lease) {
        emptyPolls += 1;
        nextPollAt = now().getTime() + Math.min(5 * 60_000, 5_000 * (2 ** Math.min(emptyPolls, 6)));
        return { leased: 0, processed: 0, duplicate: 0, ignored: 0, failed: 0 };
      }
      emptyPolls = 0;
      nextPollAt = now().getTime() + 5_000;
      const result: GitHubConnectionEventPollResult = {
        leased: lease.events.length,
        processed: 0,
        duplicate: 0,
        ignored: 0,
        failed: 0,
      };
      const acknowledge: string[] = [];
      for (const event of lease.events) {
        const matched = bindings.filter((binding) => event.bindingIds.includes(binding.id));
        if (matched.length === 0) {
          result.ignored += 1;
          acknowledge.push(event.id);
          continue;
        }
        try {
          const companies = new Map<string, GitHubBinding[]>();
          for (const binding of matched) companies.set(binding.companyId, [...(companies.get(binding.companyId) ?? []), binding]);
          for (const [companyId, companyBindings] of companies) {
            const status = await processForCompany(companyId, companyBindings, event);
            result[status] += 1;
          }
          acknowledge.push(event.id);
          if (event.event === "installation" && (event.action === "deleted" || event.action === "suspend")) {
            await Promise.all(matched.map((binding) => connector.setWebhookBinding({
              subject: binding.subject,
              companyId: binding.companyId,
              id: binding.id,
              installationId: binding.installationId,
              connectionId: binding.connectionId,
              grantId: binding.grantId,
              active: false,
            })));
          }
        } catch {
          result.failed += 1;
        }
      }
      if (acknowledge.length > 0) {
        await connector.acknowledgeEvents({
          subject: first.subject,
          companyId: first.companyId,
          leaseId: lease.leaseId,
          deliveryIds: acknowledge,
        });
      }
      return result;
    },
  };
}
