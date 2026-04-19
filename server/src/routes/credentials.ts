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
