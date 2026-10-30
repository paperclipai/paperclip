import { connectionManagementService } from "../services/connection-management.js";
import { chatCredentialRotationId, connectionIntentService, savedChatSetupPath } from "../services/connection-intents.js";
import { companies } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { requiredConnectionUserAction, filterConnectionManagementRows, connectionManagementGuard, connectionRequestContext, connectionRequestUserId } from "./connection-management-authz.js";
import { slackTestMessageSchema, slackRegistrationSchema, slackSetupActionSchema, slackManagedProvisionSchema } from "@paperclipai/shared";
import { isCrossSiteOAuthCallbackNavigation, oauthCallbackInterstitialHtml } from "../lib/oauth-browser-return.js";
import {
  Router,
  type Request as ExpressRequest,
  type Response as ExpressResponse,
} from "express";
import { z } from "zod";
import { githubChatManagementService } from "../services/chat-github-management.js";
import { updateGitHubChatConfigurationSchema } from "@paperclipai/shared";
import type { Db } from "@paperclipai/db";
import {
  CHAT_PROVIDERS,
  configureChatEndpointSchema,
  inspectPhotonProjectSchema,
  confirmChatIdentityLinkSchema,
  createChatEndpointSchema,
  createChatIdentityLinkIntentSchema,
  isUuidLike,
  publishChatPublicationSchema,
  replaceChatEndpointResourcesSchema,
  gitHubRepositoryPageQuerySchema,
  toggleAllGitHubRepositoriesSchema,
  resolveChatActionSchema,
  resolveChatPublicationSchema,
  updateChatEndpointSchema,
  type ChatProvider,
  type ConnectionRequiredUserAction,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import {
  chatChannelService,
  type ChatChannelService,
  type ChatChannelServiceOptions,
} from "../services/chat-channels.js";
import { accessService } from "../services/access.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { recordChatWebhookStage } from "../services/chat-webhook-diagnostics.js";
import {
  createInviteRateLimiter,
  type InviteRateLimiter,
} from "../services/invite-rate-limit.js";
import {
  assertBoard,
  assertBoardOrAgent,
  assertCompanyAccess,
  getAccessibleResource,
  getActorInfo,
} from "./authz.js";
import {
  badRequest,
  conflict,
  notFound,
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
  return connectionRequestUserId(req);
}

async function assertEndpointAccess(
  req: ExpressRequest,
  res: ExpressResponse,
  service: ChatChannelService,
): Promise<boolean> {
  assertBoardOrAgent(req);
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
  const managementGuard = connectionManagementGuard(db, "chat");
  const service = options.service ?? chatChannelService(db, options);
  const access = accessService(db);
  const github = githubChatManagementService(db, options.fetch);

  async function setupHandoff(req: ExpressRequest, reason: string, kind: ConnectionRequiredUserAction["kind"] = "authenticate", options: { requireCredentialRotation?: boolean; credentialFields?: string[] } = {}) {
    const endpoint = await service.get(endpointId(req));
    const [company] = await db.select({ prefix: companies.issuePrefix }).from(companies).where(eq(companies.id, endpoint.companyId));
    const action = options.requireCredentialRotation ? "rotate_credentials" as const : kind === "enter_credentials" || kind === "confirm_identity" ? kind : undefined;
    const handoff = req.actor.type === "agent" && req.actor.runId && endpoint.assignedAgentId === req.actor.agentId
      ? await connectionIntentService(db).requestChatHandoff({ sub: req.actor.agentId!, company_id: endpoint.companyId,
          run_id: req.actor.runId, responsible_user_id: connectionRequestUserId(req)! }, endpoint.id, { action, credentialFields: options.credentialFields })
      : null;
    const interactionId = handoff?.interactionId ?? null;
    const previousRotationId = handoff ? handoff.previousRotationId : chatCredentialRotationId(endpoint.setup);
    return { status: "needs_user_action", interactionId, endpointId: endpoint.id, connectionId: endpoint.connectionId,
      ...requiredConnectionUserAction(req, { type: "chat_endpoint", id: endpoint.id, companyId: endpoint.companyId },
        savedChatSetupPath(company!.prefix, endpoint, action, previousRotationId, { fields: options.credentialFields, requireAll: !!options.credentialFields }), reason, kind),
    };
  }

  async function assertIdentityLinkAccess(req: ExpressRequest) {
    assertBoard(req);
    const userId = actorUserId(req);
    if (!userId) throw badRequest("A signed-in Paperclip user is required");
    // Enforce rollout here: invited nonmembers cannot read the board's
    // experimental-settings API. A private token never bypasses this gate.
    const experimental = await instanceSettingsService(db).getExperimental();
    if (!experimental.enableChatConnectors && !experimental.enableGitHubReviewBots) {
      throw forbidden("Chat connectors are not enabled on this instance");
    }
    return { userId, experimental };
  }

  function assertIdentityProviderEnabled(
    provider: string,
    experimental: { enableChatConnectors: boolean; enableGitHubReviewBots: boolean },
  ) {
    const enabled = provider === "agentmail" || (provider === "github"
      ? experimental.enableGitHubReviewBots
      : experimental.enableChatConnectors);
    if (!enabled) throw forbidden("This connector is not enabled on this instance");
  }

  async function assertConnectionManager(
    req: ExpressRequest,
    companyId: string,
  ) {
    assertBoardOrAgent(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.type === "agent") {
      const context = connectionRequestContext(req);
      if (!context || context.resource.companyId !== companyId) throw forbidden("Connection management authority is required");
      await context.reauthorize();
      return;
    }
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin)
      return;
    const userId = connectionRequestUserId(req);
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

  router.get("/companies/:companyId/chat-endpoints", managementGuard("connections:read", "GET /companies/:companyId/chat-endpoints"), async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await filterConnectionManagementRows(db, req, "connections:read", await service.list(companyId), row => ({ connectionId: row.connectionId, targetAgentId: row.assignedAgentId })));
  });

  router.post(
    "/companies/:companyId/chat-endpoints", managementGuard("connections:configure", "POST /companies/:companyId/chat-endpoints"),
    validate(createChatEndpointSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      await assertConnectionManager(req, companyId);
      if (req.body.provider === "slack" && !req.body.slackSetupMethod) {
        req.body.slackSetupMethod = service.slackRegistration.managerGrants.defaultMethod();
      }
      if (req.body.slackSetupMethod === "managed" && service.slackRegistration.managerGrants.defaultMethod() !== "managed") throw forbidden("Managed Slack setup is unavailable");
      res
        .status(201)
        .json(await service.create(companyId, req.body, actorUserId(req), connectionRequestContext(req)));
    },
  );

  router.get("/chat-endpoints/:endpointId", managementGuard("connections:read", "GET /chat-endpoints/:endpointId"), async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    res.json(await service.get(endpointId(req)));
  });

  const slackActor = (req: ExpressRequest) => {
    assertBoardOrAgent(req);
    const userId = connectionRequestUserId(req);
    if (!userId) throw forbidden("A responsible user is required");
    return { userId, sessionId: req.actor.type === "board" ? req.actor.sessionId ?? null : null,
      managementContext: connectionRequestContext(req),
      bypassPermissionCheck: req.actor.type === "board" && (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin === true) };
  };
  router.get("/companies/:companyId/chat-slack/setup-options", managementGuard("connections:read", "GET /companies/:companyId/chat-slack/setup-options"), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertConnectionManager(req, companyId);
    res.set("Cache-Control", "no-store");
    res.json(await service.slackRegistration.managerGrants.choices(companyId, slackActor(req)));
  });
  router.post("/chat-endpoints/:endpointId/slack/managed/authorize", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/slack/managed/authorize"), validate(slackSetupActionSchema), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    if (req.actor.type === "agent") { res.json(await setupHandoff(req, "The responsible user must open the saved setup to bind their browser session and consent to Slack access.")); return; }
    res.json(await service.slackRegistration.managerGrants.authorize(endpointId(req), slackActor(req)));
  });
  router.post("/chat-endpoints/:endpointId/slack/managed/provision", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/slack/managed/provision"), validate(slackManagedProvisionSchema), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    res.json(await service.slackRegistration.managed.provision(endpointId(req), slackActor(req), req.body));
  });
  router.delete("/companies/:companyId/chat-slack/manager-grants/:grantId", managementGuard("connections:configure", "DELETE /companies/:companyId/chat-slack/manager-grants/:grantId", { slackManagerGrant: true }), async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertConnectionManager(req, companyId);
    await service.slackRegistration.managerGrants.revoke(req.params.grantId as string, companyId, slackActor(req));
    res.sendStatus(204);
  });
  router.get("/chat-slack/managed/oauth/callback", async (req, res) => {
    res.set("Cache-Control", "no-store"); res.set("Referrer-Policy", "no-referrer");
    assertBoard(req);
    const actor = slackActor(req);
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const expiredId = await service.slackRegistration.managerGrants.expiredReturn(state, actor);
    if (expiredId) { res.redirect(303, await service.slackRegistration.returnPath(expiredId)); return; }
    const pending = await service.slackRegistration.managerGrants.pending(state, actor);
    await assertConnectionManager(req, pending.current.endpoint.companyId);
    if (req.get("accept")?.includes("text/html") && isCrossSiteOAuthCallbackNavigation(req)) {
      res.type("html").send(oauthCallbackInterstitialHtml()); return;
    }
    const id = await service.slackRegistration.managerGrants.complete(state,
      typeof req.query.claim_id === "string" ? req.query.claim_id : null,
      typeof req.query.error === "string" ? req.query.error : null, actor,
      typeof req.query.code === "string" ? req.query.code : null);
    res.redirect(303, await service.slackRegistration.returnPath(id));
  });
  router.post("/chat-endpoints/:endpointId/slack/test-message", managementGuard("connections:test", "POST /chat-endpoints/:endpointId/slack/test-message"), validate(slackTestMessageSchema), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    res.json(await service.sendSlackTestMessage(endpointId(req), slackActor(req), req.body));
  });
  router.post("/chat-endpoints/:endpointId/slack/registration", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/slack/registration"), validate(slackRegistrationSchema), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    await service.slackRegistration.create(endpointId(req), slackActor(req), req.body);
    res.json(await service.get(endpointId(req)));
  });
  router.post("/chat-endpoints/:endpointId/slack/install", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/slack/install"), validate(slackSetupActionSchema), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    if (req.actor.type === "agent") { res.json(await setupHandoff(req, "The responsible user must open the saved setup to bind their browser session and consent to Slack access.")); return; }
    res.json(await service.slackRegistration.install(endpointId(req), slackActor(req)));
  });
  router.post("/chat-endpoints/:endpointId/slack/resume", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/slack/resume"), validate(slackSetupActionSchema), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    await service.slackRegistration.resume(endpointId(req), slackActor(req));
    res.json(await service.get(endpointId(req)));
  });
  router.get("/chat-slack/oauth/callback", async (req, res) => {
    res.set("Cache-Control", "no-store");
    res.set("Referrer-Policy", "no-referrer");
    assertBoard(req);
    const actor = slackActor(req);
    const state = typeof req.query.state === "string" ? req.query.state : "";
    const expiredReturn = await service.slackRegistration.expiredReturn(state, actor);
    if (expiredReturn) { res.redirect(303, expiredReturn); return; }
    const pending = await service.slackRegistration.pending(state, actor);
    await assertConnectionManager(req, pending.row.companyId);
    if (req.get("accept")?.includes("text/html") && isCrossSiteOAuthCallbackNavigation(req)) {
      res.type("html").send(oauthCallbackInterstitialHtml());
      return;
    }
    const endpoint = await service.slackRegistration.complete(state,
      typeof req.query.code === "string" ? req.query.code : null,
      typeof req.query.error === "string" ? req.query.error : null, actor);
    res.redirect(303, await service.slackRegistration.returnPath(endpoint));
  });

  const githubUser = (req: ExpressRequest) => {
    const userId = actorUserId(req);
    if (!userId) throw badRequest("Sign in to your Paperclip account to set up this bot");
    return userId;
  };
  router.get("/chat-endpoints/:endpointId/github/configuration", managementGuard("connections:read", "GET /chat-endpoints/:endpointId/github/configuration"), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.json(await github.configuration(endpointId(req), githubUser(req)));
  });
  router.put("/chat-endpoints/:endpointId/github/configuration", managementGuard("connections:configure", "PUT /chat-endpoints/:endpointId/github/configuration"), validate(updateGitHubChatConfigurationSchema), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.json(await github.saveConfiguration(endpointId(req), req.body, githubUser(req), connectionRequestContext(req)));
  });
  router.post("/chat-endpoints/:endpointId/github/verify", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/github/verify"), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.json(await github.verification(endpointId(req)));
  });
  router.put("/chat-endpoints/:endpointId/github/progress", managementGuard("connections:configure", "PUT /chat-endpoints/:endpointId/github/progress"), validate(z.object({ stage: z.enum(["setup", "connect", "install", "repositories", "verify", "identity", "behavior", "test"]) }).strict()), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.json(await service.saveGitHubSetupProgress(endpointId(req), req.body.stage));
  });
  router.get("/chat-endpoints/:endpointId/github/reviews/:reviewId", managementGuard("connections:read", "GET /chat-endpoints/:endpointId/github/reviews/:reviewId"), async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    const reviewId = z.string().uuid().safeParse(req.params.reviewId);
    if (!reviewId.success) throw badRequest("Invalid review ID");
    const review = await github.review(endpointId(req), reviewId.data);
    const visible = await filterConnectionManagementRows(db, req, "connections:read", [review], row => ({ issueId: row.issueId }));
    if (!visible.length) throw notFound("This review was not found in this connection");
    res.json(visible[0]);
  });
  router.get("/chat-endpoints/:endpointId/github/reviews", managementGuard("connections:read", "GET /chat-endpoints/:endpointId/github/reviews"), async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    res.json(await filterConnectionManagementRows(db, req, "connections:read", await github.reviews(endpointId(req)), row => ({ issueId: row.issueId })));
  });
  router.get("/chat-endpoints/:endpointId/github/personal-connections", managementGuard("connections:read", "GET /chat-endpoints/:endpointId/github/personal-connections"), async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    res.json(await github.personalConnections(endpointId(req), githubUser(req)));
  });
  router.post("/chat-endpoints/:endpointId/github/identity", (req, _res, next) => { assertBoard(req); next(); }, validate(z.object({ connectionId: z.string().uuid(), confirmedGithubUserId: z.string().regex(/^[1-9][0-9]*$/).optional() }).strict()), async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    res.json(await github.identity(endpointId(req), req.body.connectionId, githubUser(req), req.body.confirmedGithubUserId));
  });
  router.post("/chat-endpoints/:endpointId/github/people/lookup", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/github/people/lookup"), validate(z.object({ login: z.string().min(1).max(44) }).strict()), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.json(await github.lookupPerson(endpointId(req), req.body.login));
  });
  router.post("/chat-endpoints/:endpointId/github/registration", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/github/registration"), validate(z.object({ name: z.string().trim().min(1).max(34), ownerType: z.enum(["personal", "organization"]).optional(), ownerLogin: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/).optional() }).strict().refine(value => value.ownerType !== "organization" || !!value.ownerLogin, "Enter the GitHub organization")), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    const result = req.body.ownerType === undefined
      ? await service.startGitHubRegistration(endpointId(req), githubUser(req), req.body.name, connectionRequestContext(req))
      : await service.githubWizard.start(endpointId(req), githubUser(req), req.body, connectionRequestContext(req));
    res.json({ ...result, ...(req.actor.type === "agent" ? await setupHandoff(req, "Complete GitHub App registration and consent from this saved setup.") : {}) });
  });
  router.post("/chat-endpoints/:endpointId/github/registration/restart", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/github/registration/restart"), validate(z.object({ registrationId: z.string().uuid(), appNotCreated: z.literal(true) }).strict()), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    res.json(await service.githubWizard.restartRegistration(endpointId(req), githubUser(req), req.body.registrationId, connectionRequestContext(req)));
  });
  router.put("/chat-endpoints/:endpointId/github/draft", managementGuard("connections:configure", "PUT /chat-endpoints/:endpointId/github/draft"), validate(z.object({ name: z.string().trim().min(1).max(34), ownerType: z.enum(["personal", "organization"]), ownerLogin: z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/).optional() }).strict()), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    res.json(await service.githubWizard.saveDraft(endpointId(req), githubUser(req), req.body, connectionRequestContext(req)));
  });
  router.post("/chat-endpoints/:endpointId/github/setup", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/github/setup"), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    const result = await service.githubWizard.advance(endpointId(req), githubUser(req), connectionRequestContext(req));
    res.json({ ...result, ...(req.actor.type === "agent" && ["register", "install", "identity"].includes(result.state)
      ? await setupHandoff(req, "Complete the required GitHub authentication or installation step from this saved setup.") : {}) });
  });
  router.post("/chat-endpoints/:endpointId/github/identity/start", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/github/identity/start"), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    if (req.actor.type === "agent") { res.json(await setupHandoff(req, "The responsible user must authenticate and confirm their own GitHub identity.", "confirm_identity")); return; }
    res.json(await service.githubWizard.startIdentity(endpointId(req), githubUser(req), req.actor));
  });
  router.post("/chat-endpoints/:endpointId/github/identity/confirm", (req, _res, next) => { assertBoard(req); next(); }, validate(z.object({ githubUserId: z.string().regex(/^[1-9][0-9]*$/) }).strict()), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    res.json(await service.githubWizard.confirmIdentity(endpointId(req), githubUser(req), req.body.githubUserId));
  });
  router.post("/chat-endpoints/:endpointId/github/app", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/github/app"), async (req, res, next) => {
    if (req.actor.type !== "agent") { next(); return; }
    if (!(await assertEndpointManagementAccess(req, res))) return;
    const endpoint = await service.get(endpointId(req));
    if (endpoint.provider !== "github") throw notFound("GitHub bot not found");
    if (["archived", "active", "paused"].includes(endpoint.status)) throw conflict("Use the reconnect flow for an existing active bot");
    res.set("Cache-Control", "no-store");
    res.json(await setupHandoff(req, "The responsible user must enter the GitHub App credentials and webhook signing secret.", "enter_credentials"));
  }, validate(z.object({ appId: z.string().regex(/^[1-9][0-9]*$/), privateKey: z.string().min(1).max(32000), webhookSecret: z.string().min(16).max(1024), clientId: z.string().min(1).max(128).optional(), clientSecret: z.string().min(1).max(1024).optional() }).strict().refine(value => !!value.clientId === !!value.clientSecret, "Supply both OAuth client credentials")), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.json(await service.storeGitHubApp(endpointId(req), githubUser(req), req.body, "existing_app", connectionRequestContext(req)));
  });
  router.post("/chat-endpoints/:endpointId/github/repositories/refresh", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/github/repositories/refresh"), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.json(await service.refreshGitHubRepositories(endpointId(req), githubUser(req), connectionRequestContext(req)));
  });
  router.get("/chat-endpoints/:endpointId/github/repositories", managementGuard("connections:read", "GET /chat-endpoints/:endpointId/github/repositories"), async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    const query = gitHubRepositoryPageQuerySchema.safeParse(req.query);
    if (!query.success) throw badRequest("Invalid repository search or page");
    res.json(await service.listGitHubRepositories(endpointId(req), query.data));
  });
  router.put("/chat-endpoints/:endpointId/github/repositories/access", managementGuard("connections:configure", "PUT /chat-endpoints/:endpointId/github/repositories/access"), validate(toggleAllGitHubRepositoriesSchema), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.json(await service.toggleAllGitHubRepositories(endpointId(req), req.body.enabled, actorUserId(req)));
  });

  router.patch(
    "/chat-endpoints/:endpointId", managementGuard("connections:configure", "PATCH /chat-endpoints/:endpointId"),
    validate(updateChatEndpointSchema),
    async (req, res) => {
      if (!(await assertEndpointManagementAccess(req, res))) return;
      res.json(
        await service.update(endpointId(req), req.body, actorUserId(req), connectionRequestContext(req)),
      );
    },
  );

  router.post("/chat-endpoints/:endpointId/photon/inspect", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/photon/inspect"), validate(inspectPhotonProjectSchema), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    res.json(await service.inspectPhoton(endpointId(req), req.body));
  });

  router.post(
    "/chat-endpoints/:endpointId/setup", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/setup"),
    validate(configureChatEndpointSchema),
    async (req, res) => {
      if (!(await assertEndpointManagementAccess(req, res))) return;
      res.set("Cache-Control", "no-store");
      try {
        res.json(await service.configure(endpointId(req), req.body, actorUserId(req), connectionRequestContext(req)));
      } catch (error) {
        if (req.actor.type !== "agent" || !(error instanceof HttpError) || error.status !== 403
          || !error.details || typeof error.details !== "object" || !("code" in error.details)
          || error.details.code !== "chat_endpoint_credential_entry_requires_human") throw error;
        const credentialFields = "credentialFields" in error.details && Array.isArray(error.details.credentialFields)
          ? error.details.credentialFields.filter((field): field is string => typeof field === "string") : undefined;
        res.json(await setupHandoff(req, "The responsible user must enter provider verification credentials in the saved setup.", "enter_credentials", { credentialFields }));
      }
    },
  );

  router.post("/chat-endpoints/:endpointId/setup-secret", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/setup-secret"), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.set("Cache-Control", "no-store");
    if (req.actor.type === "agent") {
      if ((await service.get(endpointId(req))).provider !== "github") throw badRequest("Setup secret generation is only available for GitHub");
      res.json(await setupHandoff(req, "The responsible user must rotate and enter the webhook signing secret in GitHub.", "enter_credentials", { requireCredentialRotation: true }));
      return;
    }
    res
      .status(201)
      .json(
        await service.generateSetupSecret(endpointId(req), actorUserId(req), connectionRequestContext(req)),
      );
  });

  router.post("/chat-endpoints/:endpointId/test", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/test"), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    res.json(await service.test(endpointId(req), undefined, connectionRequestContext(req)));
  });

  router.post("/chat-endpoints/:endpointId/finish", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/finish"), async (req, res) => {
    if (!(await assertEndpointManagementAccess(req, res))) return;
    const userId = actorUserId(req);
    if (!userId) throw badRequest("A signed-in Paperclip user is required");
    res.json(await service.finishSlackSetup(endpointId(req), userId, connectionRequestContext(req)));
  });
  router.get("/chat-endpoints/:endpointId/test-status", managementGuard("connections:read", "GET /chat-endpoints/:endpointId/test-status"), async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    const userId = actorUserId(req);
    if (!userId) throw badRequest("A signed-in Paperclip user is required");
    res.set("Cache-Control", "no-store");
    res.json(await service.setupTestStatus(endpointId(req), userId));
  });

  router.get("/chat-endpoints/:endpointId/resources", managementGuard("connections:read", "GET /chat-endpoints/:endpointId/resources"), async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    res.json(await service.listResources(endpointId(req)));
  });

  router.put(
    "/chat-endpoints/:endpointId/resources", managementGuard("connections:configure", "PUT /chat-endpoints/:endpointId/resources"),
    validate(replaceChatEndpointResourcesSchema),
    async (req, res) => {
      if (!(await assertEndpointManagementAccess(req, res))) return;
      res.json(
        await service.replaceResources(
          endpointId(req),
          req.body.resources,
          actorUserId(req),
          { managementContext: connectionRequestContext(req) },
        ),
      );
    },
  );

  router.get("/chat-endpoints/:endpointId/principals", managementGuard("connections:read", "GET /chat-endpoints/:endpointId/principals"), async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    res.json(await service.listPrincipals(endpointId(req)));
  });

  router.post(
    "/chat-endpoints/:endpointId/principals/:principalId/link-intent", managementGuard("connections:configure", "POST /chat-endpoints/:endpointId/principals/:principalId/link-intent"),
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
    "/chat-endpoints/:endpointId/principals/:principalId/link", managementGuard("connections:configure", "DELETE /chat-endpoints/:endpointId/principals/:principalId/link"),
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
      const { userId, experimental } = await assertIdentityLinkAccess(req);
      const preview = await service.previewIdentityLink(req.body.token, userId);
      assertIdentityProviderEnabled(preview.provider, experimental);
      res.json(await service.confirmIdentityLink(req.body.token, userId));
    },
  );

  router.post("/chat-identity-links/request-access", validate(confirmChatIdentityLinkSchema), async (req, res) => {
    const { userId, experimental } = await assertIdentityLinkAccess(req);
    const preview = await service.previewIdentityLink(req.body.token, userId);
    assertIdentityProviderEnabled(preview.provider, experimental);
    res.json(await service.requestIdentityAccess(req.body.token, userId, req.ip ?? "unknown"));
  });

  router.get("/chat-identity-links/preview", async (req, res) => {
    const { userId, experimental } = await assertIdentityLinkAccess(req);
    const token = typeof req.query.token === "string" ? req.query.token : "";
    if (token.length < 32 || token.length > 4096)
      throw badRequest("A valid identity-link token is required");
    res.set("Cache-Control", "no-store");
    const invitation = await service.previewIdentityLink(token, userId).catch((error) => {
      if (error instanceof HttpError && error.status === 422) return null;
      throw error;
    });
    // A link privately issued to a signed Slack sender is an invitation to
    // request membership. Other link intents retain company-access checks.
    const preview = invitation?.selfService ? invitation : await getAccessibleResource(
      req, res, Promise.resolve(invitation), "Identity-link request not found",
    );
    if (!preview) return;
    assertIdentityProviderEnabled(preview.provider, experimental);
    res.json(preview);
  });

  router.get("/chat-endpoints/:endpointId/conversations", managementGuard("connections:read", "GET /chat-endpoints/:endpointId/conversations"), async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    res.json(await filterConnectionManagementRows(db, req, "connections:read", await service.listConversations(endpointId(req)), row => ({ issueId: row.issueId })));
  });

  router.get("/chat-endpoints/:endpointId/activity", managementGuard("connections:audit", "GET /chat-endpoints/:endpointId/activity"), async (req, res) => {
    if (!(await assertEndpointAccess(req, res, service))) return;
    if (req.query.limit !== undefined || req.query.cursor !== undefined) {
      if ((req.query.limit !== undefined && (typeof req.query.limit !== "string" || !/^\d+$/.test(req.query.limit)))
        || (req.query.cursor !== undefined && typeof req.query.cursor !== "string")) throw badRequest("Invalid activity pagination parameters");
      res.json(await service.listActivityPage(endpointId(req), req.query.limit === undefined ? 25 : Number(req.query.limit), req.query.cursor as string | undefined, connectionRequestContext(req)));
    } else {
      res.json(await service.listActivity(endpointId(req), undefined, connectionRequestContext(req)));
    }
  });

  router.post(
    "/chat-endpoints/:endpointId/deliveries/:deliveryId/replay", (req, _res, next) => { assertBoard(req); next(); },
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
    "/chat-endpoints/:endpointId/publications/:publicationId/replay", (req, _res, next) => { assertBoard(req); next(); },
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
    "/chat-endpoints/:endpointId/publications/:publicationId/resolve", (req, _res, next) => { assertBoard(req); next(); },
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
        req.body.fileTransfer,
      );
      res.status(204).end();
    },
  );

  router.post(
    "/chat-endpoints/:endpointId/actions/:actionId/resolve", (req, _res, next) => { assertBoard(req); next(); },
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
    "/chat-endpoints/:endpointId/conversations/:conversationId/publications", (req, _res, next) => { assertBoard(req); next(); },
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

  router.get(
    "/chat-endpoints/:endpointId/conversations/:conversationId/publications/:publicationId/status", managementGuard("connections:test", "GET /chat-endpoints/:endpointId/conversations/:conversationId/publications/:publicationId/status"),
    async (req, res) => {
      if (
        ![
          endpointId(req),
          req.params.conversationId,
          req.params.publicationId,
        ].every((id) => typeof id === "string" && isUuidLike(id))
      ) {
        throw badRequest(
          "Valid endpoint, conversation, and publication IDs are required",
        );
      }
      if (!(await assertEndpointAccess(req, res, service))) return;
      res.json(
        await service.getPublicationBatchStatus(
          endpointId(req),
          req.params.conversationId as string,
          req.params.publicationId as string,
        ),
      );
    },
  );

  router.get("/issues/:issueId/chat-binding", managementGuard("connections:read", "GET /issues/:issueId/chat-binding"), async (req, res) => {
    assertBoardOrAgent(req);
    const issueId = req.params.issueId as string;
    if (issueId !== issueId.trim() || !isUuidLike(issueId)) {
      throw badRequest("Task ID must be a UUID");
    }
    const binding = await service.getIssueBinding(issueId);
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
      await connectionManagementService(db).authorize(req.actor, "connections:read", {
        ...connectionRequestContext(req)!.resource, connectionId: endpoint.connectionId, targetAgentId: endpoint.assignedAgentId,
      }, { mutation: false });
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
    recordChatWebhookStage("handler_started");
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
    if (!CHAT_PROVIDERS.includes(provider) || provider === "agentmail" || provider === "speko")
      throw badRequest("Unsupported chat provider");
    const response = await service.handleWebhook(
      req.params.publicId as string,
      provider,
      standardRequest(req),
    );
    recordChatWebhookStage("response_ready");
    await writeStandardResponse(response, res);
  });
  return router;
}
