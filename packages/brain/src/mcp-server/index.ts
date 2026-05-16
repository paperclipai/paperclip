import http from "node:http";
import { loadConfig } from "../shared/config.js";
import { createBrainDb } from "../db/client.js";
import { createEmbedder } from "../indexer/embedder.js";
import { createTools } from "./tools.js";
import { authenticate, loadTokensFromEnv } from "./auth.js";
import { logAccess } from "./audit.js";
import { dispatch } from "./dispatcher.js";

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
          identity: auth.identity!,
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
          agentId: auth.identity!.defaultAgentId,
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
