import {
  Router,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from "express";
import type { Db } from "@paperclipai/db";
import {
  CHAT_PROVIDERS,
  configureChatEndpointSchema,
  confirmChatIdentityLinkSchema,
  createChatEndpointSchema,
  createChatIdentityLinkIntentSchema,
  publishChatPublicationSchema,
  replaceChatEndpointResourcesSchema,
  resolveChatActionSchema,
  resolveChatPublicationSchema,
  updateChatEndpointSchema,
  type ChatProvider,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  chatChannelService,
  type ChatChannelService,
  type ChatChannelServiceOptions,
} from "../services/chat-channels.js";
import { accessService } from "../services/access.js";
import {
  createInviteRateLimiter,
  type InviteRateLimiter,
} from "../services/invite-rate-limit.js";
import {
  assertBoard,
  assertCompanyAccess,
  getAccessibleResource,
  getActorInfo,
} from "./authz.js";
import {
  badRequest,
  forbidden,
  HttpError,
  tooManyRequests,
} from "../errors.js";

type ChatChannelRouteOptions = ChatChannelServiceOptions & {
  service?: ChatChannelService;
};

type ChatWebhookRouteOptions = {
  rateLimiter?: InviteRateLimiter;
};

const CHAT_WEBHOOK_RATE_LIMIT_WINDOW_MS = 60_000;
const CHAT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS = 600;

function endpointId(req: ExpressRequest): string {
  return req.params.endpointId as string;
}

function actorUserId(req: ExpressRequest): string | null {
  const actor = getActorInfo(req);
  return actor.actorType === "user" ? actor.actorId : null;
}

async function assertEndpointAccess(
  req: ExpressRequest,
  res: ExpressResponse,
  service: ChatChannelService,
): Promise<boolean> {
  assertBoard(req);
  const endpoint = await getAccessibleResource(
    req,
    res,
    service.get(endpointId(req)).catch((error) => {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }),
    "Chat endpoint not found",
  );
  return endpoint !== null;
}

export function chatChannelRoutes(db: Db, options: ChatChannelRouteOptions) {
  const router = Router();
  const service = options.service ?? chatChannelService(db, options);
  const access = accessService(db);

  async function assertConnectionManager(
    req: ExpressRequest,
    companyId: string,
  ) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)
      return;
    const userId = req.actor.userId;
    if (
      userId &&
      (await access.hasPermission(
        companyId,
        "user",
        userId,
        "tools:manage_connections",
      ))
    )
      return;
    throw forbidden("Missing permission: tools:manage_connections");
  }

  async function assertEndpointManagementAccess(
    req: ExpressRequest,
    res: ExpressResponse,
  ): Promise<boolean> {
    if (!(await assertEndpointAccess(req, res, service))) return false;
    const endpoint = await service.get(endpointId(req));
    await assertConnectionManager(req, endpoint.companyId);
    return true;
  }

  router.get("/companies/:companyId/chat-endpoints", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await service.list(companyId));
  });

  router.post(
    "/companies/:companyId/chat-endpoints",
    validate(createChatEndpointSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertConnectionManager(req, companyId);
      res
        .status(201)
        .json(await service.create(companyId, req.body, actorUserId(req)));
    },
  );

  router.get("/chat-endpoints/:endpointId", async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    res.json(await service.get(endpointId(req)));
  });

  router.patch(
    "/chat-endpoints/:endpointId",
    validate(updateChatEndpointSchema),
    async (req, res) => {
      if (!(await assertEndpointManagementAccess(req, res))) return;
      res.json(
        await service.update(endpointId(req), req.body, actorUserId(req)),
      );
    },
  );

  router.post(
    "/chat-endpoints/:endpointId/setup",
    validate(configureChatEndpointSchema),
    async (req, res) => {
      if (!(await assertEndpointManagementAccess(req, res))) return;
      res.json(
        await service.configure(endpointId(req), req.body, actorUserId(req)),
      );
    },
  );

  router.post("/chat-endpoints/:endpointId/setup-secret", async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    res
      .status(201)
      .json(
        await service.generateSetupSecret(endpointId(req), actorUserId(req)),
      );
  });

  router.post("/chat-endpoints/:endpointId/test", async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.json(await service.test(endpointId(req)));
  });

  router.get("/chat-endpoints/:endpointId/resources", async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    res.json(await service.listResources(endpointId(req)));
  });

  router.put(
    "/chat-endpoints/:endpointId/resources",
    validate(replaceChatEndpointResourcesSchema),
    async (req, res) => {
      if (!(await assertEndpointManagementAccess(req, res))) return;
      res.json(
        await service.replaceResources(endpointId(req), req.body.resources),
      );
    },
  );

  router.get("/chat-endpoints/:endpointId/principals", async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    res.json(await service.listPrincipals(endpointId(req)));
  });

  router.post(
    "/chat-endpoints/:endpointId/principals/:principalId/link-intent",
    validate(createChatIdentityLinkIntentSchema),
    async (req, res) => {
      if (!(await assertEndpointManagementAccess(req, res))) return;
      res
        .status(201)
        .json(
          await service.createLinkIntent(
            endpointId(req),
            req.params.principalId as string,
            req.body.expiresInSeconds,
          ),
        );
    },
  );

  router.delete(
    "/chat-endpoints/:endpointId/principals/:principalId/link",
    async (req, res) => {
      if (!(await assertEndpointManagementAccess(req, res))) return;
      await service.revokeLink(
        endpointId(req),
        req.params.principalId as string,
      );
      res.status(204).end();
    },
  );

  router.post(
    "/chat-identity-links/confirm",
    validate(confirmChatIdentityLinkSchema),
    async (req, res) => {
      assertBoard(req);
      const userId = actorUserId(req);
      if (!userId) throw badRequest("A signed-in Paperclip user is required");
      res.json(await service.confirmIdentityLink(req.body.token, userId));
    },
  );

  router.get("/chat-identity-links/preview", async (req, res) => {
    assertBoard(req);
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (token.length < 32 || token.length > 4096)
      throw badRequest("A valid identity-link token is required");
    const preview = await service.previewIdentityLink(token);
    assertCompanyAccess(req, preview.companyId);
    res.json(preview);
  });

  router.get("/chat-endpoints/:endpointId/conversations", async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    res.json(await service.listConversations(endpointId(req)));
  });

  router.get("/chat-endpoints/:endpointId/activity", async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    res.json(await service.listActivity(endpointId(req)));
  });

  router.post(
    "/chat-endpoints/:endpointId/deliveries/:deliveryId/replay",
    async (req, res) => {
      if (!(await assertEndpointManagementAccess(req, res))) return;
      await service.replayDelivery(
        endpointId(req),
        req.params.deliveryId as string,
      );
      res.status(204).end();
    },
  );

  router.post(
    "/chat-endpoints/:endpointId/publications/:publicationId/replay",
    async (req, res) => {
      if (!(await assertEndpointManagementAccess(req, res))) return;
      await service.replayPublication(
        endpointId(req),
        req.params.publicationId as string,
      );
      res.status(204).end();
    },
  );

  router.post(
    "/chat-endpoints/:endpointId/publications/:publicationId/resolve",
    validate(resolveChatPublicationSchema),
    async (req, res) => {
      if (!(await assertEndpointManagementAccess(req, res))) return;
      const userId = actorUserId(req);
      if (!userId) throw badRequest("A board user is required");
      await service.resolvePublication(
        endpointId(req),
        req.params.publicationId as string,
        req.body.action,
        userId,
      );
      res.status(204).end();
    },
  );

  router.post(
    "/chat-endpoints/:endpointId/actions/:actionId/resolve",
    validate(resolveChatActionSchema),
    async (req, res) => {
      if (!(await assertEndpointManagementAccess(req, res))) return;
      const userId = actorUserId(req);
      if (!userId) throw badRequest("A board user is required");
      await service.resolveAction(
        endpointId(req),
        req.params.actionId as string,
        req.body.action,
        userId,
      );
      res.status(204).end();
    },
  );

  router.post(
    "/chat-endpoints/:endpointId/conversations/:conversationId/publications",
    validate(publishChatPublicationSchema),
    async (req, res) => {
      if (!(await assertEndpointAccess(req, res, service))) return;
      if ("commentId" in req.body) {
        res
          .status(201)
          .json(
            await service.publishComment(
              endpointId(req),
              req.params.conversationId as string,
              req.body.commentId,
            ),
          );
        return;
      }
      const userId = actorUserId(req);
      if (!userId) throw badRequest("A board user is required");
      res
        .status(201)
        .json(
          await service.publishBoardMessage(
            endpointId(req),
            req.params.conversationId as string,
            req.body.body,
            req.body.idempotencyKey,
            userId,
            req.body.attachmentIds,
          ),
        );
    },
  );

  router.get("/issues/:issueId/chat-binding", async (req, res) => {
    assertBoard(req);
    const binding = await service.getIssueBinding(req.params.issueId as string);
    if (binding) {
      const endpoint = await getAccessibleResource(
        req,
        res,
        service.get(binding.endpointId).catch((error) => {
          if (error instanceof HttpError && error.status === 404) return null;
          throw error;
        }),
        "Issue not found",
      );
      if (!endpoint) return;
    }
    res.json(binding);
  });

  return router;
}

