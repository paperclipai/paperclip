import type { Request } from "express";
import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createProviderCredentialSchema,
  updateProviderCredentialSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";
import { accessService, credentialService, logActivity } from "../services/index.js";

export function credentialRoutes(db: Db) {
  const router = Router();
  const svc = credentialService(db);
  const access = accessService(db);

  async function requireCredentialManage(req: Request, companyId: string): Promise<void> {
    assertBoard(req);
    if (req.actor.type !== "board") throw forbidden("Board access required");
    if (req.actor.source === "local_implicit" || req.actor.isInstanceAdmin) return;
    const userId = req.actor.userId;
    if (!userId) throw forbidden("Board access required");
    const allowed = await access.canUser(companyId, userId, "credentials:manage");
    if (!allowed) throw forbidden("Missing permission: credentials:manage");
  }

  // List credentials for a company (credential values are NOT returned)
  router.get("/companies/:companyId/credentials", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const rows = await svc.list(companyId);
    res.json(rows);
  });

  // Create a credential
  router.post(
    "/companies/:companyId/credentials",
    validate(createProviderCredentialSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      await requireCredentialManage(req, companyId);

      if (req.query.skipTest !== "true") {
        const probe = await probeCredential(req.body.type, req.body.credential);
        if (!probe.ok) {
          res.status(400).json({ error: `Credential test failed: ${probe.message}` });
          return;
        }
      }

      const created = await svc.create(companyId, {
        name: req.body.name,
        type: req.body.type,
        credential: req.body.credential,
        isDefault: req.body.isDefault,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.type === "board" ? req.actor.userId ?? "board" : "board",
        action: "credential.created",
        entityType: "credential",
        entityId: created.id,
        details: { name: created.name, type: created.type },
      });

      res.status(201).json(created);
    },
  );

  // Update a credential
  router.patch(
    "/credentials/:id",
    validate(updateProviderCredentialSchema),
    async (req, res) => {
      const id = req.params.id as string;
      const existing = await svc.getById(id);
      if (!existing) {
        res.status(404).json({ error: "Credential not found" });
        return;
      }
      assertCompanyAccess(req, existing.companyId);
      await requireCredentialManage(req, existing.companyId);

      if (req.body.credential !== undefined && req.query.skipTest !== "true") {
        const probe = await probeCredential(existing.type, req.body.credential);
        if (!probe.ok) {
          res.status(400).json({ error: `Credential test failed: ${probe.message}` });
          return;
        }
      }

      const updated = await svc.update(id, {
        name: req.body.name,
        credential: req.body.credential,
        isDefault: req.body.isDefault,
      });

      if (!updated) {
        res.status(404).json({ error: "Credential not found" });
        return;
      }

      await logActivity(db, {
        companyId: updated.companyId,
        actorType: "user",
        actorId: req.actor.type === "board" ? req.actor.userId ?? "board" : "board",
        action: "credential.updated",
        entityType: "credential",
        entityId: updated.id,
        details: { name: updated.name },
      });

      res.json(updated);
    },
  );

  // Delete a credential
  router.delete("/credentials/:id", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    await requireCredentialManage(req, existing.companyId);

    const force = req.query.force === "true";
    const result = await svc.remove(id, force);
    if (result && "error" in result) {
      res.status(409).json({
        error: "Credential is in use by one or more agents. Delete with ?force=true to remove anyway.",
      });
      return;
    }
    if (!result) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.type === "board" ? req.actor.userId ?? "board" : "board",
      action: "credential.deleted",
      entityType: "credential",
      entityId: existing.id,
      details: { name: existing.name },
    });

    res.json({ ok: true });
  });

  // ── Test credential (probe provider API) ─────────────────────────────

  router.post("/credentials/:id/test", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    await requireCredentialManage(req, existing.companyId);
    const payload = await svc.getDecryptedPayload(id);
    if (!payload) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }
    const result = await probeCredential(existing.type, payload);
    res.json(result);
  });

  // ── Reveal credential value (audit-logged, rate-limited) ──────────────

  // In-memory sliding-window rate limit: max 10 reveals per minute per user
  const revealTimestamps = new Map<string, number[]>();

  router.get("/credentials/:id/reveal", async (req, res) => {
    const id = req.params.id as string;
    const existing = await svc.getById(id);
    if (!existing) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }
    assertCompanyAccess(req, existing.companyId);
    await requireCredentialManage(req, existing.companyId);

    const rateLimitKey =
      req.actor.type === "board" ? req.actor.userId ?? "board" : "board";
    const now = Date.now();
    const windowMs = 60_000;
    const maxReveals = 10;
    const timestamps = revealTimestamps.get(rateLimitKey) ?? [];
    const recent = timestamps.filter((t) => now - t < windowMs);
    if (recent.length >= maxReveals) {
      res.status(429).json({ error: "Too many credential reveals. Try again later." });
      return;
    }
    recent.push(now);
    revealTimestamps.set(rateLimitKey, recent);

    const decrypted = await svc.getDecryptedPayload(id);
    if (!decrypted) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: rateLimitKey,
      action: "credential.revealed",
      entityType: "credential",
      entityId: id,
      details: { name: existing.name, type: existing.type },
    });

    res.json({ credential: decrypted });
  });

  return router;
}

