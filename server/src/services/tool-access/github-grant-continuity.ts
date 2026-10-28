import type { ActorInfo } from "./types.js";
import { loadGitHubGrantMetadata } from "./github-access-discovery.js";
import { measureRunPhase } from "../execution-preparation-timing.js";
import { measureRunTransaction } from "../execution-transaction-timing.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolConnections } from "@paperclipai/db";
import { conflict, HttpError, notFound, unprocessable } from "../../errors.js";
import { type PaperclipCloudConnector } from "../paperclip-cloud-connector.js";

import type { createOAuthGrantRefresh } from "./oauth/grant-refresh.js";
import type { OAuthCredentialStore } from "./oauth/credential-store.js";
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value))
    return value as Record<string, unknown>;
  return {};
}

type GitHubContinuityDependencies = {
  now: () => Date;
  currentCloudConnector: () => PaperclipCloudConnector | null;
  refreshOAuthGrantCredentials: ReturnType<typeof createOAuthGrantRefresh>;
  resolveOAuthGrantSecret: OAuthCredentialStore["resolveOAuthGrantSecret"];
};

export function createGitHubGrantContinuity(db: Db, { now, currentCloudConnector, refreshOAuthGrantCredentials, resolveOAuthGrantSecret }: GitHubContinuityDependencies) {
  let nextGitHubContinuitySweepAt = 0;
  async function refreshManagedGitHubGrantAccess(
    connection: typeof toolConnections.$inferSelect,
    initialGrant: typeof connectionGrants.$inferSelect,
    actor?: ActorInfo,
  ) {
    await actor?.managementContext?.reauthorize();
    return measureRunPhase("connectors.github.refresh", async () => {
      try {
        return await refreshManagedGitHubGrantAccessOnce(
          connection,
          initialGrant,
          actor,
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
        return refreshManagedGitHubGrantAccessOnce(connection, current, actor);
      }
    });
  }

  async function refreshManagedGitHubGrantAccessOnce(
    connection: typeof toolConnections.$inferSelect,
    initialGrant: typeof connectionGrants.$inferSelect,
    actor?: ActorInfo,
  ) {
    await actor?.managementContext?.reauthorize();
    let grant = await measureRunPhase("connectors.github.credentials", () => refreshOAuthGrantCredentials({
      companyId: connection.companyId,
      connectionId: connection.id,
      grantId: initialGrant.id,
      actor,
    }));
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
    const { updated, previousGitHub } = await measureRunTransaction(db, "connectors.github.refresh", async (tx) => {
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
      // No lock is held during provider requests. Reject a snapshot if another
      // refresh or webhook changed access while those requests were in flight.
      if (
        previousGitHub?.accessRevision !== initialGitHub?.accessRevision ||
        previousGitHub?.lastWebhookAt !== initialGitHub?.lastWebhookAt ||
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

    const cloudConnector = currentCloudConnector();
    const subject =
      updated.kind === "agent" && updated.subjectAgentId
        ? `agent:${updated.subjectAgentId}`
        : updated.kind === "user" && updated.subjectUserId
          ? updated.subjectUserId
          : null;
    if (cloudConnector && subject) {
      const previous = new Set(previousGitHub?.installationIds ?? []);
      const current = new Set(metadata.installationIds);
      await measureRunPhase("connectors.github.webhooks", () => Promise.all([
        ...metadata.installationIds.map((installationId) =>
          cloudConnector.setWebhookBinding({
            subject,
            companyId: connection.companyId,
            id: `${updated.id}_${installationId}`,
            installationId,
            connectionId: connection.id,
            grantId: updated.id,
            active: true,
            accessToken,
          }),
        ),
        ...[...previous]
          .filter((installationId) => !current.has(installationId))
          .map((installationId) =>
            cloudConnector.setWebhookBinding({
              subject,
              companyId: connection.companyId,
              id: `${updated.id}_${installationId}`,
              installationId,
              connectionId: connection.id,
              grantId: updated.id,
              active: false,
            }),
          ),
      ]));
    }
    return updated;
  }

  async function sweepGitHubConnectionContinuity() {
    if (now().getTime() < nextGitHubContinuitySweepAt) {
      return { checked: 0, due: 0, refreshed: 0, failed: 0 };
    }
    nextGitHubContinuitySweepAt = now().getTime() + 60 * 60_000;
    const cutoff = now().getTime() - 30 * 24 * 60 * 60_000;
    const rows = await db
      .select({ grant: connectionGrants, connection: toolConnections })
      .from(connectionGrants)
      .innerJoin(
        toolConnections,
        and(
          eq(toolConnections.id, connectionGrants.connectionId),
          eq(toolConnections.companyId, connectionGrants.companyId),
        ),
      )
      .where(
        and(
          eq(connectionGrants.status, "active"),
          eq(toolConnections.status, "active"),
          eq(toolConnections.enabled, true),
        ),
      );
    const due = rows.filter(({ grant, connection }) => {
      const config = asRecord(connection.config);
      const oauth = asRecord(config.oauth);
      if (
        config.sourceTemplateKey !== "github" ||
        oauth.connectorProfile !== "github.code" ||
        !grant.providerTenant?.github
      )
        return false;
      const expiresAt = grant.providerTenant.oauth?.accessTokenExpiresAt;
      const refreshedAt = grant.providerTenant.oauth?.refreshedAt
        ? Date.parse(grant.providerTenant.oauth.refreshedAt)
        : Number.NaN;
      const accessCheckedAt = grant.providerTenant.github.lastAccessRefreshAt
        ? Date.parse(grant.providerTenant.github.lastAccessRefreshAt)
        : Number.NaN;
      if (typeof expiresAt === "string") {
        const expiry = Date.parse(expiresAt);
        return (
          !Number.isFinite(expiry) ||
          expiry <= now().getTime() + 60 * 60_000 ||
          !Number.isFinite(refreshedAt) ||
          refreshedAt <= cutoff
        );
      }
      return !Number.isFinite(accessCheckedAt) || accessCheckedAt <= cutoff;
    });
    let refreshed = 0;
    let failed = 0;
    for (const row of due) {
      try {
        await refreshManagedGitHubGrantAccess(row.connection, row.grant, {
          actorType: "system",
          actorId: "github-connection-continuity",
        });
        refreshed += 1;
      } catch {
        failed += 1;
      }
    }
    return { checked: rows.length, due: due.length, refreshed, failed };
  }
  return { refreshManagedGitHubGrantAccess, sweepGitHubConnectionContinuity };
}
