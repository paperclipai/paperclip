import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createProviderCredentialSchema,
  updateProviderCredentialSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { forbidden } from "../errors.js";
import { accessService, logActivity } from "../services/index.js";
import { credentialService } from "../services/credentials.js";
import {
  startClaudeLoginSession,
  getClaudeLoginSession,
  cancelClaudeLoginSession,
  submitAuthCode,
} from "../services/claude-login-sessions.js";

export function credentialRoutes(db: Db) {
  const router = Router();
  const svc = credentialService(db);
  const access = accessService(db);

  // List credentials for a company (credential values are NOT returned)
  router.get("/companies/:companyId/credentials", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const credentials = await svc.list(companyId);
    res.json(credentials);
  });

  // Create a credential
  router.post(
    "/companies/:companyId/credentials",
    validate(createProviderCredentialSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      if (req.actor.type === "board") {
        if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
          const allowed = await access.canUser(companyId, req.actor.userId, "credentials:manage");
          if (!allowed) throw forbidden("Missing permission: credentials:manage");
        }
      } else {
        throw forbidden("Board access required");
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
        actorId: req.actor.userId ?? "board",
        action: "credential.created",
        entityType: "credential",
        entityId: created.id,
        details: { name: created.name, type: created.type },
      });

      // Return without credential field
      const { credential: _, ...safe } = created;
      res.status(201).json(safe);
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
      if (req.actor.type === "board") {
        if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
          const allowed = await access.canUser(existing.companyId, req.actor.userId, "credentials:manage");
          if (!allowed) throw forbidden("Missing permission: credentials:manage");
        }
      } else {
        throw forbidden("Board access required");
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
        actorId: req.actor.userId ?? "board",
        action: "credential.updated",
        entityType: "credential",
        entityId: updated.id,
        details: { name: updated.name },
      });

      const { credential: _, ...safe } = updated;
      res.json(safe);
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
    if (req.actor.type === "board") {
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        const allowed = await access.canUser(existing.companyId, req.actor.userId, "credentials:manage");
        if (!allowed) throw forbidden("Missing permission: credentials:manage");
      }
    } else {
      throw forbidden("Board access required");
    }

    const force = req.query.force === "true";
    const result = await svc.remove(id, force);
    if (result && "error" in result) {
      res.status(409).json({ error: "Credential is in use by one or more agents. Delete with ?force=true to remove anyway." });
      return;
    }
    if (!result) {
      res.status(404).json({ error: "Credential not found" });
      return;
    }

    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "credential.deleted",
      entityType: "credential",
      entityId: existing.id,
      details: { name: existing.name },
    });

    res.json({ ok: true });
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

    // Only board users may reveal credentials
    if (req.actor.type === "board") {
      if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
        const allowed = await access.canUser(existing.companyId, req.actor.userId, "credentials:manage");
        if (!allowed) throw forbidden("Missing permission: credentials:manage");
      }
    } else {
      throw forbidden("Board access required");
    }

    // Rate limit: 10 reveals per minute per user
    const rateLimitKey = req.actor.userId ?? "board";
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

    // getById already returns all columns including `credential`
    const full = existing;

    // Audit log
    await logActivity(db, {
      companyId: existing.companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "credential.revealed",
      entityType: "credential",
      entityId: id,
      details: { name: existing.name, type: existing.type },
    });

    res.json({ credential: full.credential });
  });

  // ── Claude OAuth login flow ────────────────────────────────────────────

  // Start a Claude login session (runs `claude login` server-side)
  router.post("/companies/:companyId/credentials/claude-login", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    if (req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
      const allowed = await access.canUser(companyId, req.actor.userId, "credentials:manage");
      if (!allowed) throw forbidden("Missing permission: credentials:manage");
    }

    const name = typeof req.body?.name === "string" ? req.body.name.trim() : undefined;
    const isDefault = typeof req.body?.isDefault === "boolean" ? req.body.isDefault : undefined;

    try {
      const session = await startClaudeLoginSession(db, {
        companyId,
        userId: req.actor.userId ?? "board",
        credentialName: name,
        isDefault,
      });

      res.status(202).json({
        loginSessionId: session.id,
        loginUrl: session.loginUrl,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start login session";
      res.status(429).json({ error: message });
    }
  });

  // Poll login session status
  router.get("/companies/:companyId/credentials/claude-login/:sessionId/status", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const session = getClaudeLoginSession(req.params.sessionId as string);
    if (!session || session.companyId !== companyId) {
      res.status(404).json({ error: "Login session not found" });
      return;
    }

    res.json({
      status: session.status,
      loginUrl: session.loginUrl,
      credentialId: session.credentialId,
      error: session.error,
    });
  });

  // Submit auth code to a pending login session
  router.post("/companies/:companyId/credentials/claude-login/:sessionId/code", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    const code = typeof req.body?.code === "string" ? req.body.code.trim() : "";
    if (!code) {
      res.status(400).json({ error: "Missing auth code" });
      return;
    }

    const ok = submitAuthCode(req.params.sessionId as string, code);
    if (!ok) {
      res.status(400).json({ error: "Session not waiting for code or already completed" });
      return;
    }

    res.json({ ok: true });
  });

  // Cancel a login session
  router.delete("/companies/:companyId/credentials/claude-login/:sessionId", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoard(req);
    assertCompanyAccess(req, companyId);

    cancelClaudeLoginSession(req.params.sessionId as string);
    res.json({ ok: true });
  });

  return router;
}
