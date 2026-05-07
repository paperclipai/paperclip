import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { randomUUID } from "node:crypto";
import {
  applyBuilderProposalSchema,
  createBuilderSessionSchema,
  rejectBuilderProposalSchema,
  sendBuilderMessageSchema,
  updateBuilderProviderSettingsSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { builderService } from "../services/builder/index.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { logActivity } from "../services/activity-log.js";
import { secretService } from "../services/secrets.js";
import { logger } from "../middleware/logger.js";
import { assertCompanyAccess, getActorInfo } from "./authz.js";
import { forbidden, notFound } from "../errors.js";
import type { BuilderProviderSettings } from "@paperclipai/shared";

/**
 * Company AI Builder REST routes.
 *
 * Phase 0 surface (read + chat, no mutations):
 *   GET    /api/companies/:companyId/builder/settings
 *   PUT    /api/companies/:companyId/builder/settings
 *   GET    /api/companies/:companyId/builder/tools
 *   GET    /api/companies/:companyId/builder/sessions
 *   POST   /api/companies/:companyId/builder/sessions
 *   GET    /api/companies/:companyId/builder/sessions/:sid
 *   POST   /api/companies/:companyId/builder/sessions/:sid/messages
 *   POST   /api/companies/:companyId/builder/sessions/:sid/abort
 *   POST   /api/companies/:companyId/builder/sessions/:sid/archive
 *   POST   /api/companies/:companyId/builder/sessions/:sid/restore
 *
 * Authz: board only in v0. Agents are blocked even with company access; the
 * Builder is an operator copilot, not an agent runtime surface. Phase 2 may
 * add a `builder:use` permission for agents.
 */
function assertBoardActor(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Builder is board-only in this release");
  }
}

async function assertBuilderEnabled(db: Db) {
  const experimental = await instanceSettingsService(db).getExperimental();
  if (!experimental.builderEnabled) {
    throw notFound("Builder not enabled");
  }
}

