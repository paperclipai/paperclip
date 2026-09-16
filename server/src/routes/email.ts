import { Router, type Request } from "express";
import { z } from "zod";
import {
  emailConnectionSchema,
  emailEndpointSetupSchema,
  emailSendSchema,
} from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "./authz.js";
import { emailConnectionService } from "../services/email-connections.js";
import { accessService } from "../services/access.js";
import { forbidden, notFound } from "../errors.js";
import type {
  EmailChannelService,
  EmailActor,
} from "../services/email-channels.js";

function actor(req: Request): EmailActor {
  return req.actor.type === "agent"
    ? { agentId: req.actor.agentId, runId: req.actor.runId ?? undefined }
    : {
        userId: req.actor.userId ?? "board",
        localImplicit: req.actor.source === "local_implicit",
      };
}
export function emailRoutes(db: Db, service: EmailChannelService) {
  const router = Router();
  async function manager(req: Request, companyId: string) {
    assertBoard(req);
    if (!hasCompanyAccess(req, companyId))
      throw notFound("Email inbox not found");
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)
      return;
    if (
      !req.actor.userId ||
      !(await accessService(db).hasPermission(
        companyId,
        "user",
        req.actor.userId,
        "tools:manage_connections",
      ))
    )
      throw forbidden("Missing permission: tools:manage_connections");
  }
  router.post(
    "/companies/:companyId/email/connections",
    validate(emailConnectionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await manager(req, companyId);
      await service.requireEnabled();
      res
        .status(201)
        .json(
          await emailConnectionService(db).connect(
            companyId,
            req.body,
            actor(req),
          ),
        );
    },
  );
  router.post(
    "/companies/:companyId/email/connections/:connectionId/inspect",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await manager(req, companyId);
      await service.requireEnabled();
      const saved = await emailConnectionService(db).credential(
        companyId,
        req.params.connectionId as string,
        actor(req),
      );
      res
        .set("Cache-Control", "no-store")
        .json(await service.inspect(saved.value));
    },
  );
  router.get("/companies/:companyId/email/inboxes", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await service.list(companyId);
    res.json(
      req.actor.type === "agent"
        ? rows.filter((r) => r.assignedAgentId === req.actor.agentId)
        : rows,
    );
  });
  router.post(
    "/companies/:companyId/email/inspect",
    validate(z.object({ apiKey: z.string().min(1).max(4096) }).strict()),
    async (req, res) => {
      await manager(req, req.params.companyId as string);
      res.set("Cache-Control", "no-store");
      res.json(await service.inspect(req.body.apiKey));
    },
  );
  router.post(
    "/companies/:companyId/email/inboxes",
    validate(emailEndpointSetupSchema),
    async (req, res) => {
      await manager(req, req.params.companyId as string);
      res
        .status(201)
        .json(
          await service.setup(
            req.params.companyId as string,
            req.body,
            actor(req),
          ),
        );
    },
  );
  router.post(
    "/email/inboxes/:endpointId/control",
    validate(
      z.object({ action: z.enum(["pause", "resume", "remove"]) }).strict(),
    ),
    async (req, res) => {
      const endpoint = await service.getEndpoint(
        req.params.endpointId as string,
      );
      await manager(req, endpoint.companyId);
      res.json(await service.control(endpoint.id, req.body.action, actor(req)));
    },
  );
  router.post(
    "/email/inboxes/:endpointId/reconnect",
    validate(
      z
        .object({
          apiKey: z.string().min(1).max(4096),
          receiveMode: z.enum(["websocket", "webhook"]),
        })
        .strict(),
    ),
    async (req, res) => {
      const endpoint = await service.getEndpoint(
        req.params.endpointId as string,
      );
      await manager(req, endpoint.companyId);
      res.json(
        await service.reconnect(
          endpoint.id,
          req.body.apiKey,
          req.body.receiveMode,
          actor(req),
        ),
      );
    },
  );
  router.post(
    "/companies/:companyId/email/deliveries/:publicationId/resolve",
    validate(
      z
        .object({
          outcome: z.enum(["sent", "failed"]),
          providerMessageId: z.string().min(1).max(998).optional(),
        })
        .strict(),
    ),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await manager(req, companyId);
      res.json(
        await service.resolveUncertain(
          companyId,
          req.params.publicationId as string,
          req.body,
          actor(req),
        ),
      );
    },
  );
  router.post(
    "/companies/:companyId/email/send",
    validate(emailSendSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      res
        .status(202)
        .json(await service.queueSend(companyId, req.body, actor(req)));
    },
  );
  router.get("/companies/:companyId/email/tasks/:issueId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await service.authorizeRead(
      companyId,
      req.params.issueId as string,
      actor(req),
    );
    const thread = await service.thread(
      companyId,
      req.params.issueId as string,
    );
    if (
      thread &&
      req.actor.type === "agent" &&
      thread.endpoint.assignedAgentId !== req.actor.agentId
    )
      throw notFound("Email task not found");
    res.json(thread);
  });
  router.get(
    "/companies/:companyId/email/deliveries/:publicationId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const delivery = await service.publication(
        req.params.publicationId as string,
        companyId,
      );
      await service.authorizeRead(companyId, delivery.issueId, actor(req));
      const thread = await service.thread(companyId, delivery.issueId);
      if (
        req.actor.type === "agent" &&
        thread?.endpoint.assignedAgentId !== req.actor.agentId
      )
        throw notFound("Email delivery not found");
      res.json(delivery);
    },
  );
  return router;
}
export function emailWebhookRoutes(service: EmailChannelService) {
  const router = Router();
  router.post("/api/chat-webhooks/agentmail/:publicId", async (req, res) => {
    const headers: Record<string, string> = {};
    for (const key of ["svix-id", "svix-timestamp", "svix-signature"])
      if (typeof req.headers[key] === "string") headers[key] = req.headers[key];
    if (!Buffer.isBuffer(req.body))
      throw forbidden("Raw webhook body required");
    await service.webhook(req.params.publicId, req.body, headers);
    res.sendStatus(204);
  });
  return router;
}
