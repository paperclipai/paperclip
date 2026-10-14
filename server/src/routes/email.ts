import { Router, type ErrorRequestHandler, type Request } from "express";
import { z } from "zod";
import {
  emailConnectionSchema,
  emailAddressCheckSchema,
  emailEndpointSetupSchema,
  emailSendSchema,
  isUuidLike,
} from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess, hasCompanyAccess } from "./authz.js";
import { emailConnectionService } from "../services/email-connections.js";
import { accessService } from "../services/access.js";
import { badRequest, forbidden, HttpError, notFound } from "../errors.js";
import { agentmailApi, AgentmailApiError } from "../services/agentmail-api.js";
import { logger } from "../middleware/logger.js";
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

// Provider rejections describe setup/account problems, not Paperclip crashes.
// Only local messages and operation names reach the UI; never forward a body.
const agentmailErrorHandler: ErrorRequestHandler = (error, _req, res, next) => {
  if (!(error instanceof AgentmailApiError)) return next(error);
  logger.warn({ operation: error.operation, providerStatus: error.status, providerCode: error.providerCode }, "AgentMail request rejected");
  const actions: Partial<Record<AgentmailApiError["operation"], string>> = {
    request: "complete this request",
    inspect_key: "verify the API key",
    create_inbox: "create the email address",
    create_inbox_key: "create an inbox-scoped API key",
    create_webhook: "register the email webhook",
  };
  const action = actions[error.operation] ?? "complete this request";
  let status = 422;
  let code = "agentmail_request_failed";
  let message: string;
  const addressTaken = error.operation === "create_inbox"
    && [403, 409, 422].includes(error.status)
    && (error.providerCode === "resource_taken" || error.providerCode === "already_exists");
  if (addressTaken) {
    status = 409;
    code = "agentmail_address_taken";
    message = "This email address is already in use. Choose a different address.";
  } else if (error.providerCode === "limit_exceeded") {
    message = "Your AgentMail account has reached its resource limit. Free up space or increase your plan’s limit, then try again.";
  } else if (error.providerCode === "domain_not_verified") {
    message = "Verify this domain in AgentMail before creating an email address, or choose another domain.";
  } else if (error.status === 401) {
    message = "AgentMail rejected the API key. Check that it is correct and has not been revoked, then reconnect.";
  } else if (error.status === 403) {
    message = `AgentMail did not allow Paperclip to ${action}. Check your API key permissions and AgentMail account limits, then try again.`;
  } else if (error.status === 429) {
    status = 429;
    res.set("Retry-After", String(Math.ceil(error.retryAfterMs / 1000)));
    message = "AgentMail is rate limiting requests. Wait a moment, then try again.";
  } else if ([400, 409, 422].includes(error.status) && error.operation === "create_inbox") {
    message = "AgentMail could not create this email address. Try a different address and check that its domain is available in your AgentMail account.";
  } else if (error.status === 404) {
    message = error.operation === "create_inbox_key"
      ? "AgentMail could not create an access key for this inbox. The email address was saved; try finishing the connection again."
      : "AgentMail could not find the requested inbox or resource. Check that it still exists and that your API key can access it.";
  } else if (error.status >= 500) {
    status = 502;
    message = "AgentMail is temporarily unavailable. Try again in a moment.";
  } else {
    message = `AgentMail could not ${action}. Check your AgentMail settings, then try again.`;
  }
  next(new HttpError(status, message, {
    code,
    providerStatus: error.status,
    operation: error.operation,
    ...(addressTaken ? { field: "username" } : {}),
  }));
};

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
  router.get("/companies/:companyId/email/connections", async (req, res) => {
    const companyId = req.params.companyId as string;
    await manager(req, companyId);
    res.set("Cache-Control", "no-store").json(
      await emailConnectionService(db).listCredentials(companyId, actor(req)),
    );
  });
  router.post(
    "/companies/:companyId/email/connections",
    validate(emailConnectionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await manager(req, companyId);
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
  router.post(
    "/companies/:companyId/email/connections/:connectionId/check-address",
    validate(emailAddressCheckSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await manager(req, companyId);
      const saved = await emailConnectionService(db).credential(
        companyId, req.params.connectionId as string, actor(req),
      );
      res.set("Cache-Control", "no-store").json(await agentmailApi(saved.value)
        .checkAddress(`${req.body.username}@${req.body.domain}`));
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
    const issueId = req.params.issueId as string;
    if (issueId !== issueId.trim() || !isUuidLike(issueId)) {
      throw badRequest("Task ID must be a UUID");
    }
    await service.authorizeRead(
      companyId,
      issueId,
      actor(req),
    );
    const thread = await service.thread(
      companyId,
      issueId,
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
  router.use(agentmailErrorHandler);
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
