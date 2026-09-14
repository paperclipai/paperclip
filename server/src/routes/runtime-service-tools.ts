import { Router } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { HttpError, forbidden, unauthorized } from "../errors.js";
import { verifyRuntimeToolsToken } from "../runtime-tools-token.js";
import type { RuntimeServiceOperations } from "../services/runtime-services/operations.js";
import { authorizeRuntimeService } from "../services/runtime-services/authorization.js";
import { resolveRuntimeServiceToolActor } from "../services/runtime-services/tool-actor.js";
import { RUNTIME_SERVICE_TOOL_DEFINITIONS, executeRuntimeServiceTool, isRuntimeServiceTool, runtimeServiceToolMutates } from "../services/runtime-services/tools.js";

const callSchema = z.object({ name: z.string(), arguments: z.unknown().optional(), _meta: z.record(z.string(), z.unknown()).optional() }).strict();
const requestSchema = z.object({
  jsonrpc: z.literal("2.0"), id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(), params: z.unknown().optional(),
}).strict();
function content(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: { result: value } };
}

/** Narrow run capability; never accepts an agent API key, board cookie, or connection-intent token. */
export function runtimeServiceToolRoutes(db: Db, operations: RuntimeServiceOperations) {
  const router = Router();
  const endpoints = ["/mcp/runtime-services", "/runtime-tools/services/call"];
  router.use(endpoints, async (req, res, next) => {
    if (req.headers.origin || req.headers.cookie || req.headers["sec-fetch-site"]) throw forbidden("Service tools require runtime authentication");
    const bearer = /^Bearer\s+(.+)$/i.exec(req.get("authorization") ?? "")?.[1] ?? "";
    const claims = verifyRuntimeToolsToken(bearer, "runtime_services");
    if (!claims) throw unauthorized("Invalid or expired service capability");
    const actor = await resolveRuntimeServiceToolActor(db, {
      companyId: claims.company_id, agentId: claims.sub, runId: claims.run_id,
    }, "services_list");
    await authorizeRuntimeService(db, actor.req, { companyId: claims.company_id });
    res.locals.serviceTools = { ...actor, companyId: claims.company_id };
    res.setHeader("Cache-Control", "no-store");
    next();
  });
  async function call(scope: { req: import("express").Request; companyId: string; workMode: string }, params: unknown) {
    const parsed = callSchema.parse(params);
    // The responsible-user write boundary uses HTTP method semantics too.
    scope.req.method = runtimeServiceToolMutates(parsed.name) ? "POST" : "GET";
    return executeRuntimeServiceTool({ operations, ...scope, name: parsed.name, arguments: parsed.arguments ?? {} });
  }
  router.post("/runtime-tools/services/call", async (req, res) => {
    res.json(await call(res.locals.serviceTools, req.body));
  });
  router.post("/mcp/runtime-services", async (req, res) => {
    const parsed = requestSchema.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } }); return; }
    const request = parsed.data;
    const id = request.id ?? null;
    const reply = (result: unknown) => res.json({ jsonrpc: "2.0", id, result });
    const fault = (code: number, message: string) => res.json({ jsonrpc: "2.0", id, error: { code, message } });
    if (request.method.startsWith("notifications/")) { res.status(202).end(); return; }
    if (request.id === undefined) { fault(-32600, "Requests require an id"); return; }
    if (request.method === "initialize") {
      reply({ protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "paperclip-services", version: "1" } }); return;
    }
    if (request.method === "ping") { reply({}); return; }
    if (request.method === "tools/list") {
      reply({ tools: RUNTIME_SERVICE_TOOL_DEFINITIONS.filter((tool) => res.locals.serviceTools.workMode === "standard" || !runtimeServiceToolMutates(tool.name)) }); return;
    }
    if (request.method !== "tools/call") { fault(-32601, "Unknown method"); return; }
    const params = callSchema.safeParse(request.params);
    if (!params.success || !isRuntimeServiceTool(params.data.name)) { fault(-32602, "Unknown tool or invalid arguments"); return; }
    try {
      reply(content(await call(res.locals.serviceTools, params.data)));
    } catch (error) {
      if (error instanceof z.ZodError) { fault(-32602, "Invalid service arguments"); return; }
      const value = error instanceof HttpError
        ? { status: error.status, error: error.message }
        : { status: 500, error: "Service operation failed. Inspect the service and retry with the same request ID." };
      reply({ ...content(value), isError: true });
    }
  });
  // Stateless Streamable HTTP: no server event stream or persistent MCP session.
  router.get("/mcp/runtime-services", (_req, res) => { res.set("Allow", "POST").status(405).end(); });
  router.delete("/mcp/runtime-services", (_req, res) => { res.status(204).end(); });
  return router;
}
