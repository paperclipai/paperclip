import { and, asc, eq, isNull, lte, ne, sql, type SQL } from "drizzle-orm";
import {
  companies,
  companySecrets,
  companySecretVersions,
  connectionGrants,
  googlePendingRevocations,
  toolAccessAuditEvents,
  toolConnections,
  type Db,
} from "@paperclipai/db";
import type { ManagedGoogleRevocationOutcome } from "@paperclipai/shared";
import { logger } from "../../../middleware/logger.js";
import { createLocalEncryptedCipher } from "../../../secrets/local-encrypted-provider.js";
import { logActivity } from "../../activity-log.js";
import { DELIVERY_QUEUES, notifyDeliveryWork } from "../../delivery-work-notifications.js";
import { isPaperclipCloudConnectorStrategy, PaperclipCloudConnectorError, type PaperclipCloudConnector } from "../../paperclip-cloud-connector.js";
import { managedConnectorConsentSubject, managedConnectorProfile } from "../oauth/client-settings.js";
import { oauthConfig } from "../oauth/metadata.js";
import { deleteGoogleContentWhenAccessEnds } from "./google-content-retention.js";

export const GOOGLE_REVOCATION_FIRST_RETRY_MS = 60_000;
export const GOOGLE_REVOCATION_MAX_RETRY_MS = 6 * 60 * 60_000;
export const GOOGLE_REVOCATION_LIFETIME_MS = 30 * 24 * 60 * 60_000;
export const GOOGLE_REVOCATION_LEASE_MS = 2 * 60_000;
const GOOGLE_REVOCATION_TIMEOUT_MS = 15_000;
const GOOGLE_REVOCATION_BATCH = 20;

export type GoogleRevocationReason = typeof googlePendingRevocations.$inferSelect["reason"];
type PendingRow = typeof googlePendingRevocations.$inferSelect;
type RetryResult = "ended" | "other_connections_remain" | "not_ended" | "gave_up";

const RETRYABLE_OUTCOMES: ReadonlySet<ManagedGoogleRevocationOutcome> = new Set([
  "provider_revocation_failed",
  "revocation_in_progress",
  "broker_unavailable",
  "broker_error",
  "unexpected_error",
]);

export function isRetryableGoogleRevocationOutcome(outcome: ManagedGoogleRevocationOutcome): boolean {
  return RETRYABLE_OUTCOMES.has(outcome);
}

export function googleRevocationRetryDelayMs(attempts: number): number {
  return Math.min(GOOGLE_REVOCATION_FIRST_RETRY_MS * 2 ** Math.max(0, attempts - 1), GOOGLE_REVOCATION_MAX_RETRY_MS);
}

export function googleRevocationOutcomeForError(error: unknown): ManagedGoogleRevocationOutcome {
  if (!(error instanceof PaperclipCloudConnectorError)) return "broker_error";
  if (error.code === "CONNECTOR_UNAVAILABLE") return "broker_unavailable";
  if (error.status === 409 && error.brokerReason === "REVOCATION_NOT_AVAILABLE") return "revocation_not_available";
  return "broker_error";
}

async function insertFromSecret(tx: Db, input: {
  companyId: string;
  connectionId: string | null;
  grantId: string | null;
  subject: string;
  profile: string;
  secretId: string;
  version: number;
  reason: GoogleRevocationReason;
  nextAttemptAt: Date;
  now: Date;
}): Promise<string | null> {
  const giveUpAt = new Date(input.now.getTime() + GOOGLE_REVOCATION_LIFETIME_MS);
  const [row] = await tx.execute<{ id: string }>(sql`
    insert into ${googlePendingRevocations} as pending
      (company_id, connection_id, grant_id, source_secret_id, subject, profile, token_material, token_sha256, reason, next_attempt_at, give_up_at, created_at, updated_at)
    select secret.company_id, ${input.connectionId}::uuid, ${input.grantId}::uuid, secret.id, ${input.subject}::text, ${input.profile}::text,
      version.material, version.value_sha256, ${input.reason}::text, ${input.nextAttemptAt.toISOString()}::timestamptz,
      ${giveUpAt.toISOString()}::timestamptz, ${input.now.toISOString()}::timestamptz, ${input.now.toISOString()}::timestamptz
    from ${companySecrets} secret
    join ${companySecretVersions} version on version.secret_id = secret.id and version.version = ${input.version}::integer
    where secret.id = ${input.secretId}::uuid and secret.company_id = ${input.companyId}::uuid
      and secret.provider = 'local_encrypted' and secret.deleted_at is null
    on conflict (company_id, token_sha256) do update set updated_at = excluded.updated_at,
      reason = case when excluded.reason = 'instance_removed' then excluded.reason else pending.reason end
    returning id`);
  return row?.id ?? null;
}

