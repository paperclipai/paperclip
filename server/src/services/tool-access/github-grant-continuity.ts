import { readConnectionGrantCredentialStates } from "../connection-credentials.js";
import { randomUUID } from "node:crypto";
import { notifyGitHubCredentialChange } from "../github-connection-notifications.js";
import type { ActorInfo } from "./types.js";
import { loadGitHubGrantMetadata } from "./github-access-discovery.js";
import { measureRunPhase } from "../execution-preparation-timing.js";
import { measureRunTransaction } from "../execution-transaction-timing.js";
import { and, eq, sql, or, isNull, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { companies, connectionGrants, toolConnections } from "@paperclipai/db";
import { conflict, HttpError, notFound, unprocessable } from "../../errors.js";
import { isPaperclipCloudConnectorStrategy, PaperclipCloudConnectorError, type PaperclipCloudConnector } from "../paperclip-cloud-connector.js";

import type { createOAuthGrantRefresh } from "./oauth/grant-refresh.js";
import type { OAuthCredentialStore } from "./oauth/credential-store.js";
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

type RecordGitHubAttempt = (grant: typeof connectionGrants.$inferSelect) => void;

type GitHubContinuityDependencies = {
  now: () => Date;
  currentCloudConnector: () => PaperclipCloudConnector | null;
  refreshOAuthGrantCredentials: ReturnType<typeof createOAuthGrantRefresh>;
  resolveOAuthGrantSecret: OAuthCredentialStore["resolveOAuthGrantSecret"];
};

export function createGitHubGrantContinuity(db: Db, { now, currentCloudConnector, refreshOAuthGrantCredentials, resolveOAuthGrantSecret }: GitHubContinuityDependencies) {
  async function refreshManagedGitHubGrantAccess(
    connection: typeof toolConnections.$inferSelect,
    initialGrant: typeof connectionGrants.$inferSelect,
    actor?: ActorInfo,
    recordAttempt?: RecordGitHubAttempt,
  ) {
    await actor?.managementContext?.reauthorize();
    return measureRunPhase("connectors.github.refresh", async () => {
      try {
        return await refreshManagedGitHubGrantAccessOnce(
          connection,
          initialGrant,
          actor,
          recordAttempt,
        );
      } catch (error) {
        if (
          !(error instanceof HttpError) ||
          asRecord(error.details).code !== "github_access_changed"
        )
          throw error;
        const [current] = await measureRunPhase("connectors.github.grants", () => db
          .select()
          .from(connectionGrants)
          .where(
            and(
              eq(connectionGrants.id, initialGrant.id),
              eq(connectionGrants.companyId, connection.companyId),
              eq(connectionGrants.connectionId, connection.id),
            ),
          ));
        if (!current || current.status !== "active") throw error;
        return refreshManagedGitHubGrantAccessOnce(connection, current, actor, recordAttempt);
      }
    });
  }

  async function refreshManagedGitHubGrantAccessOnce(
    connection: typeof toolConnections.$inferSelect,
    initialGrant: typeof connectionGrants.$inferSelect,
    actor?: ActorInfo,
    recordAttempt?: RecordGitHubAttempt,
  ) {
    await actor?.managementContext?.reauthorize();
    let grant = await measureRunPhase("connectors.github.credentials", () => refreshOAuthGrantCredentials({
      companyId: connection.companyId,
      connectionId: connection.id,
      grantId: initialGrant.id,
      actor,
    }));
    recordAttempt?.(grant);
    const resolveAccessToken = async () => measureRunPhase("connectors.github.credentials", async () => {
      const accessRef = grant.credentialSecretRefs.find(
        (ref) => ref.configPath === "oauth.access_token",
      );
      if (!accessRef)
        throw unprocessable("GitHub authorization must be reconnected", {
          code: "oauth_reauthorization_required",
        });
      return (
        await resolveOAuthGrantSecret(
          connection,
          grant,
          accessRef,
          actor,
          undefined,
        )
      ).value;
    });
    let metadata;
    let accessToken = await resolveAccessToken();
    try {
      metadata = await measureRunPhase("connectors.github.repositories", () => loadGitHubGrantMetadata(
        accessToken,
        fetch,
        grant.providerTenant?.github?.appSlug,
      ));
    } catch (error) {
      const providerCode =
        error instanceof HttpError ? asRecord(error.details).code : null;
      if (providerCode !== "oauth_reauthorization_required") throw error;
      // GitHub may invalidate an access token before its recorded expiry. If an
      // expiring token pair exists, rotate it once under the same durable lease
      // and CAS path, then repeat /user before surfacing reconnect-required.
      grant = await measureRunPhase("connectors.github.credentials", () => refreshOAuthGrantCredentials({
        companyId: connection.companyId,
        connectionId: connection.id,
        grantId: initialGrant.id,
        forceRefresh: true,
        actor,
      }));
      recordAttempt?.(grant);
      accessToken = await resolveAccessToken();
      try {
        metadata = await measureRunPhase("connectors.github.repositories", () => loadGitHubGrantMetadata(
          accessToken,
          fetch,
          grant.providerTenant?.github?.appSlug,
        ));
      } catch (retryError) {
        const retryCode =
          retryError instanceof HttpError
            ? asRecord(retryError.details).code
            : null;
        if (retryCode === "oauth_reauthorization_required") {
          await measureRunPhase("connectors.github.grant_write", () => db
            .update(connectionGrants)
            .set({ status: "needs_reauthorization", updatedAt: now() })
            .where(
              and(
                eq(connectionGrants.id, grant.id),
                eq(connectionGrants.companyId, grant.companyId),
              ),
            ));
        }
        throw retryError;
      }
    }
    const { updated } = await measureRunTransaction(db, "connectors.github.refresh", async (tx) => {
      await notifyGitHubCredentialChange(tx, connection);
      const [currentGrant] = await measureRunPhase("connectors.github.grant_lock", () => tx
        .select()
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.id, grant.id),
            eq(connectionGrants.companyId, grant.companyId),
          ),
        )
        .for("update")
        .limit(1));
      if (!currentGrant || currentGrant.status === "revoked")
        throw notFound("GitHub authorization not found");
      const previousGitHub = currentGrant.providerTenant?.github;
      const initialGitHub = grant.providerTenant?.github;
      // Access revisions fence installation changes, and refresh timestamps also
      // protect legacy snapshots. Ordinary PR webhooks update delivery health
      // without changing access; preserve that health when this refresh commits.
      if (
        previousGitHub?.accessRevision !== initialGitHub?.accessRevision ||
        previousGitHub?.lastAccessRefreshAt !==
          initialGitHub?.lastAccessRefreshAt
      ) {
        throw conflict("GitHub access changed during refresh. Try again.", {
          code: "github_access_changed",
        });
      }
      const providerTenant = {
        ...(currentGrant.providerTenant ?? {}),
        github: {
          ...metadata,
          bindingSync: {
            id: randomUUID(),
            removeInstallationIds: [...new Set([
              ...(previousGitHub?.bindingSync?.removeInstallationIds ?? []),
              ...(previousGitHub?.installationIds ?? []),
            ])].filter(id => !metadata.installationIds.includes(id)),
          },
          ...(previousGitHub?.lastWebhookAt
            ? { lastWebhookAt: previousGitHub.lastWebhookAt }
            : {}),
          webhookHealth:
            previousGitHub?.webhookHealth ?? metadata.webhookHealth,
        },
      };
      const [updated] = await measureRunPhase("connectors.github.grant_write", () => tx
        .update(connectionGrants)
        .set({
          providerTenant,
          status: "active",
          updatedAt: now(),
        })
        .where(
          and(
            eq(connectionGrants.id, grant.id),
            eq(connectionGrants.companyId, grant.companyId),
          ),
        )
        .returning());
      if (!updated) throw notFound("GitHub authorization not found");
      return { updated, previousGitHub };
    });

    return measureRunPhase("connectors.github.webhooks", () => syncGitHubGrantBindings(connection, updated, actor, accessToken, recordAttempt));
  }

  async function syncGitHubGrantBindings(
    connection: typeof toolConnections.$inferSelect,
    initialGrant: typeof connectionGrants.$inferSelect,
    actor?: ActorInfo,
    accessToken?: string,
    recordAttempt?: RecordGitHubAttempt,
  ) {
    await actor?.managementContext?.reauthorize();
    const cloudConnector = currentCloudConnector();
    if (!initialGrant.providerTenant?.github?.bindingSync) return initialGrant;
    if (!cloudConnector) throw unprocessable("GitHub webhook delivery is not configured");
    const grant = accessToken || initialGrant.providerTenant.github.installationIds.length === 0 ? initialGrant : await refreshOAuthGrantCredentials({
      companyId: connection.companyId, connectionId: connection.id, grantId: initialGrant.id, actor,
    });
    const accessRef = grant.credentialSecretRefs.find(ref => ref.configPath === "oauth.access_token");
    if (!accessRef && grant.providerTenant?.github?.installationIds.length) throw unprocessable("GitHub authorization must be reconnected", { code: "oauth_reauthorization_required" });
    const token = accessToken ?? (accessRef ? (await resolveOAuthGrantSecret(connection, grant, accessRef, actor, undefined)).value : undefined);
    // Serialize external binding changes with grant/connection lifecycle writes.
    // Requests occur only for saved debt; no idle lock or connection is retained.
    return db.transaction(async tx => {
      // Company deletion locks its parent before cascading to grants/connections.
      // Keep that order while retaining admission through the external handoff.
      const [company] = await tx.select({ status: companies.status }).from(companies)
        .where(eq(companies.id, connection.companyId)).for("share").limit(1);
      if (!company) return grant;
      const [current] = await tx.select().from(connectionGrants).where(and(
        eq(connectionGrants.id, grant.id), eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id),
      )).for("update").limit(1);
      if (!current || current.status !== "active") return current ?? grant;
      const [liveConnection] = await tx.select().from(toolConnections).where(and(
        eq(toolConnections.id, connection.id), eq(toolConnections.companyId, connection.companyId),
      )).for("update").limit(1);
      if (!liveConnection || liveConnection.status !== "active" || !liveConnection.enabled) return current;
      if (company.status !== "active") return current;
      const github = current.providerTenant?.github;
      if (!github?.bindingSync || github.bindingSync.id !== grant.providerTenant?.github?.bindingSync?.id) return current;
      const subject = current.kind === "agent" && current.subjectAgentId ? `agent:${current.subjectAgentId}`
        : current.kind === "user" ? current.subjectUserId : null;
      if (!subject) throw unprocessable("GitHub webhook subject is unavailable");
      recordAttempt?.(grant);
      const changes = [
        ...github.installationIds.map(installationId => ({ installationId, active: true as const })),
        ...github.bindingSync.removeInstallationIds.filter(id => !github.installationIds.includes(id))
          .map(installationId => ({ installationId, active: false as const })),
      ];
      for (let offset = 0; offset < changes.length; offset += 4) {
        const outcomes = await Promise.allSettled(changes.slice(offset, offset + 4).map(change => cloudConnector.setWebhookBinding({
          subject, companyId: connection.companyId, id: `${current.id}_${change.installationId}`,
          installationId: change.installationId, connectionId: connection.id, grantId: current.id,
          ...change.active ? { active: true, accessToken: token! } : { active: false },
        })));
        const failure = outcomes.find(outcome => outcome.status === "rejected");
        if (failure?.status === "rejected") throw failure.reason;
      }
      await notifyGitHubCredentialChange(tx, connection);
      const [settled] = await tx.update(connectionGrants).set({
        providerTenant: sql`${connectionGrants.providerTenant} #- '{github,bindingSync}' #- '{github,continuityRetry}'`,
        updatedAt: now(),
      }).where(and(eq(connectionGrants.id, current.id), eq(connectionGrants.companyId, connection.companyId))).returning();
      return settled!;
    });
  }

  async function retainRetry(connection: typeof toolConnections.$inferSelect, grantId: string, attemptedRevision: string, error?: unknown, minimumMs = 30_000) {
    await db.transaction(async tx => {
      const [current] = await tx.select().from(connectionGrants).where(and(
        eq(connectionGrants.id, grantId), eq(connectionGrants.companyId, connection.companyId),
        eq(connectionGrants.connectionId, connection.id), eq(connectionGrants.status, "active"),
      )).for("update").limit(1);
      // Backoff belongs to the attempted credential/installation revision.
      if (!current?.providerTenant?.github || githubContinuityRevision(current) !== attemptedRevision) return;
      const attempts = Math.min(16, (current.providerTenant.github.continuityRetry?.attempts ?? 0) + 1);
      const advised = error instanceof PaperclipCloudConnectorError ? error.retryAt
        : error instanceof HttpError ? asRecord(error.details).retryAt : undefined;
      const at = new Date(Math.max(now().getTime() + Math.max(minimumMs, Math.min(60 * 60_000, 30_000 * 2 ** Math.min(attempts - 1, 7))),
        typeof advised === "number" ? advised : 0)).toISOString();
      await notifyGitHubCredentialChange(tx, connection);
      await tx.update(connectionGrants).set({
        providerTenant: sql`jsonb_set(${connectionGrants.providerTenant}, '{github,continuityRetry}', ${JSON.stringify({
          at, attempts, revision: attemptedRevision,
        })}::jsonb)`,
        updatedAt: now(),
      }).where(and(eq(connectionGrants.id, current.id), eq(connectionGrants.companyId, connection.companyId)));
    });
  }

  async function continuityRows(companyId?: string) {
    return db
      .select({ grant: connectionGrants, connection: toolConnections })
      .from(connectionGrants)
      .innerJoin(toolConnections, and(
        eq(toolConnections.id, connectionGrants.connectionId),
        eq(toolConnections.companyId, connectionGrants.companyId),
      ))
      .where(and(
        companyId ? eq(connectionGrants.companyId, companyId) : undefined,
        eq(connectionGrants.status, "active"),
        eq(toolConnections.status, "active"),
        eq(toolConnections.enabled, true),
        sql`${toolConnections.config}->>'sourceTemplateKey' = 'github'`,
        sql`${toolConnections.config}->'oauth'->>'connectorProfile' = 'github.code'`,
        sql`${connectionGrants.providerTenant}->'github' is not null`,
        sql`exists (select 1 from companies where id = ${connectionGrants.companyId} and status = 'active')`,
      ));
  }

  async function nextGitHubConnectionContinuityAt(companyId?: string): Promise<number | null> {
    const deadlines = (await continuityRows(companyId)).flatMap(({ grant, connection }) => {
      const deadline = githubGrantContinuityDeadline(connection, grant);
      return deadline === null ? [] : [deadline];
    });
    return deadlines.length ? Math.min(...deadlines) : null;
  }

  async function sweepGitHubConnectionContinuity(companyId?: string) {
    const rows = await continuityRows(companyId);
    const due = rows.filter(({ grant, connection }) => {
      const deadline = githubGrantContinuityDeadline(connection, grant);
      return deadline !== null && deadline <= now().getTime();
    });
    let refreshed = 0;
    let failed = 0;
    for (const row of due) {
      let attemptedRevision = githubContinuityRevision(row.grant);
      const recordAttempt: RecordGitHubAttempt = grant => { attemptedRevision = githubContinuityRevision(grant); };
      try {
        const actor: ActorInfo = { actorType: "system", actorId: "github-connection-continuity" };
        const updated = row.grant.providerTenant?.github?.bindingSync
          ? await syncGitHubGrantBindings(row.connection, row.grant, actor, undefined, recordAttempt)
          : await refreshManagedGitHubGrantAccess(row.connection, row.grant, actor, recordAttempt);
        // A successful provider response can still leave an unchanged/short-lived
        // credential due. Retain that obligation with bounded durable backoff.
        const next = githubGrantContinuityDeadline(row.connection, updated);
        if (next !== null && next <= now().getTime()) await retainRetry(row.connection, updated.id, githubContinuityRevision(updated), undefined, 60 * 60_000);
        refreshed += 1;
      } catch (error) {
        await retainRetry(row.connection, row.grant.id, attemptedRevision, error);
        failed += 1;
      }
    }
    return { checked: rows.length, due: due.length, refreshed, failed };
  }
  async function githubConnectionContinuitySchedule(companyId?: string) {
    const schedule = new Map<string, number>();
    for (const { grant, connection } of await continuityRows(companyId)) {
      const dueAt = githubGrantContinuityDeadline(connection, grant);
      if (dueAt !== null) schedule.set(connection.companyId, Math.min(schedule.get(connection.companyId) ?? Infinity, dueAt));
    }
    return [...schedule].map(([companyId, dueAt]) => ({ id: companyId, companyId, dueAt }));
  }
  return { githubConnectionContinuitySchedule, refreshManagedGitHubGrantAccess, syncGitHubGrantBindings, sweepGitHubConnectionContinuity, nextGitHubConnectionContinuityAt };
}

