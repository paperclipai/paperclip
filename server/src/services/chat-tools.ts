import { randomUUID } from "node:crypto";
import { z, type ZodTypeAny } from "zod";
import { and, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  companyMemberships,
  issueComments,
  issues,
} from "@paperclipai/db";
import { forbidden, notFound } from "../errors.js";
import { logger } from "../middleware/logger.js";
import type { PluginToolDispatcher } from "./plugin-tool-dispatcher.js";

export type ToolActor = {
  userId: string;
  isInstanceAdmin: boolean;
  companyIds: string[];
};

export interface ToolContext {
  db: Db;
  actor: ToolActor;
  defaultCompanyId: string | null;
}

export interface AnthropicToolSpec {
  name: string;
  description: string;
  input_schema: {
    type: "object";
    properties: Record<string, unknown>;
    required?: string[];
  };
}

export interface ChatToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  mutating: boolean;
  inputSchema: ZodTypeAny;
  spec: AnthropicToolSpec;
  handler: (input: TInput, ctx: ToolContext) => Promise<unknown>;
}

async function assertCompanyAccess(ctx: ToolContext, companyId: string) {
  if (ctx.actor.isInstanceAdmin) return;
  if (!ctx.actor.companyIds.includes(companyId)) {
    throw forbidden(`No access to company ${companyId}`);
  }
}

async function resolveAccessibleCompanyIds(ctx: ToolContext): Promise<string[]> {
  if (ctx.actor.isInstanceAdmin) {
    const rows = await ctx.db.select({ id: companies.id }).from(companies);
    return rows.map((r) => r.id);
  }
  return ctx.actor.companyIds;
}

function summarizeIssue(row: typeof issues.$inferSelect) {
  return {
    id: row.id,
    identifier: row.identifier,
    companyId: row.companyId,
    title: row.title,
    status: row.status,
    priority: row.priority,
    assigneeAgentId: row.assigneeAgentId,
    assigneeUserId: row.assigneeUserId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const listCompaniesTool: ChatToolDefinition<Record<string, never>> = {
  name: "list_companies",
  description:
    "List all companies the current board user has access to. Returns id, name, issuePrefix, status. Always allowed (read-only).",
  mutating: false,
  inputSchema: z.object({}),
  spec: {
    name: "list_companies",
    description: "List all companies the current board user has access to.",
    input_schema: { type: "object", properties: {} },
  },
  async handler(_input, ctx) {
    const ids = await resolveAccessibleCompanyIds(ctx);
    if (ids.length === 0) return { companies: [] };
    const rows = await ctx.db
      .select({
        id: companies.id,
        name: companies.name,
        issuePrefix: companies.issuePrefix,
        status: companies.status,
        description: companies.description,
      })
      .from(companies)
      .where(inArray(companies.id, ids));
    return { companies: rows };
  },
};

const getCompanyTool: ChatToolDefinition<{ companyId: string }> = {
  name: "get_company",
  description: "Get details for one company by id (or issue prefix).",
  mutating: false,
  inputSchema: z.object({ companyId: z.string().min(1) }),
  spec: {
    name: "get_company",
    description: "Get details for one company by id.",
    input_schema: {
      type: "object",
      properties: { companyId: { type: "string", description: "Company UUID" } },
      required: ["companyId"],
    },
  },
  async handler({ companyId }, ctx) {
    await assertCompanyAccess(ctx, companyId);
    const row = await ctx.db
      .select()
      .from(companies)
      .where(eq(companies.id, companyId))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound(`Company ${companyId} not found`);
    return {
      id: row.id,
      name: row.name,
      issuePrefix: row.issuePrefix,
      status: row.status,
      description: row.description,
      brandColor: row.brandColor,
      requireBoardApprovalForNewAgents: row.requireBoardApprovalForNewAgents,
    };
  },
};

const listAgentsTool: ChatToolDefinition<{ companyId?: string }> = {
  name: "list_agents",
  description: "List agents in a company. Defaults to the current selected company.",
  mutating: false,
  inputSchema: z.object({ companyId: z.string().optional() }),
  spec: {
    name: "list_agents",
    description: "List agents in a company. Pass companyId to scope, or omit to use current company.",
    input_schema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Company UUID. Optional; defaults to current." },
      },
    },
  },
  async handler({ companyId }, ctx) {
    const target = companyId ?? ctx.defaultCompanyId;
    if (!target) {
      throw forbidden("No company context: pass companyId or select a company first");
    }
    await assertCompanyAccess(ctx, target);
    const rows = await ctx.db
      .select({
        id: agents.id,
        name: agents.name,
        role: agents.role,
        title: agents.title,
        status: agents.status,
        adapterType: agents.adapterType,
      })
      .from(agents)
      .where(eq(agents.companyId, target));
    return { companyId: target, agents: rows };
  },
};

