import { and, desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolMcpAppViews } from "@paperclipai/db";
import { getAppDefinitionForApplicationKey, type McpAppCallToolResult, type McpAppToolUi, type McpAppViewSummary } from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";

/** Views shown per task. The chat renders the newest calls; older ones fall back to the plain tool row. */
const MAX_VIEWS_PER_ISSUE = 200;
/** A result larger than this is not kept for the view; the tool row still shows it. */
const MAX_STORED_RESULT_BYTES = 512 * 1024;

type ViewRow = typeof toolMcpAppViews.$inferSelect;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** The tool's MCP Apps view declaration, when it was discovered from an MCP server. */
export function mcpAppToolUi(tool: { providerType?: string; providerMetadata?: unknown }): (McpAppToolUi & { resourceUri: string }) | null {
  if (tool.providerType !== "mcp_remote_http" && tool.providerType !== "mcp_local_stdio") return null;
  const ui = record(record(tool.providerMetadata)?.ui);
  return typeof ui?.resourceUri === "string" ? ui as unknown as McpAppToolUi & { resourceUri: string } : null;
}

/**
 * Converts the gateway's normalized MCP result (`{ content, data: { content,
 * structuredContent, isError } }`) and the provider `_meta` back to the MCP
 * `CallToolResult` the view expects.
 */
export function mcpAppCallToolResult(result: unknown, resultMeta?: unknown): McpAppCallToolResult {
  const normalized = record(result);
  const data = record(normalized?.data);
  const content = Array.isArray(data?.content)
    ? data.content
    : typeof normalized?.content === "string" ? [{ type: "text", text: normalized.content }] : [];
  const structuredContent = record(data?.structuredContent);
  const meta = record(resultMeta);
  return {
    content,
    ...(structuredContent ? { structuredContent } : {}),
    ...(meta ? { _meta: meta } : {}),
    ...(data?.isError === true ? { isError: true } : {}),
  };
}

/**
 * Records a completed call whose tool declares an MCP Apps view, so the task
 * chat can render it. Best effort: the agent's tool call never fails because
 * its view could not be kept.
 */
export async function recordMcpAppView(db: Db, input: {
  session: { companyId: string; agentId: string | null; runId: string | null; issueId: string | null; responsibleUserId?: string | null };
  tool: {
    name: string;
    providerType?: string;
    providerMetadata?: unknown;
    connectionId?: string | null;
    catalogEntryId?: string | null;
    upstreamToolName?: string | null;
    applicationDisplayName?: string | null;
    applicationKey?: string | null;
  };
  invocationId: string;
  toolInput: unknown;
  result: unknown;
  /** The redacted provider `_meta`, which is never part of the agent's result. */
  resultMeta?: unknown;
}): Promise<void> {
  const ui = mcpAppToolUi(input.tool);
  if (!ui || !input.tool.connectionId) return;
  try {
    const toolResult = mcpAppCallToolResult(input.result, input.resultMeta);
    if (Buffer.byteLength(JSON.stringify(toolResult), "utf8") > MAX_STORED_RESULT_BYTES) return;
    await db.insert(toolMcpAppViews).values({
      companyId: input.session.companyId,
      invocationId: input.invocationId,
      issueId: input.session.issueId,
      runId: input.session.runId,
      agentId: input.session.agentId,
      responsibleUserId: input.session.responsibleUserId ?? null,
      connectionId: input.tool.connectionId,
      catalogEntryId: input.tool.catalogEntryId ?? null,
      // The catalog app's name ("Circleback"), not the connection's ("Circleback for the organization").
      applicationName: getAppDefinitionForApplicationKey(input.tool.applicationKey)?.name ?? input.tool.applicationDisplayName ?? "App",
      toolName: input.tool.name,
      upstreamToolName: input.tool.upstreamToolName ?? input.tool.name,
      resourceUri: ui.resourceUri,
      toolInput: record(input.toolInput) ?? {},
      toolResult: toolResult as unknown as Record<string, unknown>,
    });
  } catch (error) {
    logger.warn({ err: error, invocationId: input.invocationId }, "Could not record MCP App view");
  }
}

export function toMcpAppViewSummary(row: ViewRow): McpAppViewSummary {
  return {
    id: row.id,
    issueId: row.issueId,
    runId: row.runId,
    connectionId: row.connectionId,
    applicationName: row.applicationName,
    toolName: row.toolName,
    upstreamToolName: row.upstreamToolName,
    resourceUri: row.resourceUri,
    toolInput: row.toolInput,
    createdAt: row.createdAt.toISOString(),
  };
}

export function mcpAppViewsService(db: Db) {
  return {
    async listForIssue(companyId: string, issueId: string): Promise<McpAppViewSummary[]> {
      const rows = await db.select().from(toolMcpAppViews)
        .where(and(eq(toolMcpAppViews.companyId, companyId), eq(toolMcpAppViews.issueId, issueId)))
        .orderBy(desc(toolMcpAppViews.createdAt))
        .limit(MAX_VIEWS_PER_ISSUE);
      return rows.reverse().map(toMcpAppViewSummary);
    },

    async get(companyId: string, viewId: string): Promise<ViewRow | null> {
      const [row] = await db.select().from(toolMcpAppViews)
        .where(and(eq(toolMcpAppViews.companyId, companyId), eq(toolMcpAppViews.id, viewId)))
        .limit(1);
      return row ?? null;
    },
  };
}