export async function queueGoogleRevocationFromSecret(db: Db, input: {
  companyId: string;
  connectionId: string;
  grantId: string;
  subject: string;
  profile: string;
  secretId: string;
  version: number;
  reason: GoogleRevocationReason;
  now?: Date;
}): Promise<string | null> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.googlePendingRevocation);
    return insertFromSecret(tx as unknown as Db, {
      ...input, nextAttemptAt: new Date(now.getTime() + GOOGLE_REVOCATION_LEASE_MS), now,
    });
  });
}

export async function tokenInLiveUse(db: Db, companyId: string, tokenSha256: string): Promise<boolean> {
  const selectedVersion = sql`case when ref.value->>'versionSelector' ~ '^[0-9]+$' then (ref.value->>'versionSelector')::integer else secret.latest_version end`;
  const usesToken = (refs: SQL) => sql`exists (
    select 1 from jsonb_array_elements(${refs}) ref
    join ${companySecrets} secret on secret.id::text = ref.value->>'secretId'
      and secret.company_id = ${companyId}::uuid and secret.deleted_at is null and secret.status <> 'deleted'
    join ${companySecretVersions} version on version.secret_id = secret.id and version.version = ${selectedVersion}
    where version.value_sha256 = ${tokenSha256})`;
  const rows = await db.execute<{ held: boolean }>(sql`select (
    exists (select 1 from ${connectionGrants} live_grant
      where live_grant.company_id = ${companyId}::uuid and live_grant.status <> 'revoked'
        and ${usesToken(sql`live_grant.credential_secret_refs`)})
    or exists (select 1 from ${toolConnections} live_connection
      where live_connection.company_id = ${companyId}::uuid and live_connection.status <> 'archived'
        and (${usesToken(sql`live_connection.credential_secret_refs`)} or ${usesToken(sql`live_connection.credential_refs`)}))
  ) as held`);
  return Boolean(rows[0]?.held);
}

export async function settleQueuedGoogleRevocation(db: Db, companyId: string, id: string, outcome: ManagedGoogleRevocationOutcome, now = new Date()) {
  const own = and(eq(googlePendingRevocations.id, id), eq(googlePendingRevocations.companyId, companyId));
  if (!isRetryableGoogleRevocationOutcome(outcome)) {
    await db.delete(googlePendingRevocations).where(own);
    return false;
  }
  await db.transaction(async (tx) => {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.googlePendingRevocation);
    await tx.update(googlePendingRevocations).set({
      attempts: sql`${googlePendingRevocations.attempts} + 1`,
      lastOutcome: outcome,
      nextAttemptAt: new Date(now.getTime() + GOOGLE_REVOCATION_FIRST_RETRY_MS),
      updatedAt: now,
    }).where(own);
  });
  return true;
}

export async function dropQueuedGoogleRevocation(db: Db, companyId: string, id: string) {
  await db.delete(googlePendingRevocations)
    .where(and(eq(googlePendingRevocations.id, id), eq(googlePendingRevocations.companyId, companyId)));
}

