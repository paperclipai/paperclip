import { Router, type Request, type Response } from "express";
import { z } from "zod";
import type { Db } from "@paperclipai/db";
import { approveCompanyMcpSkillSchema, mcpSkillFileQuerySchema } from "@paperclipai/shared";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { validate } from "../middleware/validate.js";
import { forbidden } from "../errors.js";
import { accessService } from "../services/access.js";
import { companySkillPolicyService } from "../services/company-skill-policy.js";
import { mcpSkillsService, toCompanyMcpSkill } from "../services/mcp-skills.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";

const uuidSchema = z.string().uuid();

type McpSkillsGateway = Pick<ToolGatewayService, "readConnectionSkillFile" | "readConnectionSkillForReview">;

function sendGatewayError(res: Response, error: unknown) {
  if (error instanceof ToolGatewayHttpError) {
    res.status(error.status).json({ error: error.message, reasonCode: error.reasonCode });
    return true;
  }
  return false;
}

/**
 * MCP Skills: skills that connected apps publish. The board reviews and
 * approves each one against its file manifest; agents in an active run read an
 * approved skill's files only through here.
 */
export function mcpSkillsRoutes(db: Db, toolGateway: McpSkillsGateway) {
  const router = Router();
  const skills = mcpSkillsService(db);

  /**
   * Approving or declining a connected app's skill is a skill install decision:
   * it needs skill configuration access and the company skill policy's
   * `skills.install` for an external package from that connection.
   */
  async function assertCanReview(req: Request, companyId: string, connectionId: string, skillId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const platform = await accessService(db).decide({ actor: req.actor, action: "skill_config:update", resource: { type: "company", companyId } });
    if (!platform.allowed && !["deny_no_grant", "deny_missing_consent", "deny_missing_grant"].includes(platform.reason)) {
      throw forbidden(platform.explanation, { code: "skill_actor_restricted" });
    }
    const decision = await companySkillPolicyService(db).evaluate({
      companyId,
      principal: { type: "board", id: req.actor.type === "board" ? req.actor.userId ?? "board" : "board", role: "board" },
      action: "skills.install",
      resource: { skillId, sourceType: "external_package", sourceLocator: `mcp-connection:${connectionId}` },
    });
    if (!decision.allowed) throw forbidden("Skill action denied by company policy", {
      code: "skill_policy_denied", reason: decision.reason,
      ...(typeof decision.remediation === "string" ? { remediation: decision.remediation } : {}),
    });
  }

  function boardUserId(req: Request) {
    return req.actor.type === "board" ? req.actor.userId ?? "board" : "board";
  }

  router.get("/companies/:companyId/mcp-skills", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    res.setHeader("Cache-Control", "no-store");
    res.json({ skills: await skills.list(companyId) });
  });

  router.get("/companies/:companyId/mcp-skills/:skillId/content", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (!uuidSchema.safeParse(req.params.skillId).success) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    try {
      const content = await toolGateway.readConnectionSkillForReview({ companyId, userId: boardUserId(req), skillId: req.params.skillId as string });
      res.setHeader("Cache-Control", "no-store");
      res.json(content);
    } catch (error) {
      if (!sendGatewayError(res, error)) throw error;
    }
  });

  router.post("/companies/:companyId/mcp-skills/:skillId/approve", validate(approveCompanyMcpSkillSchema), async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!uuidSchema.safeParse(req.params.skillId).success) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    const existing = await skills.get(companyId, req.params.skillId as string);
    await assertCanReview(req, companyId, existing.connectionId, existing.id);
    const updated = await skills.approve(companyId, existing.id, req.body, boardUserId(req));
    res.json({ skill: toCompanyMcpSkill(updated, "", false) });
  });

  router.post("/companies/:companyId/mcp-skills/:skillId/decline", async (req, res) => {
    const companyId = req.params.companyId as string;
    if (!uuidSchema.safeParse(req.params.skillId).success) {
      res.status(404).json({ error: "Skill not found" });
      return;
    }
    const existing = await skills.get(companyId, req.params.skillId as string);
    await assertCanReview(req, companyId, existing.connectionId, existing.id);
    const updated = await skills.decline(companyId, existing.id, boardUserId(req));
    res.json({ skill: toCompanyMcpSkill(updated, "", false) });
  });

  /** An approved skill's file, for an agent in an active run that can use the skill's app. */
  router.get("/agents/me/mcp-skills/:skillId/files", async (req, res) => {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId || !req.actor.runId) {
      res.status(401).json({ error: "Active agent run authentication required" });
      return;
    }
    const headerRunId = req.get("X-Paperclip-Run-Id")?.trim();
    if (headerRunId && headerRunId !== req.actor.runId) {
      res.status(403).json({ error: "Run id header does not match agent token", code: "run_id_mismatch" });
      return;
    }
    const query = mcpSkillFileQuerySchema.safeParse(req.query);
    if (!uuidSchema.safeParse(req.params.skillId).success || !query.success) {
      res.status(404).json({ error: "File not found" });
      return;
    }
    try {
      const bytes = await toolGateway.readConnectionSkillFile({
        companyId: req.actor.companyId, agentId: req.actor.agentId, runId: req.actor.runId,
        skillId: req.params.skillId as string, path: query.data.path,
      });
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Content-Type-Options", "nosniff");
      // Served as data for the agent, never as a page.
      res.type("application/octet-stream").send(bytes);
    } catch (error) {
      if (!sendGatewayError(res, error)) throw error;
    }
  });

  return router;
}
