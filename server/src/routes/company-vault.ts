import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { companyVaultService } from "../services/company-vault.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";

export function companyVaultRoutes(db: Db) {
  const router = Router();
  const vault = companyVaultService(db);

  /** List all vault entries for a company (masked — no raw secret values) */
  router.get("/companies/:companyId/vault", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const entries = await vault.list(companyId);
    // Strip raw secret values — only return masked previews
    const safe = entries.map(({ secretValue, ...rest }) => rest);
    res.json(safe);
  });

  /** Search vault entries by label or category (agents can use this to find credentials) */
  router.get("/companies/:companyId/vault/search", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const label = req.query.label as string | undefined;
    const category = req.query.category as string | undefined;
    if (!label && !category) {
      res.status(400).json({ error: "Provide at least one of: label, category" });
      return;
    }

    const entries = await vault.findByLabelOrCategory(companyId, { label, category });
    // Return full secrets for agents — they need them to configure tools
    res.json(entries);
  });

  /** Get a single vault entry — reveal secret (board only) */
  router.get("/companies/:companyId/vault/:entryId/reveal", async (req, res) => {
    const companyId = req.params.companyId as string;
    const entryId = req.params.entryId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const entry = await vault.getById(companyId, entryId);
    res.json(entry);
  });

  /** Add a secret manually */
  router.post("/companies/:companyId/vault", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    const { label, category, secretValue } = req.body;
    if (!label || !secretValue) {
      res.status(400).json({ error: "label and secretValue are required" });
      return;
    }

    const entry = await vault.addManual(companyId, {
      label,
      category: category ?? "other",
      secretValue,
      addedBy: req.actor.userId ?? undefined,
    });
    // Don't return the raw secret in the response
    const { secretValue: _, ...safe } = entry;
    res.status(201).json(safe);
  });

  /** Delete a vault entry */
  router.delete("/companies/:companyId/vault/:entryId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const entryId = req.params.entryId as string;
    assertCompanyAccess(req, companyId);
    assertBoard(req);

    await vault.remove(companyId, entryId);
    res.json({ ok: true });
  });

  return router;
}
