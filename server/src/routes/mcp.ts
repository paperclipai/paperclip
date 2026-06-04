import { Router, type Request, type Response } from "express";
import {
  handlePaperclipStreamableHttpRequest,
  normalizeApiUrl,
  type PaperclipMcpConfig,
} from "@paperclipai/mcp-server";

function bearerToken(req: Request): string | null {
  const header = req.header("authorization");
  if (!header?.toLowerCase().startsWith("bearer ")) return null;
  const token = header.slice("bearer ".length).trim();
  return token.length > 0 ? token : null;
}

function headerValue(req: Request, name: string): string | null {
  const value = req.header(name)?.trim();
  return value ? value : null;
}

function requestOrigin(req: Request): string {
  const forwardedProto = headerValue(req, "x-forwarded-proto");
  const proto = forwardedProto?.split(",")[0]?.trim() || req.protocol;
  return `${proto}://${req.get("host")}`;
}

export function resolvePaperclipMcpConfigFromRequest(req: Request): PaperclipMcpConfig | null {
  const apiKey = bearerToken(req);
  if (!apiKey || req.actor.type === "none") return null;

  const actorCompanyIds = req.actor.type === "board" ? req.actor.companyIds ?? [] : [];
  const companyId =
    headerValue(req, "x-paperclip-company-id") ??
    req.actor.companyId ??
    (actorCompanyIds.length === 1 ? actorCompanyIds[0] ?? null : null) ??
    process.env.PAPERCLIP_COMPANY_ID ??
    null;
  const agentId =
    headerValue(req, "x-paperclip-agent-id") ??
    req.actor.agentId ??
    process.env.PAPERCLIP_MCP_AGENT_ID ??
    process.env.PAPERCLIP_AGENT_ID ??
    null;
  const runId =
    headerValue(req, "x-paperclip-run-id") ??
    req.actor.runId ??
    process.env.PAPERCLIP_RUN_ID ??
    null;
  const apiUrl = normalizeApiUrl(
    process.env.PAPERCLIP_MCP_API_URL ?? process.env.PAPERCLIP_API_URL ?? requestOrigin(req),
  );

  return {
    apiUrl,
    apiKey,
    companyId,
    agentId,
    runId,
  };
}

async function handleMcp(req: Request, res: Response) {
  const config = resolvePaperclipMcpConfigFromRequest(req);
  if (!config) {
    res.status(401).json({ error: "Paperclip MCP requires authenticated bearer access" });
    return;
  }

  await handlePaperclipStreamableHttpRequest(config, req, res, { body: req.body });
}

export function mcpRoutes() {
  const router = Router();
  router.post("/mcp", handleMcp);
  router.post("/api/mcp", handleMcp);
  router.all(["/mcp", "/api/mcp"], (_req, res) => {
    res.setHeader("Allow", "POST");
    res.status(405).json({ error: "Paperclip MCP uses Streamable HTTP POST" });
  });
  return router;
}
