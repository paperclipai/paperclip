import { slackCapabilities } from "../services/connectors/slack-capabilities.js";
import { slackSearchOAuthService } from "../services/connectors/slack-search-oauth.js";
import { accessService } from "../services/access.js";
import { assertBoard } from "./authz.js";
import type { Request } from "express";
import { Router } from "express";
import { companies, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { instanceSettingsService } from "../services/instance-settings.js";
import { slackToolCallSchema, isUuidLike } from "@paperclipai/shared";
import { badRequest, forbidden } from "../errors.js";
import { assertCompanyAccess } from "./authz.js";
import { executeConnectorTool } from "../services/connector-runtime.js";

export function slackToolRoutes(db: Db, publicBaseUrl?: string) {
  const router = Router();
  const oauth = slackSearchOAuthService(db, publicBaseUrl);
  router.use(
    ["/slack/search", "/companies/:companyId/slack"],
    async (req, _res, next) => {
      if (
        !(await instanceSettingsService(db).getExperimental())
          .enableChatConnectors
      )
        throw forbidden("Chat connectors are disabled");
      next();
    },
  );
  function user(req: Request) {
    assertBoard(req);
    if (!req.actor.userId)
      throw forbidden("Sign in before connecting Slack search");
    return req.actor.userId;
  }
  router.param("endpointId", (_req, _res, next, id) => {
    if (!isUuidLike(id)) throw badRequest("Invalid Slack endpoint");
    next();
  });
  router.param("companyId", (_req, _res, next, id) => {
    if (!isUuidLike(id)) throw badRequest("Invalid company");
    next();
  });
  router.get("/slack/search/callback", async (req, res) => {
    const userId = user(req);
    if (
      typeof req.query.state !== "string" ||
      typeof req.query.code !== "string"
    )
      throw badRequest("Slack authorization was cancelled or incomplete");
    const result = await oauth.complete(
      req.query.state,
      req.query.code,
      userId,
    );
    const [company] = await db
      .select({ prefix: companies.issuePrefix })
      .from(companies)
      .where(eq(companies.id, result.companyId));
    res.redirect(
      `/${encodeURIComponent(company.prefix)}/apps/chat/${result.endpointId}/access`,
    );
  });
  router.get(
    "/companies/:companyId/slack/endpoints/:endpointId/capabilities",
    async (req, res) => {
      assertBoard(req);
      const companyId = String(req.params.companyId);
      assertCompanyAccess(req, companyId);
      res
        .set("Cache-Control", "no-store")
        .json(
          await slackCapabilities(db, companyId, String(req.params.endpointId)),
        );
    },
  );
  async function canConfigure(req: Request, companyId: string, userId: string) {
    return (
      req.actor.source === "local_implicit" ||
      req.actor.isInstanceAdmin === true ||
      (await accessService(db).hasPermission(
        companyId,
        "user",
        userId,
        "tools:manage_connections",
      ))
    );
  }
  router.get("/companies/:companyId/slack/endpoints/:endpointId/search", async (req, res) => {
    const userId = user(req);
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    res.set("Cache-Control", "no-store").json({
      ...(await oauth.status(companyId, String(req.params.endpointId), userId)),
      canConfigure: await canConfigure(req, companyId, userId),
    });
  });
  router.put("/companies/:companyId/slack/endpoints/:endpointId/search", async (req, res) => {
    const userId = user(req);
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    if (
      req.actor.source !== "local_implicit" &&
      !req.actor.isInstanceAdmin &&
      !(await accessService(db).hasPermission(
        companyId,
        "user",
        userId,
        "tools:manage_connections",
      ))
    )
      throw forbidden("Missing permission: tools:manage_connections");
    res.json(
      await oauth.configure(
        companyId,
        String(req.params.endpointId),
        userId,
        req.body,
      ),
    );
  });
  router.post("/companies/:companyId/slack/endpoints/:endpointId/search/connect", async (req, res) => {
    const userId = user(req);
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    res
      .set("Cache-Control", "no-store")
      .json(
        await oauth.start(companyId, String(req.params.endpointId), userId),
      );
  });
  router.delete("/companies/:companyId/slack/endpoints/:endpointId/search", async (req, res) => {
    const userId = user(req);
    const companyId = String(req.params.companyId);
    assertCompanyAccess(req, companyId);
    res.json(
      await oauth.disconnect(companyId, String(req.params.endpointId), userId),
    );
  });
  router.post(
    "/companies/:companyId/slack/tasks/:issueId/tools",
    async (req, res) => {
      const companyId = String(req.params.companyId);
      const issueId = String(req.params.issueId);
      assertCompanyAccess(req, companyId);
      if (!isUuidLike(companyId) || !isUuidLike(issueId))
        throw badRequest("Invalid task binding");
      if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.runId)
        throw forbidden("Slack tools require an authenticated agent run");
      const call = slackToolCallSchema.parse(req.body);
      if (!call.tool.startsWith("slack_"))
        throw forbidden("Expected a Slack tool");
      res.set("Cache-Control", "no-store").json(
        await executeConnectorTool(
          db,
          {
            companyId,
            issueId,
            runId: req.actor.runId,
            agentId: req.actor.agentId,
          },
          call.tool,
          call.arguments,
        ),
      );
    },
  );
  return router;
}
