import { Router } from "express";
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

export function providerAuthRoutes() {
  const router = Router();

  function requireAdmin(req: Parameters<import("express").RequestHandler>[0]) {
    if (req.actor.type !== "board" || !req.actor.isInstanceAdmin) {
      throw forbidden("Instance admin required");
    }
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
    res.json(await startAnthropicAuth());
  });

  // POST /provider-auth/anthropic/submit — Submit OAuth callback code
  router.post("/provider-auth/anthropic/submit", async (req, res) => {
    requireAdmin(req);
    const code = (req.body?.code as string)?.trim();
    if (!code) throw badRequest("code is required");
    res.json(await submitAnthropicAuthCode(code));
  });

  // POST /provider-auth/anthropic/cancel — Cancel ongoing OAuth flow
  router.post("/provider-auth/anthropic/cancel", async (req, res) => {
    requireAdmin(req);
    res.json(await cancelAnthropicAuth());
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
    res.json(await startOpenAiAuth());
  });

  // POST /provider-auth/openai/cancel — Cancel device auth
  router.post("/provider-auth/openai/cancel", async (req, res) => {
    requireAdmin(req);
    res.json(await cancelOpenAiAuth());
  });

  return router;
}