/** Credential expiry and provider continuity are obligations, not a scan cadence. */
export function githubGrantContinuityDeadline(
  connection: Pick<typeof toolConnections.$inferSelect, "config">,
  grant: Pick<typeof connectionGrants.$inferSelect, "providerTenant">,
): number | null {
  const config = asRecord(connection.config);
  if (config.sourceTemplateKey !== "github" || asRecord(config.oauth).connectorProfile !== "github.code"
    || !grant.providerTenant?.github) return null;
  const oauth = grant.providerTenant.oauth;
  const access = grant.providerTenant.github;
  const parsed = (value: string | undefined) => {
    const time = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(time) ? time : 0;
  };
  const continuityMs = 30 * 24 * 60 * 60_000;
  const credentialDeadline = typeof oauth?.accessTokenExpiresAt === "string"
    ? Math.min(parsed(oauth.accessTokenExpiresAt) - 60 * 60_000, oauth.refreshedAt ? parsed(oauth.refreshedAt) + continuityMs : 0)
    : access.lastAccessRefreshAt ? parsed(access.lastAccessRefreshAt) + continuityMs : 0;
  const deadline = access.bindingSync ? 0 : credentialDeadline;
  return access.continuityRetry?.revision === githubContinuityRevision(grant)
    ? Math.max(deadline, parsed(access.continuityRetry.at)) : deadline;
}

