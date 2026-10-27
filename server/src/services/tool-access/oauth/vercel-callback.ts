import { connectionActorUserId } from "../actor.js";
import { vercelConnectHttpError, vercelCredentialFor, vercelConnectResourcesFor } from "../vercel-credentials.js";
import type { ActorInfo } from "../types.js";
import { connectionMethodForConnection, projectedConnectionHeaders } from "../connection-methods.js";
import { emitConnectionUpdated } from "../../connector-telemetry.js";
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, companyMemberships, toolApplications, toolConnections } from "@paperclipai/db";
import type { ConnectionGrantKind, ConnectToolAppResult } from "@paperclipai/shared";
import { getConnectableAppDefinition, recommendedDefaultsForApp } from "@paperclipai/shared";
import { badRequest, forbidden, HttpError } from "../../../errors.js";
import { deriveVercelConnectSubject, vercelGrantReference, vercelTokenRequest, VercelConnectClientError, type VercelConnectClient } from "../../vercel-connect.js";

import type { OAuthStateStore } from "./state.js";

import type { OAuthCatalogCompletion } from "./catalog-completion.js";
import type { RefreshConnectionCatalog } from "../catalog/contracts.js";

import { toApplication } from "../applications/projection.js";
import { groupedActions } from "../catalog/action-summary.js";

type Dependencies = {
  now: () => Date;
  getConnectionRow(idOrUid: string, companyId?: string): Promise<typeof toolConnections.$inferSelect>;
  state: OAuthStateStore;
  refreshCatalog: RefreshConnectionCatalog;
  finishOAuthCatalogWithRecommendedDefaults: OAuthCatalogCompletion;
  vercelConnect: VercelConnectClient | null;
};

