import { Router, type Request, type Response } from "express";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { issueComments, issues, type Db } from "@paperclipai/db";
import {
  mcpAppMessageSentSchema,
  mcpAppModelContextUpdateSchema,
  normalizeMcpAppModelContext,
  type McpAppModelContext,
  type McpAppViewDetail,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { assertBoard, getAccessibleResource } from "./authz.js";
import { connectionRequestUserId } from "./connection-management-authz.js";
import { authorizationService } from "../services/authorization.js";
import { mcpAppViewsService, toMcpAppViewSummary } from "../services/mcp-app-views.js";
import { ToolGatewayHttpError, type ToolGatewayService } from "../services/tool-gateway.js";

const uuidSchema = z.string().uuid();

type McpAppIssue = { id: string; companyId: string; status: string; assigneeAgentId: string | null; assigneeUserId: string | null };
/** A view can only attribute a comment the viewer sent moments ago. */
const MESSAGE_ATTRIBUTION_WINDOW_MS = 10 * 60_000;

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
    const [issue] = await db.select({
      id: issues.id, companyId: issues.companyId, status: issues.status,
      assigneeAgentId: issues.assigneeAgentId, assigneeUserId: issues.assigneeUserId,
    }).from(issues)
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

  /**
   * Acting on a view for the agent (its context, its messages) is the viewer's
   * own act on the task: a signed-in person who may comment on it. Agents,
   * board API keys and MCP clients cannot.
   */
  async function viewerWhoMayComment(req: Request, res: Response): Promise<string | null> {
    const issue = res.locals.mcpAppIssue as McpAppIssue;
    // A person in the app, not a board API key or an MCP client acting for them.
    const interactive = req.actor.source === "session" || req.actor.source === "local_implicit" || req.actor.source === "cloud_tenant";
    const userId = req.actor.type === "board" && interactive ? req.actor.userId : undefined;
    if (!userId) {
      res.status(403).json({ error: "Only a signed-in person viewing the task can do this" });
      return null;
    }
    const decision = await authorizationService(db).decide({ actor: req.actor, action: "issue:comment", resource: {
      type: "issue", companyId: issue.companyId, issueId: issue.id, status: issue.status,
      assigneeAgentId: issue.assigneeAgentId, assigneeUserId: issue.assigneeUserId,
    } });
    if (!decision.allowed) {
      res.status(403).json({ error: "You can't comment on this task" });
      return null;
    }
    return userId;
  }

  // `ui/update-model-context`: the view's latest context, given to the task's next run.
  router.put("/issues/:issueId/mcp-app-views/:viewId/model-context", validate(mcpAppModelContextUpdateSchema), async (req, res) => {
    const found = await viewFor(req, res);
    if (!found) return;
    const userId = await viewerWhoMayComment(req, res);
    if (!userId) return;
    let context: McpAppModelContext | null;
    try {
      context = normalizeMcpAppModelContext(req.body);
    } catch (error) {
      res.status(413).json({ error: error instanceof Error ? error.message : "App context is too large" });
      return;
    }
    const changed = await views.setModelContext(found.issue.companyId, found.view.id, context);
    if (changed) {
      await logActivity(db, {
        companyId: found.issue.companyId, actorType: "user", actorId: userId,
        action: "issue.mcp_app_context_updated", entityType: "issue", entityId: found.issue.id,
        details: {
          viewId: found.view.id, applicationName: found.view.applicationName, toolName: found.view.upstreamToolName,
          cleared: context === null,
        },
      });
    }
    res.json({ updated: changed });
  });

  /**
   * `ui/message`: the viewer approved a view's proposed message and sent it as
   * their own comment through the task's normal comment path. This records
   * that the comment came from the view.
   */
  router.post("/issues/:issueId/mcp-app-views/:viewId/messages", validate(mcpAppMessageSentSchema), async (req, res) => {
    const found = await viewFor(req, res);
    if (!found) return;
    const userId = await viewerWhoMayComment(req, res);
    if (!userId) return;
    const [comment] = await db.select({ id: issueComments.id, createdAt: issueComments.createdAt }).from(issueComments)
      .where(and(
        eq(issueComments.clientRequestId, req.body.clientRequestId),
        eq(issueComments.companyId, found.issue.companyId),
        eq(issueComments.issueId, found.issue.id),
        eq(issueComments.authorUserId, userId),
      )).limit(1);
    if (!comment || Date.now() - comment.createdAt.getTime() > MESSAGE_ATTRIBUTION_WINDOW_MS) {
      res.status(404).json({ error: "Comment not found" });
      return;
    }
    await logActivity(db, {
      companyId: found.issue.companyId, actorType: "user", actorId: userId,
      action: "issue.mcp_app_message_sent", entityType: "issue", entityId: found.issue.id,
      details: {
        commentId: comment.id, viewId: found.view.id,
        applicationName: found.view.applicationName, toolName: found.view.upstreamToolName,
      },
    });
    res.status(201).json({ commentId: comment.id });
  });

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
