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

export async function executeChatTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<{ ok: true; result: unknown } | { ok: false; error: string }> {
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