function actorIdentity(req: Request) {
  if (req.actor.type !== "board") {
    throw forbidden("Builder is board-only in this release");
  }
  return {
    userId: req.actor.userId ?? null,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function getHeaderValueIgnoreCase(headers: Record<string, unknown>, key: string): string | null {
  for (const [entryKey, entryValue] of Object.entries(headers)) {
    if (entryKey.toLowerCase() !== key.toLowerCase()) continue;
    const value = asNonEmptyString(entryValue);
    if (value) return value;
  }
  return null;
}

function deleteHeaderIgnoreCase(headers: Record<string, unknown>, key: string) {
  for (const entryKey of Object.keys(headers)) {
    if (entryKey.toLowerCase() === key.toLowerCase()) {
      delete headers[entryKey];
    }
  }
}

function tokenFromAuthorizationHeader(value: string | null) {
  if (!value) return null;
  const match = value.match(/^bearer\s+(.+)$/i);
  return match?.[1]?.trim() || value.trim() || null;
}

function extractOpenClawAuthToken(adapterConfig: Record<string, unknown>) {
  const explicit = asNonEmptyString(adapterConfig.authToken) ?? asNonEmptyString(adapterConfig.token);
  if (explicit) return explicit;
  const headers = asRecord(adapterConfig.headers) ?? {};
  const tokenHeader = getHeaderValueIgnoreCase(headers, "x-openclaw-token");
  if (tokenHeader) return tokenHeader;
  const authHeader =
    getHeaderValueIgnoreCase(headers, "x-openclaw-auth")
    ?? getHeaderValueIgnoreCase(headers, "authorization");
  return tokenFromAuthorizationHeader(authHeader);
}

function sanitizeOpenClawAdapterConfig(adapterConfig: Record<string, unknown>) {
  const next = { ...adapterConfig };
  delete next.authToken;
  delete next.token;

  const headers = asRecord(next.headers);
  if (headers) {
    const sanitizedHeaders = { ...headers };
    deleteHeaderIgnoreCase(sanitizedHeaders, "x-openclaw-token");
    deleteHeaderIgnoreCase(sanitizedHeaders, "x-openclaw-auth");
    deleteHeaderIgnoreCase(sanitizedHeaders, "authorization");
    next.headers = Object.keys(sanitizedHeaders).length > 0 ? sanitizedHeaders : undefined;
  }

  return next;
}

function sanitizeOttoAdapterConfig(adapterConfig: Record<string, unknown>) {
  const next = { ...adapterConfig };
  delete next.apiKey;
  return next;
}

function buildBuilderSecretName(prefix: string) {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function persistBuilderSecrets(params: {
  db: Db;
  companyId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  existingSettings: BuilderProviderSettings | null;
  actor: { userId?: string | null; agentId?: string | null };
}) {
  const secrets = secretService(params.db);

  if (params.adapterType === "openclaw_gateway") {
    const plainToken = extractOpenClawAuthToken(params.adapterConfig);
    const sanitized = sanitizeOpenClawAdapterConfig(params.adapterConfig);
    const existingRef = asRecord(params.existingSettings?.adapterConfig)?.authTokenRef;
    const requestedRef = sanitized.authTokenRef ?? existingRef;

    if (!plainToken) {
      if (requestedRef !== undefined) {
        const normalizedRef = await secrets.normalizeSecretRefBindingForPersistence(
          params.companyId,
          requestedRef,
          "adapterConfig.authTokenRef",
        );
        return {
          ...sanitized,
          authTokenRef: normalizedRef,
        };
      }
      return sanitized;
    }

    if (requestedRef !== undefined) {
      const normalizedRef = await secrets.normalizeSecretRefBindingForPersistence(
        params.companyId,
        requestedRef,
        "adapterConfig.authTokenRef",
      );
      await secrets.rotate(normalizedRef.secretId, { value: plainToken }, params.actor);
      return {
        ...sanitized,
        authTokenRef: normalizedRef,
      };
    }

    const secret = await secrets.create(
      params.companyId,
      {
        name: buildBuilderSecretName("builder-openclaw-gateway-token"),
        provider: "local_encrypted",
        value: plainToken,
        description: "OpenClaw gateway access token for AI Builder",
      },
      params.actor,
    );
    return {
      ...sanitized,
      authTokenRef: {
        type: "secret_ref" as const,
        secretId: secret.id,
        version: "latest" as const,
      },
    };
  }

  if (params.adapterType === "otto_agent") {
    const plainApiKey = asNonEmptyString(params.adapterConfig.apiKey);
    const sanitized = sanitizeOttoAdapterConfig(params.adapterConfig);
    const existingRef = asRecord(params.existingSettings?.adapterConfig)?.apiKeyRef;
    const requestedRef = sanitized.apiKeyRef ?? existingRef;

    if (!plainApiKey) {
      if (requestedRef !== undefined) {
        const normalizedRef = await secrets.normalizeSecretRefBindingForPersistence(
          params.companyId,
          requestedRef,
          "adapterConfig.apiKeyRef",
        );
        return {
          ...sanitized,
          apiKeyRef: normalizedRef,
        };
      }
      return sanitized;
    }

    if (requestedRef !== undefined) {
      const normalizedRef = await secrets.normalizeSecretRefBindingForPersistence(
        params.companyId,
        requestedRef,
        "adapterConfig.apiKeyRef",
      );
      await secrets.rotate(normalizedRef.secretId, { value: plainApiKey }, params.actor);
      return {
        ...sanitized,
        apiKeyRef: normalizedRef,
      };
    }

    const secret = await secrets.create(
      params.companyId,
      {
        name: buildBuilderSecretName("builder-otto-agent-apikey"),
        provider: "local_encrypted",
        value: plainApiKey,
        description: "Otto Agent API key for AI Builder",
      },
      params.actor,
    );
    return {
      ...sanitized,
      apiKeyRef: {
        type: "secret_ref" as const,
        secretId: secret.id,
        version: "latest" as const,
      },
    };
  }

  return params.adapterConfig;
}

export function builderRoutes(db: Db) {
  const router = Router();
  const svc = builderService(db);

  // ------------------------------------------------------------------------
  // Provider settings
  // ------------------------------------------------------------------------

  router.get("/companies/:companyId/builder/settings", async (req, res) => {
    await assertBuilderEnabled(db);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    const settings = await svc.getSettings(companyId);
    res.json({ settings });
  });

  router.put(
    "/companies/:companyId/builder/settings",
    validate(updateBuilderProviderSettingsSchema),
    async (req, res) => {
      await assertBuilderEnabled(db);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const existingSettings = await svc.getSettings(companyId);
      const actor = actorIdentity(req);
      const adapterConfig = await persistBuilderSecrets({
        db,
        companyId,
        adapterType: req.body.adapterType,
        adapterConfig: req.body.adapterConfig,
        existingSettings,
        actor,
      });
      const updated = await svc.upsertSettings(companyId, {
        adapterType: req.body.adapterType,
        adapterConfig,
      });
      res.json({ settings: updated });
      // Best-effort activity log — never fail settings update because of logging
      const actorInfo = getActorInfo(req);
      logActivity(db, {
        companyId,
        actorType: actorInfo.actorType,
        actorId: actorInfo.actorId,
        agentId: actorInfo.agentId,
        runId: actorInfo.runId,
        action: "builder.settings_updated",
        entityType: "builder_provider_settings",
        entityId: companyId,
        details: {
          adapterType: updated.adapterType,
        },
      }).catch((logErr) =>
        logger.warn({ logErr, companyId }, "builder settings: activity log failed"),
      );
    },
  );

  // ------------------------------------------------------------------------
  // Tool catalog
  // ------------------------------------------------------------------------

  router.get("/companies/:companyId/builder/tools", async (req, res) => {
    await assertBuilderEnabled(db);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    res.json(svc.getToolCatalog(companyId));
  });

  // ------------------------------------------------------------------------
  // Sessions
  // ------------------------------------------------------------------------

  router.get("/companies/:companyId/builder/sessions", async (req, res) => {
    await assertBuilderEnabled(db);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    const includeArchived = req.query.includeArchived === "true";
    const sessions = await svc.listSessions(companyId, { includeArchived });
    res.json({ sessions });
  });

  router.post(
    "/companies/:companyId/builder/sessions",
    validate(createBuilderSessionSchema),
    async (req, res) => {
      await assertBuilderEnabled(db);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const identity = actorIdentity(req);
      const session = await svc.createSession({
        companyId,
        createdByUserId: identity.userId,
        title: typeof req.body.title === "string" ? req.body.title : "",
      });
      res.status(201).json({ session });
      // Best-effort activity log — never fail session creation because of logging
      const actor = getActorInfo(req);
      logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "builder.session.created",
        entityType: "builder_session",
        entityId: session.id,
        details: { title: session.title },
      }).catch((logErr) =>
        logger.warn({ logErr, sessionId: session.id }, "builder sessions: activity log failed"),
      );
    },
  );

  router.get("/companies/:companyId/builder/sessions/:sessionId", async (req, res) => {
    await assertBuilderEnabled(db);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    const detail = await svc.getSessionDetail(companyId, req.params.sessionId as string);
    if (!detail) throw notFound("Session not found");
    res.json({ session: detail });
  });

  router.post(
    "/companies/:companyId/builder/sessions/:sessionId/messages",
    validate(sendBuilderMessageSchema),
    async (req, res) => {
      await assertBuilderEnabled(db);
      const companyId = req.params.companyId as string;
      const sessionId = req.params.sessionId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const identity = actorIdentity(req);
      const result = await svc.sendMessage({
        companyId,
        sessionId,
        actor: { type: "user", id: identity.userId },
        text: req.body.text,
      });
      if (!result) throw notFound("Session not found");
      res.json({
        userMessage: result.userMessage,
        newMessages: result.newMessages,
        usage: result.usage,
        truncated: result.truncated,
      });
      // Best-effort activity log — never fail the turn because of logging
      const actor = getActorInfo(req);
      logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "builder.session.message_sent",
        entityType: "builder_session",
        entityId: sessionId,
        details: {
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          truncated: result.truncated,
          newMessageCount: result.newMessages.length,
        },
      }).catch((logErr) =>
        logger.warn({ logErr, sessionId }, "builder messages: activity log failed"),
      );
    },
  );

  router.post(
    "/companies/:companyId/builder/sessions/:sessionId/abort",
    async (req, res) => {
      await assertBuilderEnabled(db);
      const companyId = req.params.companyId as string;
      const sessionId = req.params.sessionId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const aborted = await svc.abortSession(companyId, sessionId);
      if (!aborted) throw notFound("Session not found");
      res.json({ session: aborted });
      // Best-effort activity log — never fail the abort because of logging
      const actor = getActorInfo(req);
      logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "builder.session.aborted",
        entityType: "builder_session",
        entityId: sessionId,
        details: null,
      }).catch((logErr) =>
        logger.warn({ logErr, sessionId }, "builder abort: activity log failed"),
      );
    },
  );

  router.post(
    "/companies/:companyId/builder/sessions/:sessionId/archive",
    async (req, res) => {
      await assertBuilderEnabled(db);
      const companyId = req.params.companyId as string;
      const sessionId = req.params.sessionId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const archived = await svc.archiveSession(companyId, sessionId);
      if (!archived) throw notFound("Session not found");
      res.json({ session: archived });
      const actor = getActorInfo(req);
      logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "builder.session.archived",
        entityType: "builder_session",
        entityId: sessionId,
        details: { archivedAt: archived.archivedAt },
      }).catch((logErr) =>
        logger.warn({ logErr, sessionId }, "builder archive: activity log failed"),
      );
    },
  );

  router.post(
    "/companies/:companyId/builder/sessions/:sessionId/restore",
    async (req, res) => {
      await assertBuilderEnabled(db);
      const companyId = req.params.companyId as string;
      const sessionId = req.params.sessionId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const restored = await svc.restoreSession(companyId, sessionId);
      if (!restored) throw notFound("Session not found");
      res.json({ session: restored });
      const actor = getActorInfo(req);
      logActivity(db, {
        companyId,
        actorType: actor.actorType,
        actorId: actor.actorId,
        agentId: actor.agentId,
        runId: actor.runId,
        action: "builder.session.restored",
        entityType: "builder_session",
        entityId: sessionId,
        details: { archivedAt: null },
      }).catch((logErr) =>
        logger.warn({ logErr, sessionId }, "builder restore: activity log failed"),
      );
    },
  );

  // ------------------------------------------------------------------------
  // SSE streaming
  // ------------------------------------------------------------------------
  // POST .../messages/stream — same payload as /messages but writes the
  // result as a Server-Sent Events stream. Phase 4: provider streaming will
  // be added; for now we stream a single end-of-turn event so clients can
  // start using the API now and gain incremental updates later transparently.

  router.post(
    "/companies/:companyId/builder/sessions/:sessionId/messages/stream",
    validate(sendBuilderMessageSchema),
    async (req, res) => {
      await assertBuilderEnabled(db);
      const companyId = req.params.companyId as string;
      const sessionId = req.params.sessionId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const identity = actorIdentity(req);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();

      const send = (event: string, data: unknown) => {
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      const ac = new AbortController();
      req.on("close", () => ac.abort());

      send("start", { sessionId });

      try {
        const result = await svc.sendMessage({
          companyId,
          sessionId,
          actor: { type: "user", id: identity.userId },
          text: req.body.text,
          signal: ac.signal,
        });
        if (!result) {
          send("error", { error: "Session not found" });
          res.end();
          return;
        }
        send("user_message", result.userMessage);
        for (const message of result.newMessages) {
          send("message", message);
        }
        send("done", {
          usage: result.usage,
          truncated: result.truncated,
          messageCount: result.newMessages.length,
        });
        // Best-effort activity log — never fail the SSE turn because of logging
        const actor = getActorInfo(req);
        logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action: "builder.session.message_sent",
          entityType: "builder_session",
          entityId: sessionId,
          details: {
            inputTokens: result.usage.inputTokens,
            outputTokens: result.usage.outputTokens,
            truncated: result.truncated,
            newMessageCount: result.newMessages.length,
            stream: true,
          },
        }).catch((logErr) =>
          logger.warn({ logErr, sessionId }, "builder stream: activity log failed"),
        );
      } catch (err) {
        send("error", {
          error: err instanceof Error ? err.message : "Builder run failed",
        });
      } finally {
        res.end();
      }
    },
  );

  // ------------------------------------------------------------------------
  // Proposals (Phases 1 + 2)
  // ------------------------------------------------------------------------

  router.get("/companies/:companyId/builder/proposals", async (req, res) => {
    await assertBuilderEnabled(db);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoardActor(req);
    const sessionId =
      typeof req.query.sessionId === "string" ? (req.query.sessionId as string) : undefined;
    const ALLOWED_STATUSES: ReadonlyArray<string> = ["pending", "approved", "applied", "rejected", "failed"];
    const status =
      typeof req.query.status === "string" && ALLOWED_STATUSES.includes(req.query.status)
        ? (req.query.status as Parameters<typeof svc.listProposals>[1] extends infer F
            ? F extends { status?: infer S }
              ? S
              : never
            : never)
        : undefined;
    const proposals = await svc.listProposals(companyId, { sessionId, status });
    res.json({ proposals });
  });

  router.get(
    "/companies/:companyId/builder/proposals/:proposalId",
    async (req, res) => {
      await assertBuilderEnabled(db);
      const companyId = req.params.companyId as string;
      const proposalId = req.params.proposalId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const proposal = await svc.getProposal(companyId, proposalId);
      if (!proposal) throw notFound("Proposal not found");
      res.json({ proposal });
    },
  );

  router.post(
    "/companies/:companyId/builder/proposals/:proposalId/apply",
    validate(applyBuilderProposalSchema),
    async (req, res) => {
      await assertBuilderEnabled(db);
      const companyId = req.params.companyId as string;
      const proposalId = req.params.proposalId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const identity = actorIdentity(req);
      const proposal = await svc.applyProposal(companyId, proposalId, identity.userId);
      res.json({ proposal });
    },
  );

  router.post(
    "/companies/:companyId/builder/proposals/:proposalId/reject",
    validate(rejectBuilderProposalSchema),
    async (req, res) => {
      await assertBuilderEnabled(db);
      const companyId = req.params.companyId as string;
      const proposalId = req.params.proposalId as string;
      assertCompanyAccess(req, companyId);
      assertBoardActor(req);
      const identity = actorIdentity(req);
      const proposal = await svc.rejectProposal(companyId, proposalId, identity.userId);
      res.json({ proposal });
    },
  );

  return router;
}
