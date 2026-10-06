import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, isNull } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolConnections, toolMcpConnectors } from "@paperclipai/db";
import {
  MCP_CONNECTOR_CREDENTIAL_PREFIX,
  MCP_CONNECTOR_ENROLLMENT_TOKEN_PREFIX,
  MCP_CONNECTOR_ENROLLMENT_TTL_MS,
  parseMcpConnectorToken,
  type McpConnector,
  type McpConnectorEnrollment,
} from "@paperclipai/shared";
import { conflict, HttpError, notFound } from "../errors.js";
import { mcpConnectorHub, type McpConnectorHub } from "./mcp-connector-hub.js";

type ConnectorRow = typeof toolMcpConnectors.$inferSelect;

function hashSecret(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function hashesEqual(a: string | null, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function mintToken(prefix: string, connectorId: string): string {
  return `${prefix}${connectorId}.${randomBytes(32).toString("base64url")}`;
}

/** Enrollment and credential failures share one message so callers cannot probe token state. */
function invalidToken(): HttpError {
  return new HttpError(401, "The connector token is invalid, expired or revoked.", {
    code: "mcp_connector_token_invalid",
  });
}

export interface McpConnectorServiceOptions {
  hub?: McpConnectorHub;
  now?: () => Date;
  enrollmentTtlMs?: number;
}

export function mcpConnectorService(db: Db, options: McpConnectorServiceOptions = {}) {
  const hub = options.hub ?? mcpConnectorHub;
  const now = () => options.now?.() ?? new Date();
  const enrollmentTtlMs = options.enrollmentTtlMs ?? MCP_CONNECTOR_ENROLLMENT_TTL_MS;

  function toConnector(row: ConnectorRow): McpConnector {
    const session = hub.session(row.id);
    const online = row.status === "active" && session?.companyId === row.companyId;
    return {
      id: row.id,
      companyId: row.companyId,
      name: row.name,
      status: row.status,
      online,
      version: online ? session!.version : row.version,
      upstreams: online ? [...session!.upstreams].sort() : row.upstreams,
      lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
      lastConnectedAt: row.lastConnectedAt?.toISOString() ?? null,
      enrollmentExpiresAt: row.status === "pending" ? row.enrollmentExpiresAt?.toISOString() ?? null : null,
      credentialRotatedAt: row.credentialRotatedAt?.toISOString() ?? null,
      revokedAt: row.revokedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function getRow(companyId: string, connectorId: string): Promise<ConnectorRow> {
    const [row] = await db
      .select()
      .from(toolMcpConnectors)
      .where(and(eq(toolMcpConnectors.id, connectorId), eq(toolMcpConnectors.companyId, companyId)))
      .limit(1);
    if (!row) throw notFound("MCP connector not found");
    return row;
  }

  async function issueEnrollment(row: ConnectorRow): Promise<McpConnectorEnrollment> {
    const token = mintToken(MCP_CONNECTOR_ENROLLMENT_TOKEN_PREFIX, row.id);
    const expiresAt = new Date(now().getTime() + enrollmentTtlMs);
    const [updated] = await db
      .update(toolMcpConnectors)
      .set({
        status: "pending",
        enrollmentTokenHash: hashSecret(token),
        enrollmentExpiresAt: expiresAt,
        enrollmentUsedAt: null,
        credentialHash: null,
        updatedAt: now(),
      })
      .where(and(eq(toolMcpConnectors.id, row.id), eq(toolMcpConnectors.companyId, row.companyId)))
      .returning();
    return {
      connector: toConnector(updated!),
      enrollmentToken: token,
      enrollmentExpiresAt: expiresAt.toISOString(),
    };
  }

  return {
    toConnector,

    list: async (companyId: string): Promise<McpConnector[]> => {
      const rows = await db
        .select()
        .from(toolMcpConnectors)
        .where(eq(toolMcpConnectors.companyId, companyId))
        .orderBy(asc(toolMcpConnectors.name));
      return rows.map(toConnector);
    },

    get: async (companyId: string, connectorId: string): Promise<McpConnector> =>
      toConnector(await getRow(companyId, connectorId)),

    /** Create a connector and return its one-time enrollment token. */
    create: async (
      companyId: string,
      input: { name: string },
      actorUserId: string | null,
    ): Promise<McpConnectorEnrollment> => {
      const [existing] = await db
        .select({ id: toolMcpConnectors.id })
        .from(toolMcpConnectors)
        .where(and(eq(toolMcpConnectors.companyId, companyId), eq(toolMcpConnectors.name, input.name)))
        .limit(1);
      if (existing) throw conflict("An MCP connector with this name already exists", { code: "mcp_connector_name_taken" });
      const [row] = await db
        .insert(toolMcpConnectors)
        .values({ companyId, name: input.name, status: "pending", createdByUserId: actorUserId })
        .returning();
      return issueEnrollment(row!);
    },

    /**
     * Invalidate the current credential, disconnect the connector and issue a
     * fresh enrollment token. Used after a suspected credential leak or when a
     * connector host is rebuilt.
     */
    reenroll: async (companyId: string, connectorId: string): Promise<McpConnectorEnrollment> => {
      const row = await getRow(companyId, connectorId);
      if (row.status === "revoked") throw conflict("A revoked MCP connector cannot be re-enrolled", { code: "mcp_connector_revoked" });
      hub.disconnect(row.id, "reenrolled");
      return issueEnrollment(row);
    },

    /** Revoke permanently. Existing sessions close immediately and in-flight calls fail. */
    revoke: async (companyId: string, connectorId: string): Promise<McpConnector> => {
      const row = await getRow(companyId, connectorId);
      const [updated] = await db
        .update(toolMcpConnectors)
        .set({
          status: "revoked",
          revokedAt: row.revokedAt ?? now(),
          enrollmentTokenHash: null,
          credentialHash: null,
          updatedAt: now(),
        })
        .where(and(eq(toolMcpConnectors.id, row.id), eq(toolMcpConnectors.companyId, companyId)))
        .returning();
      hub.disconnect(row.id, "revoked");
      return toConnector(updated!);
    },

    /** Connections that route through this connector (for UI and revoke impact). */
    connectionCount: async (companyId: string, connectorId: string): Promise<number> => {
      const rows = await db
        .select({ id: toolConnections.id, config: toolConnections.config })
        .from(toolConnections)
        .where(and(eq(toolConnections.companyId, companyId), eq(toolConnections.transport, "connector")));
      return rows.filter((row) => row.config?.connectorId === connectorId).length;
    },

    /** Exchange a one-time enrollment token for a long-lived credential. Single use, time limited. */
    enroll: async (token: string, version?: string): Promise<{ connectorId: string; companyId: string; credential: string }> => {
      const parsed = parseMcpConnectorToken(token, MCP_CONNECTOR_ENROLLMENT_TOKEN_PREFIX);
      if (!parsed) throw invalidToken();
      const credential = mintToken(MCP_CONNECTOR_CREDENTIAL_PREFIX, parsed.connectorId);
      const at = now();
      // Atomic single use: exactly one caller can match the unused, unexpired hash.
      const [row] = await db
        .update(toolMcpConnectors)
        .set({
          status: "active",
          enrollmentTokenHash: null,
          enrollmentUsedAt: at,
          credentialHash: hashSecret(credential),
          credentialRotatedAt: at,
          version: version ? version.slice(0, 64) : null,
          updatedAt: at,
        })
        .where(and(
          eq(toolMcpConnectors.id, parsed.connectorId),
          eq(toolMcpConnectors.enrollmentTokenHash, hashSecret(token)),
          eq(toolMcpConnectors.status, "pending"),
          isNull(toolMcpConnectors.revokedAt),
          isNull(toolMcpConnectors.enrollmentUsedAt),
          gt(toolMcpConnectors.enrollmentExpiresAt, at),
        ))
        .returning();
      if (!row) throw invalidToken();
      return { connectorId: row.id, companyId: row.companyId, credential };
    },

    /** Resolve a long-lived credential to its active connector, or null. */
    authenticate: async (credential: string): Promise<ConnectorRow | null> => {
      const parsed = parseMcpConnectorToken(credential, MCP_CONNECTOR_CREDENTIAL_PREFIX);
      if (!parsed) return null;
      const [row] = await db
        .select()
        .from(toolMcpConnectors)
        .where(eq(toolMcpConnectors.id, parsed.connectorId))
        .limit(1);
      if (!row || row.status !== "active" || row.revokedAt) return null;
      return hashesEqual(row.credentialHash, hashSecret(credential)) ? row : null;
    },

    /** Connector-initiated rotation: the old credential stops working as soon as this returns. */
    rotateCredential: async (credential: string): Promise<{ connectorId: string; credential: string }> => {
      const parsed = parseMcpConnectorToken(credential, MCP_CONNECTOR_CREDENTIAL_PREFIX);
      if (!parsed) throw invalidToken();
      const next = mintToken(MCP_CONNECTOR_CREDENTIAL_PREFIX, parsed.connectorId);
      const [row] = await db
        .update(toolMcpConnectors)
        .set({ credentialHash: hashSecret(next), credentialRotatedAt: now(), updatedAt: now() })
        .where(and(
          eq(toolMcpConnectors.id, parsed.connectorId),
          eq(toolMcpConnectors.credentialHash, hashSecret(credential)),
          eq(toolMcpConnectors.status, "active"),
          isNull(toolMcpConnectors.revokedAt),
        ))
        .returning({ id: toolMcpConnectors.id });
      if (!row) throw invalidToken();
      return { connectorId: row.id, credential: next };
    },

    recordConnected: async (connectorId: string, input: { version: string; upstreams: string[] }) => {
      const at = now();
      await db
        .update(toolMcpConnectors)
        .set({ version: input.version, upstreams: input.upstreams, lastConnectedAt: at, lastSeenAt: at, updatedAt: at })
        .where(eq(toolMcpConnectors.id, connectorId));
    },

    recordSeen: async (connectorId: string) => {
      await db.update(toolMcpConnectors).set({ lastSeenAt: now() }).where(eq(toolMcpConnectors.id, connectorId));
    },

    /** Per-request re-validation used by the hub: existence, company binding, active status, and credential matching. */
    verify: async (input: { connectorId: string; companyId: string; credential?: string }): Promise<"active" | "revoked" | "not_found"> => {
      const [row] = await db
        .select({
          status: toolMcpConnectors.status,
          revokedAt: toolMcpConnectors.revokedAt,
          credentialHash: toolMcpConnectors.credentialHash,
        })
        .from(toolMcpConnectors)
        .where(and(eq(toolMcpConnectors.id, input.connectorId), eq(toolMcpConnectors.companyId, input.companyId)))
        .limit(1);
      if (!row) return "not_found";
      if (row.status !== "active" || row.revokedAt) return "revoked";
      if (input.credential && (!row.credentialHash || !hashesEqual(row.credentialHash, hashSecret(input.credential)))) {
        return "revoked";
      }
      return "active";
    },

    /** Validate a `transport: "connector"` target when a connection is created or updated. */
    assertConnectionTarget: async (companyId: string, config: Record<string, unknown>) => {
      const connectorId = typeof config.connectorId === "string" ? config.connectorId : "";
      const [row] = /^[0-9a-f-]{36}$/i.test(connectorId)
        ? await db
            .select()
            .from(toolMcpConnectors)
            .where(and(eq(toolMcpConnectors.id, connectorId), eq(toolMcpConnectors.companyId, companyId)))
            .limit(1)
        : [];
      if (!row) {
        throw new HttpError(422, "Choose an MCP connector from this company", { code: "connector_not_found" });
      }
      if (row.status === "revoked") {
        throw new HttpError(422, "This MCP connector was revoked", { code: "connector_revoked" });
      }
      return row;
    },
  };
}

export type McpConnectorService = ReturnType<typeof mcpConnectorService>;
