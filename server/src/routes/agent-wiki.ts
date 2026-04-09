import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { eq, and } from "drizzle-orm";
import { assertCompanyAccess } from "./authz.js";
import * as agentWikiSvc from "../services/agent-wiki.js";
import { notFound } from "../errors.js";

/**
 * path-to-regexp v8 (Express 5) uses `{*name}` for wildcards and returns
 * an array of path segments. This helper joins them back into a slash-separated path.
 */
function extractWikiPath(params: Record<string, unknown>, key: string): string | null {
  const raw = params[key];
  if (typeof raw === "string" && raw.length > 0) return raw;
  if (Array.isArray(raw) && raw.length > 0) return raw.join("/");
  return null;
}

export function agentWikiRoutes(db: Db) {
  const router = Router();

  async function requireAgentInCompany(companyId: string, agentId: string) {
    const rows = await db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
    if (rows.length === 0) throw notFound("Agent not found in company");
  }

  // ── Company-scoped routes ──────────────────────────────────────────

  router.get("/companies/:companyId/agents/:agentId/wiki", async (req, res) => {
    const { companyId, agentId } = req.params;
    assertCompanyAccess(req, companyId);
    await requireAgentInCompany(companyId, agentId);
    const pages = await agentWikiSvc.listPages(agentId);
    res.json(pages);
  });

  router.get("/companies/:companyId/agents/:agentId/wiki/{*wikiPath}", async (req, res) => {
    const { companyId, agentId } = req.params;
    const wikiPath = extractWikiPath(req.params, "wikiPath");
    if (!wikiPath) { res.status(400).json({ error: "path required" }); return; }
    assertCompanyAccess(req, companyId);
    await requireAgentInCompany(companyId, agentId);
    const content = await agentWikiSvc.readPage(agentId, wikiPath);
    if (content === null) {
      res.status(404).json({ error: "Wiki page not found" });
      return;
    }
    res.json({ path: wikiPath, content });
  });

  router.put("/companies/:companyId/agents/:agentId/wiki/{*wikiPath}", async (req, res) => {
    const { companyId, agentId } = req.params;
    const wikiPath = extractWikiPath(req.params, "wikiPath");
    if (!wikiPath) { res.status(400).json({ error: "path required" }); return; }
    assertCompanyAccess(req, companyId);
    await requireAgentInCompany(companyId, agentId);
    const { content } = req.body;
    if (typeof content !== "string") {
      res.status(400).json({ error: "content is required" });
      return;
    }
    await agentWikiSvc.writePage(agentId, wikiPath, content);
    res.json({ ok: true });
  });

  router.delete("/companies/:companyId/agents/:agentId/wiki/{*wikiPath}", async (req, res) => {
    const { companyId, agentId } = req.params;
    const wikiPath = extractWikiPath(req.params, "wikiPath");
    if (!wikiPath) { res.status(400).json({ error: "path required" }); return; }
    assertCompanyAccess(req, companyId);
    await requireAgentInCompany(companyId, agentId);
    const deleted = await agentWikiSvc.deletePage(agentId, wikiPath);
    if (!deleted) {
      res.status(404).json({ error: "Wiki page not found" });
      return;
    }
    res.json({ ok: true });
  });

  // ── Agent-scoped routes (MCP / bearer token) ──────────────────────

  router.get("/agents/me/wiki", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }
    const pages = await agentWikiSvc.listPages(req.actor.agentId);
    res.json(pages);
  });

  router.get("/agents/me/wiki/{*wikiPath}", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId) {
      res.status(401).json({ error: "Agent authentication required" });
      return;
    }
    const wikiPath = extractWikiPath(req.params, "wikiPath");
    if (!wikiPath) { res.status(400).json({ error: "path required" }); return; }
    const content = await agentWikiSvc.readPage(req.actor.agentId, wikiPath);
    if (content === null) {
      res.status(404).json({ error: "Wiki page not found" });
      return;
    }
    res.json({ path: wikiPath, content });
  });

  return router;
}
