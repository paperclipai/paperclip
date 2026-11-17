import { Router, type Response } from "express";
import { createHash } from "node:crypto";
import { and, eq, or } from "drizzle-orm";
import { issues as issueRows, type Db } from "@paperclipai/db";
import {
  createDeploymentAssertionSchema,
  createSecretProviderConfigSchema,
  createSecretSchema,
  createUserSecretDefinitionSchema,
  createUserSecretValueSchema,
  remoteSecretImportPreviewSchema,
  remoteSecretImportSchema,
  rotateSecretSchema,
  rotateUserSecretValueSchema,
  secretProviderConfigDiscoveryPreviewSchema,
  updateSecretProviderConfigSchema,
  updateSecretSchema,
  updateUserSecretDefinitionSchema,
  updateUserSecretValueSchema,
  type RotateSecret,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertBoardOrAgent, assertCompanyAccess, getAccessibleResource } from "./authz.js";
import { logActivity, secretService } from "../services/index.js";
import { createSecretProposalsService } from "../services/secret-proposals.js";
import { secretDeploymentAssertionService } from "../services/secret-deployment-assertions.js";
import { getConfiguredSecretProvider } from "../secrets/configured-provider.js";
import { conflict, forbidden, notFound, unauthorized, unprocessable } from "../errors.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { accessService } from "../services/access.js";
import { heartbeatService } from "../services/heartbeat.js";
import { issueService } from "../services/issues.js";
import type { IssueAssignmentWakeupDeps } from "../services/issue-assignment-wakeup.js";
import { createRunSecretRedactionRegistry } from "../services/run-secret-redaction.js";
import { notifySecretProposalResolution } from "../services/secret-proposal-notifications.js";
import { assertCanResolveProposal } from "../services/secret-proposal-authorization.js";

type SecretRoutesDeps = {
  heartbeat?: IssueAssignmentWakeupDeps;
  issues?: Pick<ReturnType<typeof issueService>, "getById" | "addComment">;
};

const DEFAULT_PROPOSAL_LIST_LIMIT = 100;
const MAX_PROPOSAL_LIST_LIMIT = 200;

function proposalListPage(query: Record<string, unknown>) {
  const rawLimit = query.limit;
  const rawOffset = query.offset;
  if (rawLimit !== undefined && (typeof rawLimit !== "string" || !/^\d+$/.test(rawLimit))) {
    throw unprocessable("limit must be a positive integer");
  }
  if (rawOffset !== undefined && (typeof rawOffset !== "string" || !/^\d+$/.test(rawOffset))) {
    throw unprocessable("offset must be a non-negative integer");
  }
  const requestedLimit = rawLimit === undefined ? DEFAULT_PROPOSAL_LIST_LIMIT : Number.parseInt(rawLimit, 10);
  if (requestedLimit < 1) throw unprocessable("limit must be a positive integer");
  return {
    limit: Math.min(requestedLimit, MAX_PROPOSAL_LIST_LIMIT),
    offset: rawOffset === undefined ? 0 : Number.parseInt(rawOffset, 10),
  };
}

function setProposalPaginationHeaders(
  res: Response,
  page: { limit: number; offset: number },
  hasMore: boolean,
) {
  res.setHeader("X-Page-Limit", String(page.limit));
  res.setHeader("X-Page-Offset", String(page.offset));
  if (hasMore) res.setHeader("X-Next-Offset", String(page.offset + page.limit));
}

function hasSecretDefinitionAdminAccess(req: Parameters<typeof assertBoard>[0], companyId: string) {
  assertBoard(req);
  assertCompanyAccess(req, companyId);
  if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return true;
  const membership = req.actor.memberships?.find((item) => item.companyId === companyId);
  return membership?.status === "active" && ["owner", "admin"].includes(String(membership.membershipRole));
}

function assertSecretDefinitionAdmin(req: Parameters<typeof assertBoard>[0], companyId: string) {
  if (hasSecretDefinitionAdminAccess(req, companyId)) return;
  throw forbidden("Company admin access required");
}

function assertCompanySecretWrite(req: Parameters<typeof assertBoard>[0], companyId: string) {
  assertBoard(req);
  assertCompanyAccess(req, companyId);
}

type SecretRotationGrant =
  | { mode: "board" }
  | {
      mode: "agent";
      agentId: string;
      runId: string;
      proposalId: string;
      assertion: {
        id: string;
        deploymentLabel: string;
        valueFingerprintSha256: string;
        expectedLatestVersion: number;
      };
    };

type SecretRotationDeps = {
  db: Db;
  proposals: Pick<ReturnType<typeof createSecretProposalsService>, "getById">;
};

// `agent_jwt` takes the run from verified token claims (auth.ts loads it with
// loadAgentRunAuthentication). `agent_key` copies the X-Paperclip-Run-Id
// header straight into req.actor.runId without checking it, so a long-lived
// key can name any run it likes. Any write that treats "a run id is present"
// as "a run vouched for this" must therefore refuse agent keys, task-bridge
// scopes and skill-test scopes — the same line the proposal gate already
// draws.
function isVerifiedRunBoundAgent(req: Parameters<typeof assertBoard>[0]) {
  return req.actor.source === "agent_jwt"
    && req.actor.keyScope?.kind !== "task_bridge"
    && req.actor.keyScope?.kind !== "skill_test";
}