const getAgentTool: ChatToolDefinition<{ agentId: string }> = {
  name: "get_agent",
  description: "Get details for one agent by id.",
  mutating: false,
  inputSchema: z.object({ agentId: z.string().min(1) }),
  spec: {
    name: "get_agent",
    description: "Get details for one agent by id.",
    input_schema: {
      type: "object",
      properties: { agentId: { type: "string" } },
      required: ["agentId"],
    },
  },
  async handler({ agentId }, ctx) {
    const row = await ctx.db
      .select()
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound(`Agent ${agentId} not found`);
    await assertCompanyAccess(ctx, row.companyId);
    return {
      id: row.id,
      name: row.name,
      role: row.role,
      title: row.title,
      status: row.status,
      companyId: row.companyId,
      adapterType: row.adapterType,
      reportsTo: row.reportsTo,
      capabilities: row.capabilities,
    };
  },
};

const listIssuesTool: ChatToolDefinition<{
  companyId?: string;
  status?: string;
  limit?: number;
}> = {
  name: "list_issues",
  description: "List issues in a company. Optional status filter (e.g. backlog, in_progress, done).",
  mutating: false,
  inputSchema: z.object({
    companyId: z.string().optional(),
    status: z.string().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  spec: {
    name: "list_issues",
    description:
      "List issues in a company. Optional status filter. Returns up to 50 most recent by default.",
    input_schema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Optional. Defaults to current company." },
        status: { type: "string", description: "Optional status filter." },
        limit: { type: "integer", description: "Max issues to return (1-100). Default 50." },
      },
    },
  },
  async handler({ companyId, status, limit = 50 }, ctx) {
    const target = companyId ?? ctx.defaultCompanyId;
    if (!target) {
      throw forbidden("No company context: pass companyId or select a company first");
    }
    await assertCompanyAccess(ctx, target);
    const conditions = status
      ? and(eq(issues.companyId, target), eq(issues.status, status))
      : eq(issues.companyId, target);
    const rows = await ctx.db
      .select()
      .from(issues)
      .where(conditions)
      .orderBy(desc(issues.updatedAt))
      .limit(limit);
    return { companyId: target, issues: rows.map(summarizeIssue) };
  },
};

const getIssueTool: ChatToolDefinition<{ issueId: string }> = {
  name: "get_issue",
  description: "Get a single issue with its comments.",
  mutating: false,
  inputSchema: z.object({ issueId: z.string().min(1) }),
  spec: {
    name: "get_issue",
    description: "Get a single issue with its comments.",
    input_schema: {
      type: "object",
      properties: { issueId: { type: "string" } },
      required: ["issueId"],
    },
  },
  async handler({ issueId }, ctx) {
    const row = await ctx.db
      .select()
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0] ?? null);
    if (!row) throw notFound(`Issue ${issueId} not found`);
    await assertCompanyAccess(ctx, row.companyId);
    const comments = await ctx.db
      .select({
        id: issueComments.id,
        body: issueComments.body,
        authorAgentId: issueComments.authorAgentId,
        authorUserId: issueComments.authorUserId,
        createdAt: issueComments.createdAt,
      })
      .from(issueComments)
      .where(eq(issueComments.issueId, issueId))
      .orderBy(issueComments.createdAt);
    return {
      issue: { ...summarizeIssue(row), description: row.description },
      comments: comments.map((c) => ({
        id: c.id,
        body: c.body,
        authorAgentId: c.authorAgentId,
        authorUserId: c.authorUserId,
        createdAt: c.createdAt.toISOString(),
      })),
    };
  },
};

