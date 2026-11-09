import type { ActorInfo } from "./types.js";
import { remoteEndpoint } from "./connection-methods.js";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { connectionGrants, toolConnections } from "@paperclipai/db";
import type { VercelConnectCredentialReference, VercelConnectGrantReference } from "@paperclipai/shared";
import { conflict, HttpError, unprocessable } from "../../errors.js";
import { deriveVercelConnectSubject, vercelGrantReference, vercelTokenRequest, VercelConnectClientError, type VercelConnectClient } from "../vercel-connect.js";

export function vercelConnectHttpError(error: unknown): HttpError {
  if (error instanceof VercelConnectClientError) {
    return new HttpError(error.status, error.message, { code: error.code });
  }
  return new HttpError(
    502,
    "Vercel Connect could not complete the credential request.",
    {
      code: "vercel_connect_request_failed",
    },
  );
}

export function vercelCredentialFor(
  connection: typeof toolConnections.$inferSelect,
): VercelConnectCredentialReference {
  if (
    connection.credentialSource !== "vercel_connect" ||
    !connection.externalCredential
  ) {
    throw unprocessable("This connection does not use Vercel Connect", {
      code: "vercel_connect_not_configured",
    });
  }
  return connection.externalCredential;
}

export function vercelConnectResourcesFor(
  connection: typeof toolConnections.$inferSelect,
): string[] {
  const resource = new URL(remoteEndpoint(connection.config));
  // OAuth resource indicators name the protected MCP resource, not the
  // connection's transport-only filtering query. PostHog uses this canonical
  // URL to select its MCP consent scope set.
  resource.search = "";
  resource.hash = "";
  return [resource.toString()];
}

export function redactedVercelGrant(
  value: VercelConnectGrantReference | null | undefined,
): Omit<VercelConnectGrantReference, "subjectId"> | null {
  if (!value) return null;
  const { subjectId: _subjectId, ...redacted } = value;
  return redacted;
}

export function createVercelCredentialService(db: Db, now: () => Date, vercelConnect: VercelConnectClient | null) {
  async function resolveVercelCredentialHeaders(
    connection: typeof toolConnections.$inferSelect,
    grant: typeof connectionGrants.$inferSelect,
    options: { forceRefresh?: boolean } = {},
  ): Promise<Record<string, string>> {
    if (!vercelConnect)
      throw vercelConnectHttpError(
        new VercelConnectClientError("vercel_connect_unavailable", 503),
      );
    const credential = vercelCredentialFor(connection);
    const derived = deriveVercelConnectSubject({
      credential,
      connectionId: connection.id,
      companyId: connection.companyId,
      grantKind: grant.kind,
      subjectUserId: grant.subjectUserId,
    });
    const request = vercelTokenRequest({
      credential,
      grant,
      connectionId: connection.id,
      companyId: connection.companyId,
      resources: vercelConnectResourcesFor(connection),
    });
    try {
      const token = await vercelConnect.getToken(request, options);
      if (
        token.connector.id !== credential.connectorId &&
        token.connector.uid !== credential.connectorUid
      ) {
        throw new VercelConnectClientError(
          "vercel_connect_request_failed",
          502,
        );
      }
      await db
        .update(connectionGrants)
        .set({
          externalCredential: vercelGrantReference({
            credential,
            token,
            subjectId: derived.subjectId,
            verifiedAt: now(),
          }),
          status: "active",
          revokedAt: null,
          updatedAt: now(),
        })
        .where(
          and(
            eq(connectionGrants.id, grant.id),
            eq(connectionGrants.companyId, connection.companyId),
            eq(connectionGrants.connectionId, connection.id),
          ),
        );
      return {
        [credential.headerName]: `${credential.headerPrefix ?? ""}${token.token}`,
      };
    } catch (error) {
      if (
        error instanceof VercelConnectClientError &&
        error.code === "vercel_connect_authorization_required"
      ) {
        await db
          .update(connectionGrants)
          .set({
            status: "needs_reauthorization",
            updatedAt: now(),
          })
          .where(
            and(
              eq(connectionGrants.id, grant.id),
              eq(connectionGrants.companyId, connection.companyId),
            ),
          );
      }
      throw vercelConnectHttpError(error);
    }
  }

  async function vercelGrantForConnection(
    connection: typeof toolConnections.$inferSelect,
    actor?: ActorInfo,
  ) {
    const actorUserId =
      actor?.actorType === "user" ? (actor.actorId ?? null) : null;
    if (actorUserId) {
      const [personal] = await db
        .select()
        .from(connectionGrants)
        .where(
          and(
            eq(connectionGrants.companyId, connection.companyId),
            eq(connectionGrants.connectionId, connection.id),
            eq(connectionGrants.kind, "user"),
            eq(connectionGrants.subjectUserId, actorUserId),
          ),
        )
        .limit(1);
      if (personal) return personal;
    }
    const [organization] = await db
      .select()
      .from(connectionGrants)
      .where(
        and(
          eq(connectionGrants.companyId, connection.companyId),
          eq(connectionGrants.connectionId, connection.id),
          eq(connectionGrants.kind, "organization"),
          eq(connectionGrants.isDefault, true),
        ),
      )
      .limit(1);
    if (!organization) {
      throw conflict("This Vercel Connect identity has not been authorized", {
        code: "vercel_connect_authorization_required",
      });
    }
    return organization;
  }
  return { resolveVercelCredentialHeaders, vercelGrantForConnection };
}

export type VercelCredentialService = ReturnType<typeof createVercelCredentialService>;