async function assertSecretRotationWrite(
  deps: SecretRotationDeps,
  req: Parameters<typeof assertBoard>[0],
  secret: { id: string; companyId: string },
  body: RotateSecret,
): Promise<SecretRotationGrant> {
  if (req.actor.type === "board") return { mode: "board" };
  if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId || !req.actor.runId) {
    throw forbidden("Run-bound agent authentication required to rotate a secret");
  }
  if (!isVerifiedRunBoundAgent(req)) {
    throw forbidden("Secret rotation requires a verified run-bound agent token");
  }
  if (req.actor.companyId !== secret.companyId) {
    throw forbidden("Agent key cannot access another company");
  }
  if (!body.authorizationProposalId) {
    throw forbidden("A board-approved secret proposal is required: pass authorizationProposalId");
  }
  const proposal = await deps.proposals.getById(secret.companyId, body.authorizationProposalId);
  if (!proposal) throw forbidden("authorizationProposalId does not match a secret proposal in this company");
  if (proposal.kind !== "secret") throw forbidden("The authorization proposal must be a secret proposal");
  if (proposal.status !== "approved") throw forbidden("The authorization proposal has not been approved by the board");
  if (!proposal.resolvedByUserId) throw forbidden("The authorization proposal has no attributable human approval");
  if (proposal.expiresAt.getTime() <= Date.now()) {
    throw forbidden("The authorization proposal expired before this rotation was executed");
  }
  if (proposal.createdSecretId !== secret.id) throw forbidden("The authorization proposal does not target this secret");
  if (!proposal.valueFingerprintSha256) {
    throw forbidden("The authorization proposal no longer carries its approved value fingerprint");
  }
  if (body.expectedLatestVersion === undefined) {
    throw unprocessable("expectedLatestVersion is required when an agent rotates a secret");
  }
  if (!body.valueFingerprintSha256) {
    throw forbidden("valueFingerprintSha256 is required when an agent rotates a secret");
  }
  if (body.valueFingerprintSha256 !== proposal.valueFingerprintSha256) {
    throw conflict("valueFingerprintSha256 does not match the value approved in the proposal");
  }
  if (!body.deploymentAssertionId) {
    throw forbidden("A deployment assertion is required: pass deploymentAssertionId");
  }
  const assertion = await secretDeploymentAssertionService(deps.db).loadGuarded(body.deploymentAssertionId, secret);
  if (assertion.valueFingerprintSha256 !== body.valueFingerprintSha256) {
    throw forbidden("The deployment assertion does not certify the value being written");
  }
  if (assertion.expectedLatestVersion !== body.expectedLatestVersion) {
    throw conflict("The deployment assertion was registered for a different expectedLatestVersion");
  }
  return {
    mode: "agent",
    agentId: req.actor.agentId,
    runId: req.actor.runId,
    proposalId: proposal.id,
    assertion: {
      id: assertion.id,
      deploymentLabel: assertion.deploymentLabel,
      valueFingerprintSha256: assertion.valueFingerprintSha256,
      expectedLatestVersion: assertion.expectedLatestVersion,
    },
  };
}

function currentUserId(req: Parameters<typeof assertBoard>[0]) {
  assertBoard(req);
  if (req.actor.userId) return req.actor.userId;
  throw unauthorized("User identity required for user-specific secrets");
}

function boardActorUser(req: Parameters<typeof assertBoard>[0]) {
  assertBoard(req);
  return { userId: req.actor.userId ?? null, agentId: null };
}

function userSecretDefinitionActivityActor(req: Parameters<typeof assertBoard>[0]) {
  assertBoard(req);
  if (req.actor.userId) {
    return { actorType: "user" as const, actorId: req.actor.userId };
  }
  return { actorType: "system" as const, actorId: req.actor.source ?? "board" };
}

function isCompanyScopedSecret(secret: { scope?: string | null }) {
  return (secret.scope ?? "company") === "company";
}

