import http from "node:http";
import { z } from "zod";
import { loadConfig } from "../shared/config.js";
import { createBrainDb } from "../db/client.js";
import { createEmbedder } from "../indexer/embedder.js";
import { createTools, type BrainTools } from "./tools.js";
import { authenticate, loadTokensFromEnv } from "./auth.js";
import { logAccess, type ToolName } from "./audit.js";

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

interface DispatchOpts {
  tools: BrainTools;
  defaultAgentId: string;
  body: unknown;
}

interface DispatchResult {
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

async function dispatch({ tools, defaultAgentId, body }: DispatchOpts): Promise<DispatchResult> {
  const parsed = RequestSchema.safeParse(body);
  if (!parsed.success) {
    return {
      status: 400,
      payload: { error: "invalid request", issues: parsed.error.issues },
      audit: {
        tool: "search_vault",
        agentId: defaultAgentId,
        returnedPaths: [],
        ok: false,
      },
    };
  }
  const { tool, args } = parsed.data;

  if (tool === "search_vault") {
    const a = SearchArgsSchema.parse(args);
    const agentId = a.agentId ?? defaultAgentId;
    const result = await tools.search_vault({ ...a, agentId });
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
    const agentId = a.agentId ?? defaultAgentId;
    const result = await tools.get_note({ ...a, agentId });
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
  const agentId = a.agentId ?? defaultAgentId;
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

async function main(): Promise<void> {
  const cfg = loadConfig();
  const handle = createBrainDb(cfg.brainDatabaseUrl);
  const embed = createEmbedder({ baseUrl: cfg.lmStudioUrl, model: cfg.embeddingModel });
  const tools = createTools({ handle, embed });
  const tokens = loadTokensFromEnv();

  if (Object.keys(tokens).length === 0) {
    console.warn(
      "[mcp-server] no bearer tokens configured (BRAIN_PAPERCLIP_TOKEN / BRAIN_CLAUDE_CODE_TOKEN / BRAIN_N8N_TOKEN)",
    );
  }

  const server = http.createServer((req, res) => {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.end(JSON.stringify({ error: "method not allowed" }));
      return;
    }

    const auth = authenticate(req.headers.authorization, tokens);
    if (!auth.ok) {
      res.statusCode = 401;
      res.setHeader("WWW-Authenticate", "Bearer");
      res.end(JSON.stringify({ error: "unauthorized", reason: auth.reason }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", async () => {
      const startedAt = Date.now();
      let body: unknown = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
      } catch {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid JSON" }));
        return;
      }

      try {
        const result = await dispatch({
          tools,
          defaultAgentId: auth.defaultAgentId!,
          body,
        });
        await logAccess(handle.db, {
          ...result.audit,
          latencyMs: Date.now() - startedAt,
        });
        res.statusCode = result.status;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify(result.payload));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await logAccess(handle.db, {
          agentId: auth.defaultAgentId!,
          tool: "search_vault",
          returnedPaths: [],
          latencyMs: Date.now() - startedAt,
          ok: false,
        });
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "internal", message }));
      }
    });
  });

  const shutdown = async (): Promise<void> => {
    console.log("[mcp-server] shutting down...");
    server.close();
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.listen(cfg.mcpPort, () => {
    console.log(`[mcp-server] listening on :${cfg.mcpPort}`);
    console.log(`[mcp-server] tokens loaded: ${Object.keys(tokens).length}`);
  });
}

main().catch((err) => {
  console.error("[mcp-server] fatal:", err);
  process.exit(1);
});
