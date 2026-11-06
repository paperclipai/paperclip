import { and, eq, inArray, isNotNull, notExists, or, sql } from "drizzle-orm";
import { adapterAuthSessions, environmentLeases, type Db } from "@paperclipai/db";
import { ADAPTER_AUTH_ACTIVE_STATUSES, DISPLAYED_CODE_ADAPTER_TYPES, LOGIN_LEASE_SESSION_TAG_KEY } from "./device-login-service.js";
import { SETUP_TOKEN_ADAPTER_TYPE, SETUP_TOKEN_TERMINAL_STATES } from "./setup-token-session.js";

export const LOGIN_CLEANUP_RETRY_MS = 30_000;

export function orphanLoginLeases(db: Db, now = new Date()) {
  return db.select({
    environmentId: environmentLeases.environmentId,
    providerLeaseId: environmentLeases.providerLeaseId,
    sessionId: sql<string>`${environmentLeases.metadata}->>${LOGIN_LEASE_SESSION_TAG_KEY}`,
  }).from(environmentLeases).where(and(
    or(eq(environmentLeases.status, "active"), eq(environmentLeases.cleanupStatus, "failed")),
    isNotNull(environmentLeases.environmentId),
    isNotNull(environmentLeases.providerLeaseId),
    sql`jsonb_typeof(${environmentLeases.metadata}->${LOGIN_LEASE_SESSION_TAG_KEY}) = 'string'`,
    notExists(db.select({ id: adapterAuthSessions.id }).from(adapterAuthSessions).where(and(
      eq(adapterAuthSessions.companyId, environmentLeases.companyId),
      eq(adapterAuthSessions.environmentId, environmentLeases.environmentId),
      or(
        eq(adapterAuthSessions.providerLeaseId, environmentLeases.providerLeaseId),
        and(
          sql`${adapterAuthSessions.id}::text = ${environmentLeases.metadata}->>${LOGIN_LEASE_SESSION_TAG_KEY}`,
          inArray(adapterAuthSessions.status, [...ADAPTER_AUTH_ACTIVE_STATUSES]),
          sql`greatest(${adapterAuthSessions.expiresAt}, case when ${adapterAuthSessions.status} = 'promoting' then ${adapterAuthSessions.promotionExpiresAt} end) > ${now.toISOString()}::timestamptz`,
        ),
      ),
    ))),
  ));
}

export function loginCleanupSchedule(db: Db, retryMs = LOGIN_CLEANUP_RETRY_MS) {
  const retry = () => Date.now() + retryMs;
  const next = (value: number | string | null | undefined) => value == null ? null : Math.max(Number(value), retry());
  return {
    async adapter() {
      const [rows, orphans] = await Promise.all([
        db.select({ at: sql<string | null>`min(extract(epoch from case
          when ${adapterAuthSessions.status} = 'cleanup_pending' then now()
          else greatest(${adapterAuthSessions.expiresAt}, case when ${adapterAuthSessions.status} = 'promoting' then ${adapterAuthSessions.promotionExpiresAt} end)
          end) * 1000)` }).from(adapterAuthSessions).where(and(
          inArray(adapterAuthSessions.adapterType, DISPLAYED_CODE_ADAPTER_TYPES),
          sql`${adapterAuthSessions.connectionMethod} is distinct from 'local_subscription'`,
          inArray(adapterAuthSessions.status, [...ADAPTER_AUTH_ACTIVE_STATUSES, "cleanup_pending"]),
        )),
        orphanLoginLeases(db).limit(1),
      ]);
      return orphans.length ? retry() : next(rows[0]?.at);
    },
    async setupToken() {
      const rows = await db.select({ at: sql<string | null>`min(extract(epoch from case
        when ${inArray(adapterAuthSessions.status, [...SETUP_TOKEN_TERMINAL_STATES])} or ${adapterAuthSessions.boundAt} is not null then now()
        else ${adapterAuthSessions.expiresAt} end) * 1000)` }).from(adapterAuthSessions).where(and(
        eq(adapterAuthSessions.adapterType, SETUP_TOKEN_ADAPTER_TYPE),
        sql`${adapterAuthSessions.connectionMethod} is distinct from 'local_subscription'`,
      ));
      return next(rows[0]?.at);
    },
  };
}