export function githubContinuityRevision(grant: Pick<typeof connectionGrants.$inferSelect, "providerTenant">): string {
  return JSON.stringify([grant.providerTenant?.oauth?.accessTokenExpiresAt, grant.providerTenant?.oauth?.refreshedAt,
    grant.providerTenant?.github?.lastAccessRefreshAt, grant.providerTenant?.github?.bindingSync?.id]);
}

export async function readIdleGitHubGrantContinuity(tx: Pick<Db, "select">, now: number,
  checkBudget: () => void = () => {}) {
  const rows = await tx.select({ grant: connectionGrants, connection: toolConnections, companyStatus: companies.status })
    .from(connectionGrants).leftJoin(toolConnections, eq(toolConnections.id, connectionGrants.connectionId))
    .leftJoin(companies, eq(companies.id, connectionGrants.companyId))
    .where(and(eq(connectionGrants.status, "active"), sql`${connectionGrants.providerTenant}->'github' IS NOT NULL`,
      or(isNull(toolConnections.id), ne(toolConnections.companyId, connectionGrants.companyId),
        sql`${toolConnections.config}->>'sourceTemplateKey' = 'github'`)))
    .orderBy(connectionGrants.id).limit(10_001);
  const proof = projectIdleGitHubGrantContinuity(rows, now, checkBudget);
  if (proof.blocked) return proof;
  const eligible = new Set(proof.connectionIds);
  const inputs = rows.flatMap(row => row.connection && eligible.has(row.connection.id)
    && managedGitHubContinuityConnection(row.connection) === "managed" ? [{ connection: row.connection, grant: row.grant }] : []);
  const credentials = await readConnectionGrantCredentialStates(tx, inputs, checkBudget);
  if (!credentials) return { ...proof, blocked: true, connectionIds: [], deadlines: [] };
  return { ...proof, state: [rows, [...credentials]] };
}
function managedGitHubContinuityConnection(connection: typeof toolConnections.$inferSelect): "managed" | "unrelated" | "invalid" {
  const config = asRecord(connection.config), oauth = asRecord(config.oauth);
  if (config.sourceTemplateKey !== "github" || connection.authKind !== "oauth"
    || connection.credentialSource === "vercel_connect") return "unrelated";
  if (typeof oauth.connectorProfile !== "string" || !oauth.connectorProfile) return "invalid";
  if (oauth.connectorProfile !== "github.code") return "unrelated";
  return isPaperclipCloudConnectorStrategy(oauth.strategy) ? "managed" : "invalid";
}
export function projectIdleGitHubGrantContinuity(rows: {
  grant: typeof connectionGrants.$inferSelect;
  connection: typeof toolConnections.$inferSelect | null;
  companyStatus: string | null;
}[], now: number, checkBudget: () => void = () => {}) {
  const deadlines: number[] = [];
  const connectionIds = new Set<string>();
  const blocked = () => ({ blocked: true, state: rows, deadlines: [], connectionIds: [] as string[] });
  if (rows.length > 10_000) return blocked();
  for (const { grant, connection, companyStatus } of rows) {
    checkBudget();
    if (!connection || connection.companyId !== grant.companyId || !companyStatus
      || !["active", "paused", "archived"].includes(companyStatus)
      || !["draft", "active", "disabled", "archived"].includes(connection.status)
      || !["oauth", "api_key", "none"].includes(connection.authKind)
      || !["paperclip_vault", "vercel_connect"].includes(connection.credentialSource)) return blocked();
    if (companyStatus !== "active" || connection.status !== "active" || !connection.enabled) continue;
    const ownership = managedGitHubContinuityConnection(connection);
    if (ownership === "invalid") return blocked();
    if (ownership === "unrelated") continue;
    if (grant.connectionId !== connection.id || (grant.kind === "user" ? !grant.subjectUserId
      : grant.kind === "agent" ? !grant.subjectAgentId : true)) return blocked();
    const oauth = asRecord(grant.providerTenant?.oauth);
    const github = grant.providerTenant?.github;
    if (!github || github.bindingSync || github.continuityRetry || oauth.refreshLease) return blocked();
    const deadline = githubGrantContinuityDeadline(connection, grant);
    if (deadline === null || !Number.isFinite(deadline) || deadline <= now) return blocked();
    if (!grant.credentialSecretRefs.some(ref => ref.configPath === "oauth.access_token")) return blocked();
    deadlines.push(deadline);
    connectionIds.add(connection.id);
  }
  return { blocked: false, state: rows, deadlines, connectionIds: [...connectionIds].sort() };
}