function standardRequest(req: ExpressRequest): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (Array.isArray(value))
      value.forEach((entry) => headers.append(name, entry));
    else if (value !== undefined) headers.set(name, value);
  }
  const host = req.get("host") ?? "localhost";
  const protocol = req.protocol || "https";
  const capturedBody = (req as ExpressRequest & { rawBody?: Buffer }).rawBody;
  const rawBody =
    capturedBody ??
    (Buffer.isBuffer(req.body)
      ? req.body
      : Buffer.from(JSON.stringify(req.body ?? {})));
  return new Request(`${protocol}://${host}${req.originalUrl}`, {
    method: req.method,
    headers,
    body:
      req.method === "GET" || req.method === "HEAD"
        ? undefined
        : new Uint8Array(rawBody),
  });
}

async function writeStandardResponse(response: Response, res: ExpressResponse) {
  response.headers.forEach((value, name) => {
    if (
      !["content-encoding", "content-length", "transfer-encoding"].includes(
        name.toLowerCase(),
      )
    ) {
      res.setHeader(name, value);
    }
  });
  const body = Buffer.from(await response.arrayBuffer());
  res.status(response.status).send(body);
}

/** Provider-authenticated ingress. Mount outside the board mutation guard. */
export function chatWebhookRoutes(
  service: ChatChannelService,
  options: ChatWebhookRouteOptions = {},
) {
  const router = Router();
  const rateLimiter =
    options.rateLimiter ??
    createInviteRateLimiter({
      windowMs: CHAT_WEBHOOK_RATE_LIMIT_WINDOW_MS,
      maxRequests: CHAT_WEBHOOK_RATE_LIMIT_MAX_REQUESTS,
    });
  router.post("/api/chat-webhooks/:publicId/:provider", async (req, res) => {
    // Provider signatures are intentionally verified inside Chat SDK, but an
    // attacker should not receive an unbounded cryptographic/JSON-processing
    // budget. `req.ip` follows Express's configured trusted-proxy boundary;
    // the public endpoint id also keeps unrelated bots from sharing a bucket.
    const limit = rateLimiter.consume(
      `${req.params.publicId}:${req.ip || req.socket?.remoteAddress || "unknown"}`,
    );
    res.setHeader("X-RateLimit-Limit", String(limit.limit));
    res.setHeader("X-RateLimit-Remaining", String(limit.remaining));
    if (!limit.allowed) {
      res.setHeader("Retry-After", String(limit.retryAfterSeconds));
      throw tooManyRequests("Too many chat webhook requests", {
        retryAfterSeconds: limit.retryAfterSeconds,
      });
    }
    const provider = req.params.provider as ChatProvider;
    if (!CHAT_PROVIDERS.includes(provider))
      throw badRequest("Unsupported chat provider");
    const response = await service.handleWebhook(
      req.params.publicId as string,
      provider,
      standardRequest(req),
    );
    await writeStandardResponse(response, res);
  });
  return router;
}
