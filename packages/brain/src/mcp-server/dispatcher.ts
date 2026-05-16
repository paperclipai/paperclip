import { z } from "zod";
import type { BrainTools } from "./tools.js";
import type { ToolName } from "./audit.js";
import type { TokenIdentity } from "./auth.js";

const RequestSchema = z.object({
  tool: z.enum(["search_vault", "get_note", "list_scope"]),
  args: z.record(z.string(), z.unknown()).default({}),
});

const SearchArgsSchema = z.object({
  query: z.string().min(1),
  agentId: z.string().optional(),
  limit: z.number().int().positive().max(50).optional(),
  folderFilter: z.array(z.string()).optional(),
});

const GetNoteArgsSchema = z.object({
  path: z.string().min(1),
  agentId: z.string().optional(),
});

const ListScopeArgsSchema = z.object({
  agentId: z.string().optional(),
});

export interface DispatchOpts {
  tools: BrainTools;
  identity: TokenIdentity;
  body: unknown;
}

export interface DispatchResult {
  status: number;
  payload: unknown;
  audit: {
    tool: ToolName;
    agentId: string;
    query?: string;
    path?: string;
    returnedPaths: string[];
    ok: boolean;
  };
}

function resolveAgentId(
  requested: string | undefined,
  identity: TokenIdentity,
): { ok: true; agentId: string } | { ok: false; requested: string } {
  const target = requested ?? identity.defaultAgentId;
  if (!identity.allowedAgentIds.includes(target)) {
    return { ok: false, requested: target };
  }
  return { ok: true, agentId: target };
}

function forbidden(tool: ToolName, identity: TokenIdentity, requested: string): DispatchResult {
  return {
    status: 403,
    payload: {
      error: "agentId not allowed for this bearer token",
      requestedAgentId: requested,
    },
    audit: {
      tool,
      agentId: identity.defaultAgentId,
      returnedPaths: [],
      ok: false,
    },
  };
}

export async function dispatch({ tools, identity, body }: DispatchOpts): Promise<DispatchResult> {
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: 400,
      payload: { error: "invalid request", issues: parsed.error.issues },
      audit: {
        tool: "search_vault",
        agentId: identity.defaultAgentId,
        returnedPaths: [],
        ok: false,
      },
    };
  }
  const { tool, args } = parsed.data;

  if (tool === "search_vault") {
    const a = SearchArgsSchema.parse(args);
    const resolved = resolveAgentId(a.agentId, identity);
    if (!resolved.ok) return forbidden(tool, identity, resolved.requested);
    const { agentId } = resolved;
    const { agentId: _omit, ...rest } = a;
    const result = await tools.search_vault({ ...rest, agentId });
    return {
      status: 200,
      payload: { result },
      audit: {
        tool,
        agentId,
        query: a.query,
        returnedPaths: result.map((r) => r.path),
        ok: true,
      },
    };
  }

  if (tool === "get_note") {
    const a = GetNoteArgsSchema.parse(args);
    const resolved = resolveAgentId(a.agentId, identity);
    if (!resolved.ok) return forbidden(tool, identity, resolved.requested);
    const { agentId } = resolved;
    const result = await tools.get_note({ path: a.path, agentId });
    return {
      status: 200,
      payload: { result },
      audit: {
        tool,
        agentId,
        path: a.path,
        returnedPaths: result ? [result.path] : [],
        ok: true,
      },
    };
  }

  // list_scope
  const a = ListScopeArgsSchema.parse(args);
  const resolved = resolveAgentId(a.agentId, identity);
  if (!resolved.ok) return forbidden(tool, identity, resolved.requested);
  const { agentId } = resolved;
  const result = await tools.list_scope({ agentId });
  return {
    status: 200,
    payload: { result },
    audit: {
      tool,
      agentId,
      returnedPaths: [],
      ok: true,
    },
  };
}
