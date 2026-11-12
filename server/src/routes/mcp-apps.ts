import { Router, type Request, type Response } from "express";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { issues, type Db } from "@paperclipai/db";
import type { McpAppViewDetail } from "@paperclipai/shared";
import { assertBoard, getAccessibleResource } from "./authz.js";
import { connectionRequestUserId } from "./connection-management-authz.js";
import { forbidden } from "../errors.js";
import { accessService } from "../services/access.js";
import { mcpAppViewsService, toMcpAppViewSummary } from "../services/mcp-app-views.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";

const uuidSchema = z.string().uuid();
const toolCallSchema = z.object({
  name: z.string().min(1).max(256),
  arguments: z.record(z.string(), z.unknown()).optional(),
}).strict();

type McpAppsGateway = Pick<ToolGatewayService, "readMcpAppViewResource" | "callMcpAppViewTool">;

/**
 * MCP Apps views in the task chat. Viewing follows task read access. A view's
 * own tool calls also need the viewer's permission to use tools.
 */
export function mcpAppsRoutes(db: Db, toolGateway: McpAppsGateway) {
  const router = Router();
  const views = mcpAppViewsService(db);
  const access = accessService(db);

  router.use("/issues/:issueId/mcp-app-views", async (req, res, next) => {
    assertBoard(req);
    if (!uuidSchema.safeParse(req.params.issueId).success) {
      res.status(404).json({ error: "Task not found" });
      return;
    }
    const [issue] = await db.select({ id: issues.id, companyId: issues.companyId }).from(issues)
      .where(eq(issues.id, req.params.issueId as string)).limit(1);
    if (!(await getAccessibleResource(req, res, issue, "Task not found"))) return;
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

  router.post("/issues/:issueId/mcp-app-views/:viewId/tool-calls", async (req, res) => {
    const found = await viewFor(req, res);
    if (!found) return;
    const body = toolCallSchema.safeParse(req.body);
    if (!body.success) {
      res.status(400).json({ error: "Invalid tool call" });
      return;
    }
    const userId = connectionRequestUserId(req);
    const permitted = req.actor.source === "local_implicit" || req.actor.isInstanceAdmin || (userId !== null && (
      await access.hasPermission(found.issue.companyId, "user", userId, "tools:use")
      || await access.hasPermission(found.issue.companyId, "user", userId, "tools:manage_connections")
    ));
    if (!permitted) throw forbidden("You need permission to use tools to act in this app");
    try {
      res.json(await toolGateway.callMcpAppViewTool({
        companyId: found.issue.companyId,
        userId: userId ?? "board",
        view: found.view,
        toolName: body.data.name,
        arguments: body.data.arguments ?? {},
      }));
    } catch (error) {
      if (!sendGatewayError(res, error)) throw error;
    }
  });

  return router;
}