const createIssueTool: ChatToolDefinition<{
  companyId?: string;
  title: string;
  description?: string;
}> = {
  name: "create_issue",
  description: "Create a new issue in a company. Mutating — requires permission.",
  mutating: true,
  inputSchema: z.object({
    companyId: z.string().optional(),
    title: z.string().min(1).max(500),
    description: z.string().max(10_000).optional(),
  }),
  spec: {
    name: "create_issue",
    description: "Create a new issue. Pass companyId or it uses the current company.",
    input_schema: {
      type: "object",
      properties: {
        companyId: { type: "string", description: "Optional. Defaults to current company." },
        title: { type: "string" },
        description: { type: "string" },
      },
      required: ["title"],
    },
  },
  async handler({ companyId, title, description }, ctx) {
    const target = companyId ?? ctx.defaultCompanyId;
    if (!target) {
      throw forbidden("No company context: pass companyId or select a company first");
    }
    await assertCompanyAccess(ctx, target);
    const created = await ctx.db
      .insert(issues)
      .values({
        companyId: target,
        title,
        description: description ?? null,
        createdByUserId: ctx.actor.userId,
        originKind: "chat",
      })
      .returning()
      .then((rows) => rows[0]);
    return { issue: summarizeIssue(created) };
  },
};

const addCommentTool: ChatToolDefinition<{ issueId: string; body: string }> = {
  name: "add_comment",
  description: "Add a comment to an issue. Mutating — requires permission.",
  mutating: true,
  inputSchema: z.object({
    issueId: z.string().min(1),
    body: z.string().min(1).max(20_000),
  }),
  spec: {
    name: "add_comment",
    description: "Add a comment to an issue.",
    input_schema: {
      type: "object",
      properties: {
        issueId: { type: "string" },
        body: { type: "string" },
      },
      required: ["issueId", "body"],
    },
  },
  async handler({ issueId, body }, ctx) {
    const issueRow = await ctx.db
      .select({ id: issues.id, companyId: issues.companyId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((r) => r[0] ?? null);
    if (!issueRow) throw notFound(`Issue ${issueId} not found`);
    await assertCompanyAccess(ctx, issueRow.companyId);
    const created = await ctx.db
      .insert(issueComments)
      .values({
        companyId: issueRow.companyId,
        issueId,
        body,
        authorUserId: ctx.actor.userId,
      })
      .returning()
      .then((rows) => rows[0]);
    return {
      comment: {
        id: created.id,
        issueId: created.issueId,
        body: created.body,
        authorUserId: created.authorUserId,
        createdAt: created.createdAt.toISOString(),
      },
    };
  },
};

export const CHAT_TOOLS: ChatToolDefinition[] = [
  listCompaniesTool,
  getCompanyTool,
  listAgentsTool,
  getAgentTool,
  listIssuesTool,
  getIssueTool,
  createIssueTool,
  addCommentTool,
] as ChatToolDefinition[];

const TOOLS_BY_NAME: Record<string, ChatToolDefinition> = Object.fromEntries(
  CHAT_TOOLS.map((tool) => [tool.name, tool]),
);

export function getChatTool(name: string): ChatToolDefinition | undefined {
  return TOOLS_BY_NAME[name];
}

export function listChatToolSpecs(): AnthropicToolSpec[] {
  return CHAT_TOOLS.map((t) => t.spec);
}

// ─── Plugin tools bridge ──────────────────────────────────────────────
//
// Plugin tools (e.g. `3cx-tools:pbx_click_to_call`) are registered with
// `PluginToolDispatcher` and live on a different surface than the
// hardcoded chat tools above. To let chat-Agent mode invoke them, we
// project each plugin tool into the same `AnthropicToolSpec` shape and
// route execution back through the dispatcher.
//
// Anthropic / Bedrock / Gemini tool names must match
// `^[a-zA-Z0-9_-]{1,64}$` — no colons. The plugin namespaced name
// `<pluginKey>:<toolName>` is converted to `<pluginKey>__<toolName>`
// using a double-underscore separator (only the FIRST colon is replaced
// so plugin tool names that contain underscores are unaffected). The
// reverse mapping happens at execute time.

const PLUGIN_TOOL_SEPARATOR = "__";

function pluginToolToChatName(namespacedName: string): string {
  // "3cx-tools:pbx_click_to_call" -> "3cx-tools__pbx_click_to_call"
  const idx = namespacedName.indexOf(":");
  if (idx < 0) return namespacedName;
  return (
    namespacedName.slice(0, idx) +
    PLUGIN_TOOL_SEPARATOR +
    namespacedName.slice(idx + 1)
  );
}

function chatNameToPluginTool(chatName: string): string {
  // "3cx-tools__pbx_click_to_call" -> "3cx-tools:pbx_click_to_call"
  const idx = chatName.indexOf(PLUGIN_TOOL_SEPARATOR);
  if (idx < 0) return chatName;
  return (
    chatName.slice(0, idx) +
    ":" +
    chatName.slice(idx + PLUGIN_TOOL_SEPARATOR.length)
  );
}

/**
 * True if the chat-name looks like a plugin tool name we projected
 * (contains `__`). None of the hardcoded chat tools above use that
 * separator, so this is a clean partition.
 */
export function isPluginChatToolName(chatName: string): boolean {
  return chatName.includes(PLUGIN_TOOL_SEPARATOR);
}

/**
 * Enumerate plugin tools as AnthropicToolSpec[] for inclusion in a
 * chat-Agent session's tool list. Returns [] when the session has no
 * company in scope (every plugin tool would fail ECOMPANY_NOT_ALLOWED
 * without one — exposing them to the LLM would just lead to confusing
 * errors).
 */
export async function listPluginToolSpecsForChat(
  dispatcher: PluginToolDispatcher | null,
  companyId: string | null,
): Promise<AnthropicToolSpec[]> {
  if (!dispatcher || !companyId) return [];
  let tools;
  try {
    tools = await dispatcher.listToolsForAgent({ companyId });
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), companyId },
      "Failed to list plugin tools for chat — proceeding without",
    );
    return [];
  }
  return tools.map((t) => ({
    name: pluginToolToChatName(t.name),
    description: `${t.displayName} — ${t.description}`,
    input_schema: t.parametersSchema as AnthropicToolSpec["input_schema"],
  }));
}