type ProbeResult = { ok: boolean; message: string };

async function probeCredential(type: string, payload: Record<string, unknown>): Promise<ProbeResult> {
  try {
    switch (type) {
      case "claude_oauth": {
        const accessToken = typeof payload.accessToken === "string" ? payload.accessToken : "";
        if (!accessToken) return { ok: false, message: "Missing accessToken in stored credential" };
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
            Authorization: `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
        });
        if (res.ok) {
          const refreshToken = typeof payload.refreshToken === "string" ? payload.refreshToken : "";
          const expiresAt = typeof payload.expiresAt === "number" ? payload.expiresAt : 0;
          const expiresSoon = expiresAt > 0 && expiresAt - Date.now() < 24 * 3600 * 1000;
          const warnings: string[] = [];
          if (!refreshToken) warnings.push("no refreshToken (will break when access token expires)");
          if (expiresSoon) warnings.push(`access token expires ${new Date(expiresAt).toISOString()}`);
          return {
            ok: true,
            message: warnings.length > 0 ? `OAuth token valid. Warning: ${warnings.join("; ")}` : "OAuth token valid",
          };
        }
        const body = await res.text().catch(() => "");
        return { ok: false, message: `Anthropic API returned ${res.status}: ${body.slice(0, 200)}` };
      }
      case "claude_api_key": {
        const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
        if (!apiKey) return { ok: false, message: "Missing apiKey in stored credential" };
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "anthropic-version": "2023-06-01",
            "x-api-key": apiKey,
          },
          body: JSON.stringify({
            model: "claude-haiku-4-5",
            max_tokens: 1,
            messages: [{ role: "user", content: "hi" }],
          }),
        });
        if (res.ok) return { ok: true, message: "API key valid" };
        const body = await res.text().catch(() => "");
        return { ok: false, message: `Anthropic API returned ${res.status}: ${body.slice(0, 200)}` };
      }
      case "openai_api_key": {
        const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
        if (!apiKey) return { ok: false, message: "Missing apiKey in stored credential" };
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (res.ok) return { ok: true, message: "API key valid" };
        return { ok: false, message: `OpenAI API returned ${res.status}` };
      }
      case "openrouter_api_key": {
        const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
        if (!apiKey) return { ok: false, message: "Missing apiKey in stored credential" };
        const res = await fetch("https://openrouter.ai/api/v1/auth/key", {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (res.ok) return { ok: true, message: "API key valid" };
        return { ok: false, message: `OpenRouter API returned ${res.status}` };
      }
      case "gemini_api_key": {
        const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
        if (!apiKey) return { ok: false, message: "Missing apiKey in stored credential" };
        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
        );
        if (res.ok) return { ok: true, message: "API key valid" };
        return { ok: false, message: `Gemini API returned ${res.status}` };
      }
      default:
        return { ok: false, message: `Unknown credential type: ${type}` };
    }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
