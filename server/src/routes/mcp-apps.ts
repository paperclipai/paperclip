import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { issues, type Db } from "@paperclipai/db";
import type { McpAppViewDetail } from "@paperclipai/shared";
import { assertBoard, getAccessibleResource } from "./authz.js";
import { connectionRequestUserId } from "./connection-management-authz.js";
import { authorizationService } from "../services/authorization.js";
import { mcpAppViewsService, toMcpAppViewSummary } from "../services/mcp-app-views.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";

const uuidSchema = z.string().uuid();

type McpAppsGateway = Pick<ToolGatewayService, "readMcpAppViewResource">;

/**
 * MCP Apps views in the task chat. Viewing follows task read access. A view's
 * own tool calls are served by the tool-access router, which applies the
 * connection test-call authorization.
 */
export function mcpAppsRoutes(db: Db, toolGateway: McpAppsGateway) {
  const router = Router();
  const views = mcpAppViewsService(db);

  router.use("/issues/:issueId/mcp-app-views", async (req, res, next) => {
    assertBoard(req);
    if (!uuidSchema.safeParse(req.params.issueId).success) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const [issue] = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues)
      .where(eq(issues.id, req.params.issueId as string)).limit(1);
    if (!(await getAccessibleResource(req, res, issue, "Task not found"))) return;
    // Company access is not enough: private tasks also need task read access.
    const readable = await authorizationService(db).decide({ actor: req.actor, action: "issue:read", resource: {
      type: "issue", companyId: issue.companyId, issueId: issue.id,
    } });
    if (!readable.allowed) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    res.locals.mcpAppIssue = issue;
    res.setHeader("Cache-Control", "no-store");
    next();
  });

  async function viewFor(req: Request, res: Response) {
    const issue = res.locals.mcpAppIssue as { id: string; companyId: string };
    const viewId = req.params.viewId as string;
    const view = uuidSchema.safeParse(viewId).success ? await views.get(issue.companyId, viewId) : null;
    if (!view || view.issueId !== issue.id) {
      res.status(404).json({ error: "View not found" });
      return null;
    }
    return { issue, view };
  }

  function sendGatewayError(res: Response, error: unknown) {
    if (error instanceof ToolGatewayHttpError) {
      res.status(error.status).json({ error: error.message, reasonCode: error.reasonCode });
      return true;
    }
    return false;
  }

  router.get("/issues/:issueId/mcp-app-views", async (req, res) => {
    const issue = res.locals.mcpAppIssue as { id: string; companyId: string };
    res.json(await views.listForIssue(issue.companyId, issue.id));
  });

  router.get("/issues/:issueId/mcp-app-views/:viewId", async (req, res) => {
    const found = await viewFor(req, res);
    if (!found) return;
    try {
      const resource = await toolGateway.readMcpAppViewResource({
        companyId: found.issue.companyId,
        userId: connectionRequestUserId(req) ?? "board",
        view: found.view,
      });
      const detail: McpAppViewDetail = {
        ...toMcpAppViewSummary(found.view),
        toolResult: found.view.toolResult as unknown as McpAppViewDetail["toolResult"],
        resource,
      };
      res.json(detail);
    } catch (error) {
      if (!sendGatewayError(res, error)) throw error;
    }
  });

  return router;
}