/**
 * Execute a plugin tool that was surfaced into a chat-Agent session.
 * Builds a synthetic `runContext` (`agentId="clippy:<userId>"`, fresh
 * runId) since chat-Agent isn't an agent run. The plugin worker only
 * uses agentId/runId for telemetry; companyId is the security-relevant
 * field and that comes from the session.
 */
export async function executePluginChatTool(
  dispatcher: PluginToolDispatcher | null,
  chatName: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  if (!dispatcher) {
    return {
      ok: false,
      error: "Plugin tool dispatch is not enabled on this server.",
    };
  }
  if (!ctx.defaultCompanyId) {
    return {
      ok: false,
      error:
        "No company in scope. Plugin tools require a company — pin one on the chat session or ask the user which company they mean.",
    };
  }
  const namespacedName = chatNameToPluginTool(chatName);
  const runContext = {
    agentId: `clippy:${ctx.actor.userId}`,
    runId: randomUUID(),
    companyId: ctx.defaultCompanyId,
    projectId: "",
  };
  try {
    const exec = await dispatcher.executeTool(namespacedName, rawInput, runContext);
    if (exec.result.error) return { ok: false, error: exec.result.error };
    return {
      ok: true,
      result: exec.result.data ?? exec.result.content ?? null,
    };
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), tool: namespacedName },
      "Plugin chat tool execution failed",
    );
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export async function executeChatTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
  dispatcher?: PluginToolDispatcher | null,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
  if (isPluginChatToolName(name)) {
    return executePluginChatTool(dispatcher ?? null, name, rawInput, ctx);
  }
  const tool = getChatTool(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
  const parsed = tool.inputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `Invalid input: ${parsed.error.message}` };
  }
  try {
    const result = await tool.handler(parsed.data, ctx);
    return { ok: true, result };
  } catch (err) {
    if (err && typeof err === "object" && "status" in err && "message" in err) {
      return { ok: false, error: String((err as { message: string }).message) };
    }
    logger.error({ err, tool: name }, "Chat tool execution failed");
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// Resolve the active companyId for the actor. Falls back to the first
// accessible company when the session didn't pin one.
export async function resolveDefaultCompanyId(
  db: Db,
  actor: ToolActor,
  preferredId: string | null,
): Promise<string | null> {
  if (preferredId) {
    if (actor.isInstanceAdmin || actor.companyIds.includes(preferredId)) {
      return preferredId;
    }
  }
  if (actor.companyIds.length > 0) return actor.companyIds[0];
  if (actor.isInstanceAdmin) {
    const row = await db
      .select({ id: companies.id })
      .from(companies)
      .limit(1)
      .then((r) => r[0] ?? null);
    return row?.id ?? null;
  }
  return null;
}

// Make TS happy about the unused membership import which we may need later.
void companyMemberships;