export async function queueCompanyGoogleRevocations(tx: Db, companyId: string, reason: GoogleRevocationReason, now = new Date()) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.googlePendingRevocation);
  const connections = await tx.select().from(toolConnections)
    .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.authKind, "oauth")));
  const queued: Array<{ secretId: string; version: number }> = [];
  const seen = new Set<string>();
  for (const connection of connections) {
    const oauth = oauthConfig(connection);
    if (!isPaperclipCloudConnectorStrategy(oauth.strategy)) continue;
    const profile = managedConnectorProfile(typeof oauth.connectorProfile === "string" ? oauth.connectorProfile : undefined);
    if (profile?.provider !== "google") continue;
    const grants = await tx.select().from(connectionGrants)
      .where(and(eq(connectionGrants.companyId, companyId), eq(connectionGrants.connectionId, connection.id)));
    for (const grant of grants) {
      const refreshRef = (grant.credentialSecretRefs ?? []).find((ref) => ref.configPath === "oauth.refresh_token");
      if (!refreshRef) continue;
      const secretId = refreshRef.secretId;
      const subject = managedConnectorConsentSubject(grant, oauth);
      if (!subject) continue;
      const [secret] = await tx.select({ latestVersion: companySecrets.latestVersion }).from(companySecrets)
        .where(and(eq(companySecrets.id, secretId), eq(companySecrets.companyId, companyId), isNull(companySecrets.deletedAt), ne(companySecrets.status, "deleted")));
      if (!secret) continue;
      const version = typeof refreshRef.versionSelector === "number" ? refreshRef.versionSelector : secret.latestVersion;
      if (seen.has(`${secretId}:${version}`)) continue;
      seen.add(`${secretId}:${version}`);
      const id = await insertFromSecret(tx, {
        companyId, connectionId: connection.id, grantId: grant.id, subject, profile: profile.id,
        secretId, version, reason, nextAttemptAt: now, now,
      });
      if (id && !queued.some((entry) => entry.secretId === secretId)) queued.push({ secretId, version: secret.latestVersion });
    }
  }
  return queued;
}

export function createGooglePendingRevocation(db: Db, deps: {
  currentCloudConnector: () => PaperclipCloudConnector | null;
  now?: () => number;
  timeoutMs?: number;
}) {
  const now = deps.now ?? Date.now;
  const timeoutMs = deps.timeoutMs ?? GOOGLE_REVOCATION_TIMEOUT_MS;

  async function heldByLiveSecret(row: PendingRow) {
    if (row.reason === "instance_removed") return false;
    return tokenInLiveUse(db, row.companyId, row.tokenSha256);
  }

  async function record(row: PendingRow, result: RetryResult, outcome: string | null) {
    const settled = result === "ended" || result === "other_connections_remain";
    const fields = { companyId: row.companyId, connectionId: row.connectionId, reason: row.reason, attempts: row.attempts, result, outcome };
    if (settled) logger.info(fields, "Finished ending Paperclip's Google access after a retry");
    else logger.warn(fields, "Gave up ending Paperclip's Google access after retries");
    try {
      if (!row.connectionId) return;
      const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, row.companyId));
      if (!company) return;
      const [connection] = await db.select({ id: toolConnections.id }).from(toolConnections)
        .where(and(eq(toolConnections.id, row.connectionId), eq(toolConnections.companyId, row.companyId)));
      const details = {
        provider: "google", result, reason: row.reason, attempts: row.attempts,
        ...(outcome ? { outcome } : {}), ...(row.grantId ? { grantId: row.grantId } : {}),
      };
      await db.insert(toolAccessAuditEvents).values({
        companyId: row.companyId,
        connectionId: connection ? row.connectionId : null,
        actorType: "system",
        actorId: null,
        action: "connection.google_access_retry",
        outcome: settled ? "success" : "failure",
        reasonCode: result,
        details,
      });
      await logActivity(db, {
        companyId: row.companyId,
        actorType: "system",
        actorId: "paperclip",
        action: result === "ended" ? "tool_connection.google_access_ended" : "tool_connection.google_access_not_ended",
        entityType: "tool_connection",
        entityId: row.connectionId,
        details,
      });
    } catch (error) {
      logger.warn(
        { companyId: row.companyId, connectionId: row.connectionId, errorName: error instanceof Error ? error.name : typeof error },
        "Could not record the result of a retried Google access removal",
      );
    }
  }

  async function finish(row: PendingRow, result: RetryResult, outcome: string | null) {
    const removed = await db.delete(googlePendingRevocations)
      .where(and(eq(googlePendingRevocations.id, row.id), eq(googlePendingRevocations.nextAttemptAt, row.nextAttemptAt)))
      .returning({ id: googlePendingRevocations.id });
    if (removed.length > 0) await record(row, result, outcome);
  }

  async function reschedule(row: PendingRow, outcome: ManagedGoogleRevocationOutcome) {
    const at = Math.min(now() + googleRevocationRetryDelayMs(row.attempts), row.giveUpAt.getTime());
    await db.update(googlePendingRevocations).set({ lastOutcome: outcome, nextAttemptAt: new Date(at), updatedAt: new Date(now()) })
      .where(and(eq(googlePendingRevocations.id, row.id), eq(googlePendingRevocations.nextAttemptAt, row.nextAttemptAt)));
  }

  async function attempt(due: PendingRow) {
    const [row] = await db.update(googlePendingRevocations).set({
      attempts: sql`${googlePendingRevocations.attempts} + 1`,
      nextAttemptAt: new Date(now() + GOOGLE_REVOCATION_LEASE_MS),
      updatedAt: new Date(now()),
    }).where(and(eq(googlePendingRevocations.id, due.id), eq(googlePendingRevocations.nextAttemptAt, due.nextAttemptAt)))
      .returning();
    if (!row) return;
    if (now() >= row.giveUpAt.getTime()) return finish(row, "gave_up", row.lastOutcome);
    if (await heldByLiveSecret(row)) return finish(row, "other_connections_remain", null);
    let token: string;
    try {
      token = createLocalEncryptedCipher("read").decrypt(row.tokenMaterial);
    } catch {
      return reschedule(row, "credential_unavailable");
    }
    let connector: PaperclipCloudConnector | null = null;
    try {
      connector = deps.currentCloudConnector();
    } catch {
      connector = null;
    }
    if (!connector) return reschedule(row, "broker_unavailable");
    let outcome: ManagedGoogleRevocationOutcome;
    try {
      outcome = (await connector.revoke({
        subject: row.subject,
        companyId: row.companyId,
        profile: row.profile as Parameters<PaperclipCloudConnector["revoke"]>[0]["profile"],
        token,
        timeoutMs,
      })).outcome ?? "broker_error";
    } catch (error) {
      outcome = googleRevocationOutcomeForError(error);
    }
    if (isRetryableGoogleRevocationOutcome(outcome)) return reschedule(row, outcome);
    if (outcome === "revoked") return finish(row, "ended", outcome);
    if (outcome === "other_connections_remain") return finish(row, "other_connections_remain", outcome);
    return finish(row, "not_ended", outcome);
  }

  async function drain(signal: AbortSignal) {
    const due = await db.select().from(googlePendingRevocations)
      .where(lte(googlePendingRevocations.nextAttemptAt, new Date(now())))
      .orderBy(asc(googlePendingRevocations.nextAttemptAt), asc(googlePendingRevocations.id))
      .limit(GOOGLE_REVOCATION_BATCH);
    for (const row of due) {
      if (signal.aborted) break;
      try {
        await attempt(row);
      } catch (error) {
        logger.warn(
          { companyId: row.companyId, connectionId: row.connectionId, errorName: error instanceof Error ? error.name : typeof error },
          "Could not retry ending Paperclip's Google access",
        );
      }
    }
  }

  async function nextDeadline() {
    const [row] = await db
      .select({ at: sql<Date | null>`min(${googlePendingRevocations.nextAttemptAt})`.mapWith(googlePendingRevocations.nextAttemptAt) })
      .from(googlePendingRevocations);
    return row?.at ? row.at.getTime() : null;
  }

  return { drain, nextDeadline };
}