export function secretRoutes(db: Db, deps: SecretRoutesDeps = {}) {
  const router = Router();
  const svc = secretService(db);
  const proposals = createSecretProposalsService(db);
  const access = accessService(db);
  const issues = deps.issues ?? issueService(db);
  const heartbeat = deps.heartbeat ?? heartbeatService(db);
  const runRedactions = createRunSecretRedactionRegistry(db);
  const defaultProvider = getConfiguredSecretProvider();

  async function assertSecretCatalogReadAllowed(req: Parameters<typeof assertBoard>[0], companyId: string) {
    const decision = await access.decide({
      actor: req.actor,
      action: "secrets:read",
      resource: { type: "company", companyId },
    });
    if (decision.allowed) return;
    throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
  }

  function agentSecretContext(req: Parameters<typeof assertBoard>[0]) {
    if (req.actor.type !== "agent" || !req.actor.agentId || !req.actor.companyId || !req.actor.runId) {
      throw forbidden("Run-bound agent authentication required");
    }
    return {
      companyId: req.actor.companyId,
      agentId: req.actor.agentId,
      actorSource: req.actor.source === "agent_jwt" ? "agent_jwt" as const : "agent_key" as const,
      keyId: req.actor.keyId ?? null,
      keyScope: req.actor.keyScope ?? null,
      heartbeatRunId: req.actor.runId,
      responsibleUserId: req.actor.onBehalfOfUserId ?? null,
    };
  }

  // Any write that treats "a run id is present" as "a run vouched for this"
  // must refuse agent keys, task-bridge scopes and skill-test scopes. The
  // shared predicate lives at module scope next to the rotation guard.
  async function proposalAgentContext(req: Parameters<typeof assertBoard>[0]) {
    const context = agentSecretContext(req);
    if (!isVerifiedRunBoundAgent(req)) {
      throw forbidden("Secret proposals require a verified run-bound agent token");
    }
    const decision = await access.decide({
      actor: req.actor,
      action: "secrets:propose",
      resource: { type: "company", companyId: context.companyId },
    });
    if (!decision.allowed) {
      throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }
    return context;
  }

  function agentProposalView(row: Awaited<ReturnType<typeof proposals.listForAgent>>[number]) {
    const { valueFingerprintSha256: _fingerprint, valueLength: _length, ...safe } = row;
    return safe;
  }

  async function bindingApprovalDecision(req: Parameters<typeof assertBoard>[0], proposal: {
    kind: string;
    targetId: string | null;
  }) {
    if (proposal.kind !== "binding") return null;
    if (!proposal.targetId) throw unprocessable("Binding proposal target is missing");
    return access.decide({
      actor: req.actor,
      action: "agent_config:update",
      resource: { type: "agent", companyId: req.params.companyId as string, agentId: proposal.targetId },
      scope: { requiresChangeGrant: true },
    });
  }

  async function boardProposalView(req: Parameters<typeof assertBoard>[0], proposal: Awaited<ReturnType<typeof proposals.listForBoard>>[number]) {
    if (proposal.status !== "pending") {
      return { ...proposal, viewerCanApprove: false, approveBlockReason: "Proposal is no longer pending" };
    }
    if (proposal.kind === "secret" && !hasSecretDefinitionAdminAccess(req, req.params.companyId as string)) {
      return { ...proposal, viewerCanApprove: false, approveBlockReason: "Company admin access required" };
    }
    const decision = await bindingApprovalDecision(req, proposal);
    return {
      ...proposal,
      viewerCanApprove: decision?.allowed ?? true,
      approveBlockReason: decision && !decision.allowed ? decision.explanation : null,
    };
  }

  router.post("/agents/me/secret-proposals", async (req, res) => {
    const context = await proposalAgentContext(req);
    const body = req.body ?? {};
    const proposal = body.kind === "secret"
      ? await proposals.createSecret({
          companyId: context.companyId,
          heartbeatRunId: context.heartbeatRunId,
          registerForRedaction: (value) => runRedactions.register(context.companyId, context.heartbeatRunId, value),
        }, {
          name: body.name,
          key: body.key,
          description: body.description,
          value: body.value,
          justification: body.justification,
        })
      : body.kind === "binding"
        ? await proposals.createBinding({ companyId: context.companyId, heartbeatRunId: context.heartbeatRunId }, {
            secretId: body.secretId, sourceConfigPath: body.sourceConfigPath,
            secretProposalId: body.secretProposalId, targetAgentId: body.targetAgentId,
            configPath: body.configPath, justification: body.justification, bindingTargetPolicy: "self_and_reports",
          })
        : (() => { throw unprocessable("kind must be secret or binding"); })();
    res.status(201).json(agentProposalView(await proposals.view(proposal)));
  });

  router.get("/agents/me/secret-proposals", async (req, res) => {
    const context = await proposalAgentContext(req);
    const page = proposalListPage(req.query);
    const rows = await proposals.listForAgent(context.companyId, context.agentId, {
      limit: page.limit + 1,
      offset: page.offset,
    });
    const hasMore = rows.length > page.limit;
    setProposalPaginationHeaders(res, page, hasMore);
    res.json({
      proposals: rows.slice(0, page.limit).map(agentProposalView),
      nextOffset: hasMore ? page.offset + page.limit : null,
    });
  });

  router.delete("/agents/me/secret-proposals/:id", async (req, res) => {
    const context = await proposalAgentContext(req);
    const proposal = await proposals.transition(context.companyId, req.params.id as string, "withdrawn", { proposerAgentId: context.agentId });
    res.json(agentProposalView(await proposals.view(proposal)));
  });

  router.get("/companies/:companyId/secret-proposals", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const page = proposalListPage(req.query);
    if (req.query.order !== undefined && req.query.order !== "created" && req.query.order !== "resolved") {
      throw unprocessable("order must be created or resolved");
    }
    const rows = await proposals.listForBoard(companyId, status, {
      limit: page.limit + 1,
      offset: page.offset,
      order: req.query.order === "resolved" ? "resolved" : "created",
    });
    const hasMore = rows.length > page.limit;
    setProposalPaginationHeaders(res, page, hasMore);
    res.json(await Promise.all(rows.slice(0, page.limit).map((proposal) => boardProposalView(req, proposal))));
  });

  router.post("/companies/:companyId/secret-proposals/:id/approve", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanySecretWrite(req, companyId);
    const proposal = await proposals.getById(companyId, req.params.id as string);
    if (!proposal) throw notFound("Secret proposal not found");
    await assertCanResolveProposal({
      db,
      actor: req.actor,
      companyId,
      proposal,
      assertSecretDefinitionAdmin: () => assertSecretDefinitionAdmin(req, companyId),
    });
    const resolvedByUserId = req.actor.userId ?? "board";
    const approved = await proposals.approve(companyId, proposal.id, {
      resolvedByUserId,
      cascade: req.body?.cascade === true,
      overrides: req.body?.overrides,
      assertCanResolve: (lockedProposal, txDb) => assertCanResolveProposal({
        db: txDb,
        actor: req.actor,
        companyId,
        proposal: lockedProposal,
        assertSecretDefinitionAdmin: () => assertSecretDefinitionAdmin(req, companyId),
      }),
    });
    await notifySecretProposalResolution({ proposal, status: "approved", userId: resolvedByUserId, issues, heartbeat });
    res.json(await boardProposalView(req, await proposals.view(approved)));
  });

  router.post("/companies/:companyId/secret-proposals/:id/reject", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const reason = typeof req.body?.reason === "string" ? req.body.reason.trim() : "";
    if (!reason) throw unprocessable("Rejection reason is required");
    const existing = await proposals.getById(companyId, req.params.id as string);
    if (!existing) throw notFound("Secret proposal not found");
    await assertCanResolveProposal({
      db,
      actor: req.actor,
      companyId,
      proposal: existing,
      assertSecretDefinitionAdmin: () => assertSecretDefinitionAdmin(req, companyId),
    });
    const resolvedByUserId = req.actor.userId ?? "board";
    const proposal = await proposals.transition(companyId, req.params.id as string, "rejected", {
      resolvedByUserId, reason,
    });
    await notifySecretProposalResolution({
      proposal: existing,
      status: "rejected",
      userId: resolvedByUserId,
      reason,
      issues,
      heartbeat,
    });
    res.json(await boardProposalView(req, await proposals.view(proposal)));
  });

  router.get("/agents/me/secrets", async (req, res) => {
    const context = agentSecretContext(req);
    const secrets = await svc.listAgentSecretAccess(context.companyId, context);
    await logActivity(db, {
      companyId: context.companyId,
      actorType: "agent",
      actorId: context.agentId,
      action: "secret.access.listed",
      entityType: "agent",
      entityId: context.agentId,
      agentId: context.agentId,
      runId: context.heartbeatRunId,
      details: { count: secrets.length },
    });
    res.json({
      secrets: secrets.map(({ secretId, bindingId: _bindingId, configPath: _configPath, ...secret }) => ({
        ...secret,
        secretRef: secretId,
      })),
    });
  });

  router.post("/agents/me/secrets/:key/value", async (req, res) => {
    const context = agentSecretContext(req);
    const available = await svc.listAgentSecretAccess(context.companyId, context);
    const secret = available.find((entry) => entry.key === req.params.key);
    if (!secret) throw forbidden("Secret access is not granted for this agent");
    const resolution = await svc.resolveSecretValueForAgentAccess(
      context.companyId,
      secret.secretId,
      secret.versionSelector,
      {
        ...context,
        configPath: secret.configPath,
        bindingId: secret.bindingId,
        issueId: null,
        registerForRedaction: (value) => runRedactions.register(context.companyId, context.heartbeatRunId, value),
      },
    );
    res.set("Cache-Control", "no-store");
    res.json({
      key: secret.key,
      value: resolution.value,
      version: resolution.version,
    });
  });

  router.get("/companies/:companyId/secret-providers", (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(svc.listProviders());
  });

  router.get("/companies/:companyId/secret-providers/health", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const checks = await svc.checkProviders();
    res.json({ providers: checks });
  });

  router.get("/companies/:companyId/secret-provider-configs", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listProviderConfigs(companyId));
  });

  router.post(
    "/companies/:companyId/secret-provider-configs/discovery/preview",
    validate(secretProviderConfigDiscoveryPreviewSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const preview = await svc.previewProviderConfigDiscovery(companyId, {
        provider: req.body.provider,
        config: req.body.config,
        query: req.body.query,
        nextToken: req.body.nextToken,
        pageSize: req.body.pageSize,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "secret_provider_config.discovery_previewed",
        entityType: "secret_provider_config_discovery",
        entityId: companyId,
        details: {
          provider: preview.provider,
          candidateCount: preview.candidates.length,
          sampledSecretCount: preview.sampledSecretCount,
          warningCount: preview.warnings.length,
        },
      });

      res.json(preview);
    },
  );

  router.post("/companies/:companyId/secret-provider-configs", validate(createSecretProviderConfigSchema), async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const created = await svc.createProviderConfig(
      companyId,
      {
        provider: req.body.provider,
        displayName: req.body.displayName,
        status: req.body.status,
        isDefault: req.body.isDefault,
        config: req.body.config,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.created",
      entityType: "secret_provider_config",
      entityId: created.id,
      details: {
        provider: created.provider,
        displayName: created.displayName,
        status: created.status,
        isDefault: created.isDefault,
      },
    });

    res.status(201).json(created);
  });

  router.get("/secret-provider-configs/:id", async (req, res) => {
    assertBoard(req);
    const existing = await getAccessibleResource(req, res, svc.getProviderConfigById(req.params.id as string), "Provider vault not found");
    if (!existing) return;
    res.json(existing);
  });

  router.patch("/secret-provider-configs/:id", validate(updateSecretProviderConfigSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getProviderConfigById(id), "Provider vault not found");
    if (!existing) return;

    const updated = await svc.updateProviderConfig(id, {
      displayName: req.body.displayName,
      status: req.body.status,
      isDefault: req.body.isDefault,
      config: req.body.config,
    });
    if (!updated) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.updated",
      entityType: "secret_provider_config",
      entityId: updated.id,
      details: {
        provider: updated.provider,
        displayName: updated.displayName,
        status: updated.status,
        isDefault: updated.isDefault,
      },
    });

    res.json(updated);
  });

  router.delete("/secret-provider-configs/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getProviderConfigById(id), "Provider vault not found");
    if (!existing) return;

    const removed = await svc.removeProviderConfig(id);
    if (!removed) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.removed",
      entityType: "secret_provider_config",
      entityId: removed.id,
      details: {
        provider: removed.provider,
        displayName: removed.displayName,
        remoteDeleted: false,
      },
    });

    res.json(removed);
  });

  router.post("/secret-provider-configs/:id/default", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getProviderConfigById(id), "Provider vault not found");
    if (!existing) return;

    const updated = await svc.setDefaultProviderConfig(id);
    if (!updated) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.default_set",
      entityType: "secret_provider_config",
      entityId: updated.id,
      details: {
        provider: updated.provider,
        displayName: updated.displayName,
        isDefault: updated.isDefault,
      },
    });

    res.json(updated);
  });

  router.post("/secret-provider-configs/:id/health", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const existing = await getAccessibleResource(req, res, svc.getProviderConfigById(id), "Provider vault not found");
    if (!existing) return;

    const health = await svc.checkProviderConfigHealth(id);
    if (!health) {
      res.status(404).json({ error: "Provider vault not found" });
      return;
    }

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret_provider_config.health_checked",
      entityType: "secret_provider_config",
      entityId: existing.id,
      details: {
        provider: existing.provider,
        status: health.status,
        code: health.details.code,
      },
    });

    res.json(health);
  });

  // Agent-readable catalog: returns only non-sensitive metadata (id, name, key, status).
  // Agents need this to resolve a secret name to its UUID when wiring env bindings,
  // without requiring board access or exposing any secret values.
  router.get("/companies/:companyId/secrets/catalog", async (req, res) => {
    assertBoardOrAgent(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    await assertSecretCatalogReadAllowed(req, companyId);
    const secrets = await svc.list(companyId);
    res.json(secrets.map(({ id, name, key, status }) => ({ id, name, key, status })));
  });

  router.get("/companies/:companyId/secrets", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const secrets = await svc.list(companyId);
    res.json(secrets);
  });

  router.get("/companies/:companyId/user-secret-definitions", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertSecretDefinitionAdmin(req, companyId);
    res.json(await svc.listUserSecretDefinitions(companyId));
  });

  router.post(
    "/companies/:companyId/user-secret-definitions",
    validate(createUserSecretDefinitionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertSecretDefinitionAdmin(req, companyId);

      const created = await svc.createUserSecretDefinition(
        companyId,
        {
          key: req.body.key,
          name: req.body.name,
          description: req.body.description,
          status: req.body.status,
          provider: req.body.provider ?? defaultProvider,
          providerConfigId: req.body.providerConfigId,
          managedMode: req.body.managedMode,
          providerMetadata: req.body.providerMetadata,
          usageGuidance: req.body.usageGuidance,
        },
        boardActorUser(req),
      );
      const activityActor = userSecretDefinitionActivityActor(req);

      await logActivity(db, {
        companyId,
        actorType: activityActor.actorType,
        actorId: activityActor.actorId,
        action: "user_secret_definition.created",
        entityType: "user_secret_definition",
        entityId: created.id,
        details: { key: created.key, provider: created.provider },
      });

      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/user-secret-definitions/:definitionId",
    validate(updateUserSecretDefinitionSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const definitionId = req.params.definitionId as string;
      assertSecretDefinitionAdmin(req, companyId);

      const updated = await svc.updateUserSecretDefinition(
        companyId,
        definitionId,
        {
          key: req.body.key,
          name: req.body.name,
          description: req.body.description,
          status: req.body.status,
          providerConfigId: req.body.providerConfigId,
          providerMetadata: req.body.providerMetadata,
          usageGuidance: req.body.usageGuidance,
        },
        boardActorUser(req),
      );
      if (!updated) {
        res.status(404).json({ error: "User secret definition not found" });
        return;
      }
      const activityActor = userSecretDefinitionActivityActor(req);
      const activityAction = req.body.status === "deleted"
        ? "user_secret_definition.deleted"
        : "user_secret_definition.updated";

      await logActivity(db, {
        companyId,
        actorType: activityActor.actorType,
        actorId: activityActor.actorId,
        action: activityAction,
        entityType: "user_secret_definition",
        entityId: updated.id,
        details: { key: updated.key, status: updated.status },
      });

      res.json(updated);
    },
  );

  router.delete("/companies/:companyId/user-secret-definitions/:definitionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const definitionId = req.params.definitionId as string;
    assertSecretDefinitionAdmin(req, companyId);

    const removed = await svc.removeUserSecretDefinition(
      companyId,
      definitionId,
      boardActorUser(req),
    );
    if (!removed) {
      res.status(404).json({ error: "User secret definition not found" });
      return;
    }
    const activityActor = userSecretDefinitionActivityActor(req);

    await logActivity(db, {
      companyId,
      actorType: activityActor.actorType,
      actorId: activityActor.actorId,
      action: "user_secret_definition.deleted",
      entityType: "user_secret_definition",
      entityId: removed.id,
      details: { key: removed.key },
    });

    res.json({ ok: true });
  });

  router.get("/companies/:companyId/user-secret-definitions/:definitionId/coverage", async (req, res) => {
    const companyId = req.params.companyId as string;
    const definitionId = req.params.definitionId as string;
    assertSecretDefinitionAdmin(req, companyId);
    res.json(await svc.getUserSecretDefinitionCoverage(companyId, definitionId));
  });

  router.get("/companies/:companyId/me/user-secrets", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.listCurrentUserSecretValues(companyId, currentUserId(req)));
  });

  router.post(
    "/companies/:companyId/me/user-secrets",
    validate(createUserSecretValueSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const ownerUserId = currentUserId(req);
      const created = await svc.createCurrentUserSecretValue(
        companyId,
        ownerUserId,
        {
          definitionKey: req.body.definitionKey,
          definitionId: req.body.definitionId,
          value: req.body.value,
          externalRef: req.body.externalRef,
          providerVersionRef: req.body.providerVersionRef,
          providerConfigId: req.body.providerConfigId,
        },
        { userId: ownerUserId, agentId: null },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: ownerUserId,
        action: "user_secret_value.created",
        entityType: "secret",
        entityId: created.id,
        details: {
          userSecretDefinitionId: created.userSecretDefinitionId,
          ownerUserId: created.ownerUserId,
          provider: created.provider,
        },
      });

      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/me/user-secrets/:secretId",
    validate(updateUserSecretValueSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const secretId = req.params.secretId as string;
      assertCompanyAccess(req, companyId);
      const ownerUserId = currentUserId(req);
      const updated = await svc.updateCurrentUserSecretValue(
        companyId,
        ownerUserId,
        secretId,
        {
          status: req.body.status,
          value: req.body.value,
          externalRef: req.body.externalRef,
          providerVersionRef: req.body.providerVersionRef,
          providerConfigId: req.body.providerConfigId,
        },
        { userId: ownerUserId, agentId: null },
      );
      if (!updated) {
        res.status(404).json({ error: "User secret value not found" });
        return;
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: ownerUserId,
        action: "user_secret_value.updated",
        entityType: "secret",
        entityId: updated.id,
        details: {
          userSecretDefinitionId: updated.userSecretDefinitionId,
          ownerUserId: updated.ownerUserId,
          status: updated.status,
        },
      });

      res.json(updated);
    },
  );

  router.post(
    "/companies/:companyId/me/user-secrets/:secretId/rotate",
    validate(rotateUserSecretValueSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const secretId = req.params.secretId as string;
      assertCompanyAccess(req, companyId);
      const ownerUserId = currentUserId(req);
      const rotated = await svc.rotateCurrentUserSecretValue(
        companyId,
        ownerUserId,
        secretId,
        {
          value: req.body.value,
          externalRef: req.body.externalRef,
          providerVersionRef: req.body.providerVersionRef,
          providerConfigId: req.body.providerConfigId,
        },
        { userId: ownerUserId, agentId: null },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: ownerUserId,
        action: "user_secret_value.rotated",
        entityType: "secret",
        entityId: rotated.id,
        details: {
          userSecretDefinitionId: rotated.userSecretDefinitionId,
          ownerUserId: rotated.ownerUserId,
          version: rotated.latestVersion,
        },
      });

      res.json(rotated);
    },
  );

  router.delete("/companies/:companyId/me/user-secrets/:secretId", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    const secretId = req.params.secretId as string;
    assertCompanyAccess(req, companyId);
    const ownerUserId = currentUserId(req);
    const removed = await svc.removeCurrentUserSecretValue(companyId, ownerUserId, secretId);
    if (!removed) {
      res.status(404).json({ error: "User secret value not found" });
      return;
    }

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: ownerUserId,
      action: "user_secret_value.deleted",
      entityType: "secret",
      entityId: removed.id,
      details: {
        userSecretDefinitionId: removed.userSecretDefinitionId,
        ownerUserId: removed.ownerUserId,
      },
    });

    res.json({ ok: true });
  });

  router.post("/companies/:companyId/secrets", (req, _res, next) => {
    const companyId = req.params.companyId as string;
    if (req.actor.type === "agent") {
      assertCompanyAccess(req, companyId);
      throw forbidden("Company secret creation requires a human board operator. Ask the human to enter the value in Settings → Secrets for this company. Do not send secret values in chat or tool calls. You can finish the current conversation response with these secure-entry instructions without claiming that credential setup is complete. If you need a resumable wait, first create a non-governing secure-save acknowledgment with request_human_input with interactionKind=\"confirmation\"; ask only whether secure entry is complete, never ask for the secret value in that card. Wait only on the actual saved request.");
    }
    assertCompanySecretWrite(req, companyId);
    next();
  }, validate(createSecretSchema), async (req, res) => {
    const companyId = req.params.companyId as string;

    const created = await svc.create(
      companyId,
      {
        name: req.body.name,
        key: req.body.key,
        provider: req.body.provider ?? defaultProvider,
        providerConfigId: req.body.providerConfigId,
        managedMode: req.body.managedMode,
        value: req.body.value,
        description: req.body.description,
        externalRef: req.body.externalRef,
        providerVersionRef: req.body.providerVersionRef,
        providerMetadata: req.body.providerMetadata,
      },
      { userId: req.actor.userId ?? "board", agentId: null },
    );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.created",
      entityType: "secret",
      entityId: created.id,
      details: { name: created.name, provider: created.provider },
    });

    res.status(201).json(created);
  });

  router.post(
    "/companies/:companyId/secrets/remote-import/preview",
    validate(remoteSecretImportPreviewSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const preview = await svc.previewRemoteImport(companyId, {
        providerConfigId: req.body.providerConfigId,
        query: req.body.query,
        nextToken: req.body.nextToken,
        pageSize: req.body.pageSize,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "secret.remote_import.previewed",
        entityType: "secret_provider_config",
        entityId: preview.providerConfigId,
        details: {
          provider: preview.provider,
          candidateCount: preview.candidates.length,
          readyCount: preview.candidates.filter((candidate) => candidate.status === "ready").length,
          duplicateCount: preview.candidates.filter((candidate) => candidate.status === "duplicate").length,
          conflictCount: preview.candidates.filter((candidate) => candidate.status === "conflict").length,
        },
      });

      res.json(preview);
    },
  );

  router.post(
    "/companies/:companyId/secrets/remote-import",
    validate(remoteSecretImportSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const result = await svc.importRemoteSecrets(
        companyId,
        {
          providerConfigId: req.body.providerConfigId,
          secrets: req.body.secrets,
        },
        { userId: req.actor.userId ?? "board", agentId: null },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "secret.remote_import.completed",
        entityType: "secret_provider_config",
        entityId: result.providerConfigId,
        details: {
          provider: result.provider,
          importedCount: result.importedCount,
          skippedCount: result.skippedCount,
          errorCount: result.errorCount,
        },
      });

      res.json(result);
    },
  );

  router.post("/secrets/:id/rotate", validate(rotateSecretSchema), async (req, res) => {
    const id = req.params.id as string;
    const fetched = await svc.getById(id);
    const existing = await getAccessibleResource(
      req,
      res,
      fetched && isCompanyScopedSecret(fetched) ? fetched : null,
      "Secret not found",
    );
    if (!existing) return;
    if (existing.status === "deleted") {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    if (existing.status !== "active") {
      throw unprocessable("Cannot rotate a non-active secret");
    }

    const grant = await assertSecretRotationWrite({ db, proposals }, req, existing, req.body);
    const body = req.body as RotateSecret;
    if (grant.mode === "agent") {
      // The board approved a value, not a vault migration. An agent rotation
      // may carry that value and nothing else: no external reference, no
      // provider pin, no move to another provider vault. Any of those would
      // let the agent decide where the secret points after the board approved
      // only a value.
      if (body.externalRef !== undefined && body.externalRef !== null) {
        throw forbidden(
          "An agent rotation may not change externalRef: the board approves a value, not a reference",
        );
      }
      if (body.providerVersionRef !== undefined && body.providerVersionRef !== null) {
        throw forbidden("An agent rotation may not pin providerVersionRef");
      }
      if (body.providerConfigId !== undefined && body.providerConfigId !== null) {
        throw forbidden("An agent rotation may not move the secret to another provider vault");
      }
      // `requireSecretRotationInput` guarantees a non-empty value source and
      // the three rejections above remove every source other than `value`, so
      // the plaintext below is the one the board approved. `assertSecretRotationWrite`
      // already proved that `body.valueFingerprintSha256` equals the
      // proposal's fingerprint, so this is what ties the plaintext to that
      // approval — for every provider, before any provider write. The
      // post-write check below is defence in depth, not the control: a
      // provider that commits first and fails that check would already hold
      // the approved value, never a different one. An absent value hashes to
      // something no proposal can approve, so it fails closed here too.
      const suppliedValue = typeof body.value === "string" ? body.value : "";
      if (createHash("sha256").update(suppliedValue).digest("hex") !== body.valueFingerprintSha256) {
        throw conflict("valueFingerprintSha256 does not match the value supplied for rotation");
      }
    }

    const rotated = await svc.rotate(
      id,
      {
        value: body.value,
        externalRef: body.externalRef,
        providerVersionRef: body.providerVersionRef,
        providerConfigId: body.providerConfigId,
        expectedLatestVersion: body.expectedLatestVersion,
      },
      grant.mode === "agent"
        ? { userId: null, agentId: grant.agentId }
        : { userId: req.actor.userId ?? "board", agentId: null },
    );

    if (grant.mode === "board") {
      await logActivity(db, {
        companyId: rotated.companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "secret.rotated",
        entityType: "secret",
        entityId: rotated.id,
        details: { version: rotated.latestVersion },
      });
      res.json(rotated);
      return;
    }

    const assertions = secretDeploymentAssertionService(db);
    const liveFingerprint = await assertions.currentVersionFingerprint(rotated.id, rotated.latestVersion);
    if (liveFingerprint !== body.valueFingerprintSha256) {
      throw conflict("The rotated value does not match the fingerprint approved for this rotation");
    }
    const consumed = await assertions.consume(grant.assertion.id);
    if (!consumed) throw conflict("The deployment assertion could not be consumed");
    await logActivity(db, {
      companyId: rotated.companyId,
      actorType: "agent",
      actorId: grant.agentId,
      agentId: grant.agentId,
      runId: grant.runId,
      action: "secret.rotated",
      entityType: "secret",
      entityId: rotated.id,
      details: {
        version: rotated.latestVersion,
        fingerprintSha256: body.valueFingerprintSha256,
        deploymentLabel: grant.assertion.deploymentLabel,
        authorizationProposalId: grant.proposalId,
        deploymentAssertionId: grant.assertion.id,
      },
    });

    res.json(rotated);
  });

  router.post("/secrets/:id/deployment-assertions", validate(createDeploymentAssertionSchema), async (req, res) => {
    const id = req.params.id as string;
    const fetched = await svc.getById(id);
    const existing = await getAccessibleResource(
      req,
      res,
      fetched && isCompanyScopedSecret(fetched) ? fetched : null,
      "Secret not found",
    );
    if (!existing) return;
    if (existing.status === "deleted") {
      res.status(404).json({ error: "Secret not found" });
      return;
    }
    if (existing.status !== "active") {
      throw unprocessable("Cannot register a deployment assertion for a non-active secret");
    }

    let assertedByAgentId: string | null = null;
    let originRunId: string | null = null;
    if (req.actor.type === "agent") {
      if (!req.actor.agentId || !req.actor.companyId || !req.actor.runId) {
        throw forbidden("Run-bound agent authentication required to assert a deployment");
      }
      if (!isVerifiedRunBoundAgent(req)) {
        throw forbidden("Deployment assertions require a verified run-bound agent token");
      }
      if (req.actor.companyId !== existing.companyId) {
        throw forbidden("Agent key cannot access another company");
      }
      assertedByAgentId = req.actor.agentId;
      originRunId = req.actor.runId;
    } else if (req.actor.type !== "board") {
      throw forbidden("Board or run-bound agent access required");
    }

    const assertions = secretDeploymentAssertionService(db);
    await assertions.assertRegistrationPreconditions({
      secret: existing,
      expectedLatestVersion: req.body.expectedLatestVersion,
      valueFingerprintSha256: req.body.valueFingerprintSha256,
      previousValueFingerprintSha256: req.body.previousValueFingerprintSha256,
    });

    const proposal = await proposals.findProposalForAssertion(existing, req.body.valueFingerprintSha256);
    if (!proposal) {
      throw forbidden("No secret proposal for this secret certifies the asserted value fingerprint");
    }

    const originIssueId = originRunId
      ? await db
          .select({ id: issueRows.id })
          .from(issueRows)
          .where(and(
            eq(issueRows.companyId, existing.companyId),
            or(eq(issueRows.executionRunId, originRunId), eq(issueRows.checkoutRunId, originRunId)),
          ))
          .then((rows) => rows[0]?.id ?? null)
      : null;

    const assertion = await assertions.register({
      companyId: existing.companyId,
      secretId: existing.id,
      expectedLatestVersion: req.body.expectedLatestVersion,
      valueFingerprintSha256: req.body.valueFingerprintSha256,
      previousValueFingerprintSha256: req.body.previousValueFingerprintSha256,
      deploymentLabel: req.body.deploymentLabel,
      assertedByAgentId,
      originRunId,
      originIssueId,
    });

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: assertedByAgentId ? "agent" : "user",
      actorId: assertedByAgentId ?? req.actor.userId ?? "board",
      agentId: assertedByAgentId,
      runId: originRunId,
      action: "secret.deployment_asserted",
      entityType: "secret",
      entityId: existing.id,
      details: {
        deploymentAssertionId: assertion.id,
        deploymentLabel: assertion.deploymentLabel,
        expectedLatestVersion: assertion.expectedLatestVersion,
        fingerprintSha256: assertion.valueFingerprintSha256,
        proposalId: proposal.id,
      },
    });

    res.status(201).json(assertion);
  });

  router.patch("/secrets/:id", validate(updateSecretSchema), async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const fetched = await svc.getById(id);
    const existing = await getAccessibleResource(
      req,
      res,
      fetched && isCompanyScopedSecret(fetched) ? fetched : null,
      "Secret not found",
    );
    if (!existing) return;
    if (existing.status === "deleted") {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    const updated = await svc.update(id, {
      name: req.body.name,
      key: req.body.key,
      status: req.body.status,
      providerConfigId: req.body.providerConfigId,
      description: req.body.description,
      externalRef: req.body.externalRef,
      providerMetadata: req.body.providerMetadata,
    });

    if (!updated) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: updated.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.updated",
      entityType: "secret",
      entityId: updated.id,
      details: { name: updated.name },
    });

    res.json(updated);
  });

  router.get("/secrets/:id/usage", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const fetched = await svc.getById(id);
    const existing = await getAccessibleResource(
      req,
      res,
      fetched && isCompanyScopedSecret(fetched) ? fetched : null,
      "Secret not found",
    );
    if (!existing) return;
    const bindings = await svc.listBindingReferences(existing.companyId, existing.id);
    res.json({ secretId: existing.id, bindings });
  });

  router.get("/secrets/:id/access-events", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const fetched = await svc.getById(id);
    const existing = await getAccessibleResource(
      req,
      res,
      fetched && isCompanyScopedSecret(fetched) ? fetched : null,
      "Secret not found",
    );
    if (!existing) return;
    const events = await svc.listAccessEvents(existing.companyId, existing.id);
    res.json(events);
  });

  router.delete("/secrets/:id", async (req, res) => {
    assertBoard(req);
    const id = req.params.id as string;
    const fetched = await svc.getById(id);
    const existing = await getAccessibleResource(
      req,
      res,
      fetched && isCompanyScopedSecret(fetched) ? fetched : null,
      "Secret not found",
    );
    if (!existing) return;

    const resolvedByUserId = req.actor.userId ?? "board";
    const reason = "The referenced secret was deleted.";
    const removed = await svc.remove(id, {
      beforeDelete: async (secret) => {
        const rejected = await proposals.rejectPendingBindingsForSecret(secret.companyId, secret.id, { resolvedByUserId, reason });
        // Same signal as an ordinary rejection, so the proposing agent continues.
        for (const proposal of rejected) {
          await notifySecretProposalResolution({ proposal, status: "rejected", userId: resolvedByUserId, reason, issues, heartbeat });
        }
      },
    });
    if (!removed) {
      res.status(404).json({ error: "Secret not found" });
      return;
    }

    await logActivity(db, {
      companyId: removed.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "secret.deleted",
      entityType: "secret",
      entityId: removed.id,
      details: { name: removed.name },
    });

    res.json({ ok: true });
  });

  return router;
}
