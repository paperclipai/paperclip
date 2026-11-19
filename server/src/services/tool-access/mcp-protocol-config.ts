import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolConnections } from "@paperclipai/db";

/** What MCP negotiation learns about a server and saves on its connection. */
export type McpNegotiationFields = {
  mcpProtocolVersion?: string;
  mcpSessionRequired?: true;
};

/**
 * Save negotiated MCP fields without overwriting anything else. Only these keys
 * are merged into the connection's current stored config, so an operator edit
 * made while a provider request was in flight is kept. When the connection's
 * URL changed meanwhile, nothing is saved: the result describes another server.
 * Returns the stored config after the merge, or null when it was skipped.
 */
export async function saveMcpNegotiation(
  db: Db,
  connection: Pick<typeof toolConnections.$inferSelect, "id" | "companyId" | "config">,
  fields: McpNegotiationFields,
): Promise<{ config: Record<string, unknown>; transportConfig: Record<string, unknown> } | null> {
  if (Object.keys(fields).length === 0) return null;
  const patch = JSON.stringify(fields);
  const negotiatedUrl = typeof connection.config.url === "string" ? connection.config.url : null;
  const [row] = await db
    .update(toolConnections)
    .set({
      config: sql`${toolConnections.config} || ${patch}::jsonb`,
      transportConfig: sql`${toolConnections.transportConfig} || ${patch}::jsonb`,
      updatedAt: new Date(),
    })
    .where(and(
      eq(toolConnections.id, connection.id),
      eq(toolConnections.companyId, connection.companyId),
      negotiatedUrl === null
        ? sql`${toolConnections.config}->>'url' is null`
        : sql`${toolConnections.config}->>'url' = ${negotiatedUrl}`,
    ))
    .returning({ config: toolConnections.config, transportConfig: toolConnections.transportConfig });
  return row ?? null;
}