export async function revokeGoogleAccessForRemovedInstance(db: Db, removeSecret: (secretId: string, expectedVersion: number) => Promise<unknown>) {
  const queued = await db.transaction(async (tx) => {
    const owners = await tx.selectDistinct({ companyId: toolConnections.companyId }).from(toolConnections)
      .where(eq(toolConnections.authKind, "oauth"));
    const all: Array<{ companyId: string; secretId: string; version: number }> = [];
    for (const { companyId } of owners) {
      for (const entry of await queueCompanyGoogleRevocations(tx as unknown as Db, companyId, "instance_removed")) all.push({ companyId, ...entry });
    }
    const connections = await tx.select({ id: toolConnections.id, companyId: toolConnections.companyId, config: toolConnections.config })
      .from(toolConnections)
      .where(eq(toolConnections.authKind, "oauth"));
    for (const connection of connections) {
      if (!isPaperclipCloudConnectorStrategy(oauthConfig(connection).strategy)) continue;
      await deleteGoogleContentWhenAccessEnds(tx as unknown as Db, connection, "instance_removed");
    }
    return all;
  });
  for (const { companyId, secretId, version } of queued) {
    try {
      await removeSecret(secretId, version);
    } catch (error) {
      logger.warn(
        { companyId, errorName: error instanceof Error ? error.name : typeof error },
        "Could not delete a Google refresh token after Paperclip Cloud removed this instance",
      );
    }
  }
  return queued.length;
}
