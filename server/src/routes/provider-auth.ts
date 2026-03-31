import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { forbidden, badRequest } from "../errors.js";
import {
  getProviderStatus,
  getAnthropicAuthState,
  startAnthropicAuth,
  submitAnthropicAuthCode,
  cancelAnthropicAuth,
  getOpenAiAuthState,
  startOpenAiAuth,
  cancelOpenAiAuth,
} from "../services/provider-auth.js";
import { instanceSettingsService, logActivity } from "../services/index.js";
import { getActorInfo } from "./authz.js";

export function providerAuthRoutes(db: Db) {
  const router = Router();
  const settings = instanceSettingsService(db);

  function requireAdmin(req: Parameters<import("express").RequestHandler>[0]) {
    if (req.actor.type !== "board" || !req.actor.isInstanceAdmin) {
      throw forbidden("Instance admin required");
    }
  }

  async function logProviderMutation(
    req: Parameters<import("express").RequestHandler>[0],
    action: string,
    details: Record<string, unknown>,
  ) {
    const companyIds = await settings.listCompanyIds();
    if (companyIds.length === 0) return;

    const actor = getActorInfo(req);
    await Promise.all(
      companyIds.map((companyId) =>
        logActivity(db, {
          companyId,
          actorType: actor.actorType,
          actorId: actor.actorId,
          agentId: actor.agentId,
          runId: actor.runId,
          action,
          entityType: "instance_settings",
          entityId: "default",
          details,
        }),
      ),
    );
  }

  // GET /provider-auth/status — Combined status for both providers
  router.get("/provider-auth/status", async (req, res) => {
    requireAdmin(req);
    const status = await getProviderStatus();
    res.json(status);
  });

  // ── Anthropic (Claude Code) ─────────────────────────────────────────────

  // GET /provider-auth/anthropic — Get current auth state
  router.get("/provider-auth/anthropic", async (req, res) => {
    requireAdmin(req);
    res.json(await getAnthropicAuthState());
  });

  // POST /provider-auth/anthropic/start — Start OAuth PKCE flow
  router.post("/provider-auth/anthropic/start", async (req, res) => {
    requireAdmin(req);
    const result = await startAnthropicAuth();
    await logProviderMutation(req, "instance.provider_auth.anthropic_started", {
      provider: "anthropic",
      status: result.status,
    });
    res.json(result);
  });

  // POST /provider-auth/anthropic/submit — Submit OAuth callback code
  router.post("/provider-auth/anthropic/submit", async (req, res) => {
    requireAdmin(req);
    const code = (req.body?.code as string)?.trim();
    if (!code) throw badRequest("code is required");
    const result = await submitAnthropicAuthCode(code);
    await logProviderMutation(req, "instance.provider_auth.anthropic_submitted", {
      provider: "anthropic",
      status: result.status,
      authDetected: result.authDetected,
    });
    res.json(result);
  });

  // POST /provider-auth/anthropic/cancel — Cancel ongoing OAuth flow
  router.post("/provider-auth/anthropic/cancel", async (req, res) => {
    requireAdmin(req);
    const result = await cancelAnthropicAuth();
    await logProviderMutation(req, "instance.provider_auth.anthropic_canceled", {
      provider: "anthropic",
      status: result.status,
    });
    res.json(result);
  });

  // ── OpenAI (Codex) ─────────────────────────────────────────────────────

  // GET /provider-auth/openai — Get current device auth state
  router.get("/provider-auth/openai", async (req, res) => {
    requireAdmin(req);
    res.json(await getOpenAiAuthState());
  });

  // POST /provider-auth/openai/start — Start device code flow
  router.post("/provider-auth/openai/start", async (req, res) => {
    requireAdmin(req);
    const result = await startOpenAiAuth();
    await logProviderMutation(req, "instance.provider_auth.openai_started", {
      provider: "openai",
      status: result.status,
    });
    res.json(result);
  });

  // POST /provider-auth/openai/cancel — Cancel device auth
  router.post("/provider-auth/openai/cancel", async (req, res) => {
    requireAdmin(req);
    const result = await cancelOpenAiAuth();
    await logProviderMutation(req, "instance.provider_auth.openai_canceled", {
      provider: "openai",
      status: result.status,
    });
    res.json(result);
  });

  return router;
}