export function createVercelOAuthCallback(db: Db, dependencies: Dependencies) {
  const { now, getConnectionRow, state, refreshCatalog, finishOAuthCatalogWithRecommendedDefaults, vercelConnect } = dependencies;
  const { consumeOAuthState, rejectPendingOAuthInteraction } = state;
  async function completeVercelConnectCallback(input: {
    state: string;
    error?: string | null;
    actor?: ActorInfo;
  }): Promise<ConnectToolAppResult> {
    const stateRow = await consumeOAuthState(input.state, input.actor);
    if (stateRow.codeVerifier !== "vercel-connect") {
      throw badRequest("OAuth state does not belong to a Vercel Connect flow");
    }
    if (input.error) {
      await rejectPendingOAuthInteraction(stateRow, input.actor);
      throw new HttpError(
        400,
        "Vercel Connect authorization did not complete. Start a new authorization to try again.",
        {
          code:
            input.error === "access_denied"
              ? "oauth_authorization_denied"
              : "vercel_connect_authorization_required",
        },
      );
    }
    if (!vercelConnect)
      throw vercelConnectHttpError(
        new VercelConnectClientError("vercel_connect_unavailable", 503),
      );
    let connection = await getConnectionRow(
      stateRow.connectionId,
      stateRow.companyId,
    );
    const credential = vercelCredentialFor(connection);
    if (
      credential.principalMode !== "user" ||
      connection.authKind !== "oauth"
    ) {
      throw badRequest(
        "Vercel Connect callback does not match this connection",
      );
    }
    const grantKind: ConnectionGrantKind = stateRow.subjectUserId
      ? "user"
      : "organization";
    if (stateRow.subjectUserId) {
      const [membership] = await db
        .select({ id: companyMemberships.id })
        .from(companyMemberships)
        .where(
          and(
            eq(companyMemberships.companyId, connection.companyId),
            eq(companyMemberships.principalType, "user"),
            eq(companyMemberships.principalId, stateRow.subjectUserId),
            eq(companyMemberships.status, "active"),
            ne(companyMemberships.membershipRole, "viewer"),
          ),
        )
        .limit(1);
      if (!membership) {
        throw forbidden(
          "Your company membership no longer permits connection changes. Restore non-viewer access before authorizing this connection.",
        );
      }
    }
    const [existingGrant] = await db
      .select()
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, grantKind),
          grantKind === "user"
            ? eq(connectionGrants.subjectUserId, stateRow.subjectUserId!)
            : eq(connectionGrants.isDefault, true),
        ),
      )
      .limit(1);
    const derived = deriveVercelConnectSubject({
      credential,
      connectionId: connection.id,
      companyId: connection.companyId,
      grantKind,
      subjectUserId: stateRow.subjectUserId,
    });
    const request = vercelTokenRequest({
      credential,
      connectionId: connection.id,
      companyId: connection.companyId,
      resources: vercelConnectResourcesFor(connection),
      grant: {
        kind: grantKind,
        subjectUserId: stateRow.subjectUserId,
        externalCredential: existingGrant?.externalCredential,
      },
    });
    let token;
    try {
      token = await vercelConnect.getToken(request, { forceRefresh: true });
    } catch (error) {
      throw vercelConnectHttpError(error);
    }
    if (
      token.connector.id !== credential.connectorId &&
      token.connector.uid !== credential.connectorUid
    ) {
      throw new HttpError(
        502,
        "Vercel Connect returned a token for a different connector.",
        {
          code: "vercel_connect_connector_mismatch",
        },
      );
    }
    const externalGrant = vercelGrantReference({
      credential,
      token,
      subjectId: derived.subjectId,
      verifiedAt: now(),
    });
    const grantValues = {
      providerTenant: token.tenantId
        ? { name: credential.service, externalId: token.tenantId }
        : { name: credential.service },
      credentialSecretRefs: [],
      externalCredential: externalGrant,
      status: "active" as const,
      isDefault: grantKind === "organization",
      revokedAt: null,
      revokedByAgentId: null,
      revokedByUserId: null,
      updatedAt: now(),
    };
    if (existingGrant) {
      await db
        .update(connectionGrants)
        .set(grantValues)
        .where(eq(connectionGrants.id, existingGrant.id));
    } else {
      await db.insert(connectionGrants).values({
        companyId: connection.companyId,
        connectionId: connection.id,
        kind: grantKind,
        subjectUserId: stateRow.subjectUserId,
        ...grantValues,
        createdByUserId:
          connectionActorUserId(input.actor),
      });
    }
    const preActivationLifecycle = {
      status: connection.status,
      enabled: connection.enabled,
    };
    [connection] = await db
      .update(toolConnections)
      .set({
        status: "active",
        enabled: true,
        credentialRefs: [],
        credentialSecretRefs: [],
        updatedAt: now(),
      })
      .where(
        and(
          eq(toolConnections.id, connection.id),
          eq(toolConnections.companyId, connection.companyId),
        ),
      )
      .returning();
    emitConnectionUpdated(
      connection,
      preActivationLifecycle,
      "oauth_callback",
    );
    await db
      .update(toolApplications)
      .set({ status: "active", updatedAt: now() })
      .where(eq(toolApplications.id, connection.applicationId));
    const sourceTemplateKey =
      typeof connection.config.sourceTemplateKey === "string"
        ? connection.config.sourceTemplateKey
        : null;
    const galleryEntry = sourceTemplateKey
      ? getConnectableAppDefinition(sourceTemplateKey)
      : null;
    if (!galleryEntry)
      throw badRequest(
        "Vercel Connect connection is missing its reviewed app definition",
      );
    const method = connectionMethodForConnection(galleryEntry, connection);
    const refresh = await refreshCatalog(connection.id, input.actor, {
      enableAllByDefault: true,
      skipDefaultProfileSync: true,
      credentialHeaders: {
        ...projectedConnectionHeaders(connection),
        [credential.headerName]: `${credential.headerPrefix ?? ""}${token.token}`,
      },
    });
    const suggestedDefaults = recommendedDefaultsForApp(
      galleryEntry,
      method.key,
    );
    const finished = await finishOAuthCatalogWithRecommendedDefaults({
      interactionId: stateRow.interactionId,
      connection,
      catalog: refresh.catalog,
      suggestedDefaults,
      actor: input.actor,
    });
    const [application] = await db
      .select()
      .from(toolApplications)
      .where(eq(toolApplications.id, connection.applicationId));
    return {
      connectionId: connection.id,
      application: toApplication(application),
      connection: finished.connection,
      catalog: refresh.catalog,
      actions: groupedActions(refresh.catalog),
      suggestedDefaults,
      auth: null,
    };
  }
  return completeVercelConnectCallback;
}
