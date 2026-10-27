import { oauthConfig } from "./metadata.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolConnections } from "@paperclipai/db";
import { conflict, HttpError, unprocessable } from "../../../errors.js";
import type { OAuthCredentialStore } from "./credential-store.js";
import { oauthExpiresAtMs, oauthGrantConfig, oauthGrantExpiresAtMs } from "./client-settings.js";
import { connectionSetupUrl, connectionReconnectUrl } from "../identifiers.js";
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

const OAUTH_REFRESH_LEASE_MS = 120_000;

const OAUTH_REFRESH_LEASE_WAIT_MS = 30_000;

const OAUTH_REFRESH_LEASE_POLL_MS = 25;

export function withoutOAuthRefreshLease(oauth: Record<string, unknown>) {
  const { refreshLease: _refreshLease, ...rest } = oauth;
  return rest;
}

export function withoutOAuthGrantRefreshLease(oauth: Record<string, unknown>) {
  const { refreshLease: _refreshLease, ...rest } = oauth;
  return rest;
}

export function oauthRefreshLeaseId(
  connection: typeof toolConnections.$inferSelect,
): string | null {
  const lease = asRecord(oauthConfig(connection).refreshLease);
  return typeof lease.id === "string" && lease.id ? lease.id : null;
}

export function createOAuthRefreshLeases(db: Db, now: () => Date, getConnectionRow: (idOrUid: string, companyId?: string) => Promise<typeof toolConnections.$inferSelect>, getOAuthGrantRow: OAuthCredentialStore["getOAuthGrantRow"]) {
  async function clearOAuthRefreshLease(
    connection: typeof toolConnections.$inferSelect,
    leaseId: string,
  ) {
    const latest = await getConnectionRow(connection.id, connection.companyId);
    if (oauthRefreshLeaseId(latest) !== leaseId) return latest;
    const nextConfig = {
      ...latest.config,
      oauth: withoutOAuthRefreshLease(oauthConfig(latest)),
    };
    const [updated] = await db
      .update(toolConnections)
      .set({
        config: nextConfig,
        transportConfig: nextConfig,
        updatedAt: now(),
      })
      .where(
        and(
          eq(toolConnections.id, latest.id),
          eq(toolConnections.companyId, latest.companyId),
          sql`${toolConnections.config} -> 'oauth' -> 'refreshLease' ->> 'id' = ${leaseId}`,
        ),
      )
      .returning();
    return updated ?? getConnectionRow(connection.id, connection.companyId);
  }

  async function acquireOAuthRefreshLease(
    connection: typeof toolConnections.$inferSelect,
  ): Promise<{
    connection: typeof toolConnections.$inferSelect;
    leaseId: string | null;
  }> {
    const waitDeadline = Date.now() + OAUTH_REFRESH_LEASE_WAIT_MS;
    while (true) {
      const latest = await getConnectionRow(
        connection.id,
        connection.companyId,
      );
      const latestExpiresAtMs = oauthExpiresAtMs(latest);
      if (latestExpiresAtMs && latestExpiresAtMs > Date.now() + 60_000) {
        return { connection: latest, leaseId: null };
      }

      const oauth = oauthConfig(latest);
      const currentLease = asRecord(oauth.refreshLease);
      const currentLeaseExpiresAt =
        typeof currentLease.expiresAt === "string"
          ? Date.parse(currentLease.expiresAt)
          : Number.NaN;
      const currentLeaseId =
        typeof currentLease.id === "string" && currentLease.id
          ? currentLease.id
          : null;
      const leaseIsActive =
        currentLeaseId !== null &&
        Number.isFinite(currentLeaseExpiresAt) &&
        currentLeaseExpiresAt > Date.now();
      if (!currentLeaseId) {
        const leaseId = randomUUID();
        const claimedAt = now();
        const nextConfig = {
          ...latest.config,
          oauth: {
            ...withoutOAuthRefreshLease(oauth),
            refreshLease: {
              id: leaseId,
              expiresAt: new Date(
                Date.now() + OAUTH_REFRESH_LEASE_MS,
              ).toISOString(),
            },
          },
        };
        const [claimed] = await db
          .update(toolConnections)
          .set({
            config: nextConfig,
            transportConfig: nextConfig,
            updatedAt: claimedAt,
          })
          .where(
            and(
              eq(toolConnections.id, latest.id),
              eq(toolConnections.companyId, latest.companyId),
              sql`${toolConnections.config} = ${JSON.stringify(latest.config)}::jsonb`,
              sql`${toolConnections.config} #>> '{oauth,refreshLease,id}' is null`,
            ),
          )
          .returning();
        if (claimed) return { connection: claimed, leaseId };
      }

      if (currentLeaseId && !leaseIsActive) {
        throw new HttpError(
          422,
          "The previous OAuth refresh did not finish. Reconnect this app before retrying.",
          {
            code: "oauth_refresh_outcome_unknown",
            setupUrl: connectionSetupUrl(latest),
            reconnectUrl: connectionReconnectUrl(latest),
          },
        );
      }

      if (Date.now() >= waitDeadline) {
        throw conflict("OAuth credential refresh is already in progress", {
          code: "oauth_refresh_in_progress",
          retryable: true,
        });
      }
      await new Promise((resolve) =>
        setTimeout(resolve, OAUTH_REFRESH_LEASE_POLL_MS),
      );
    }
  }

  async function clearOAuthGrantRefreshLease(
    grant: typeof connectionGrants.$inferSelect,
    leaseId: string,
  ) {
    const latest = await getOAuthGrantRow({
      companyId: grant.companyId,
      connectionId: grant.connectionId,
      grantId: grant.id,
    });
    const oauth = oauthGrantConfig(latest);
    if (asRecord(oauth.refreshLease).id !== leaseId) return latest;
    const providerTenant = {
      ...(latest.providerTenant ?? {}),
      oauth: withoutOAuthGrantRefreshLease(oauth),
    };
    const [updated] = await db
      .update(connectionGrants)
      .set({
        providerTenant,
        updatedAt: now(),
      })
      .where(
        and(
          eq(connectionGrants.id, latest.id),
          eq(connectionGrants.companyId, latest.companyId),
          sql`${connectionGrants.providerTenant} -> 'oauth' -> 'refreshLease' ->> 'id' = ${leaseId}`,
        ),
      )
      .returning();
    return (
      updated ??
      getOAuthGrantRow({
        companyId: grant.companyId,
        connectionId: grant.connectionId,
        grantId: grant.id,
      })
    );
  }

  async function acquireOAuthGrantRefreshLease(
    connection: typeof toolConnections.$inferSelect,
    grant: typeof connectionGrants.$inferSelect,
    forceRefresh: boolean,
  ): Promise<{
    grant: typeof connectionGrants.$inferSelect;
    leaseId: string | null;
  }> {
    const waitDeadline = Date.now() + OAUTH_REFRESH_LEASE_WAIT_MS;
    const initialUpdatedAt = grant.updatedAt.getTime();
    while (true) {
      const latest = await getOAuthGrantRow({
        companyId: connection.companyId,
        connectionId: connection.id,
        grantId: grant.id,
      });
      if (latest.status !== "active") {
        throw unprocessable("OAuth authorization must be reconnected", {
          code: "oauth_reauthorization_required",
          setupUrl: connectionSetupUrl(connection),
          reconnectUrl: connectionReconnectUrl(connection),
        });
      }
      const expiresAtMs = oauthGrantExpiresAtMs(latest, connection);
      if (
        (!forceRefresh &&
          (expiresAtMs === null || expiresAtMs > Date.now() + 60_000)) ||
        (forceRefresh &&
          latest.updatedAt.getTime() > initialUpdatedAt &&
          !asRecord(oauthGrantConfig(latest).refreshLease).id)
      ) {
        return { grant: latest, leaseId: null };
      }

      const oauth = oauthGrantConfig(latest);
      const currentLease = asRecord(oauth.refreshLease);
      const currentLeaseId =
        typeof currentLease.id === "string" && currentLease.id
          ? currentLease.id
          : null;
      const currentLeaseExpiresAt =
        typeof currentLease.expiresAt === "string"
          ? Date.parse(currentLease.expiresAt)
          : Number.NaN;
      const leaseIsActive =
        currentLeaseId !== null &&
        Number.isFinite(currentLeaseExpiresAt) &&
        currentLeaseExpiresAt > Date.now();
      if (!currentLeaseId) {
        const leaseId = randomUUID();
        const providerTenant = {
          ...(latest.providerTenant ?? {}),
          oauth: {
            ...withoutOAuthGrantRefreshLease(oauth),
            refreshLease: {
              id: leaseId,
              expiresAt: new Date(
                Date.now() + OAUTH_REFRESH_LEASE_MS,
              ).toISOString(),
            },
          },
        };
        const [claimed] = await db
          .update(connectionGrants)
          .set({
            providerTenant,
            updatedAt: now(),
          })
          .where(
            and(
              eq(connectionGrants.id, latest.id),
              eq(connectionGrants.companyId, latest.companyId),
              eq(connectionGrants.status, "active"),
              sql`${connectionGrants.providerTenant} #>> '{oauth,refreshLease,id}' is null`,
            ),
          )
          .returning();
        if (claimed) return { grant: claimed, leaseId };
      }
      if (currentLeaseId && !leaseIsActive) {
        throw unprocessable(
          "The previous OAuth refresh did not finish. Reconnect this app before retrying.",
          {
            code: "oauth_refresh_outcome_unknown",
            setupUrl: connectionSetupUrl(connection),
            reconnectUrl: connectionReconnectUrl(connection),
          },
        );
      }
      if (Date.now() >= waitDeadline) {
        throw conflict("OAuth credential refresh is already in progress", {
          code: "oauth_refresh_in_progress",
          retryable: true,
        });
      }
      await new Promise((resolve) =>
        setTimeout(resolve, OAUTH_REFRESH_LEASE_POLL_MS),
      );
    }
  }
  return { clearOAuthRefreshLease, acquireOAuthRefreshLease, clearOAuthGrantRefreshLease, acquireOAuthGrantRefreshLease };
}

export type OAuthRefreshLeases = ReturnType<typeof createOAuthRefreshLeases>;
