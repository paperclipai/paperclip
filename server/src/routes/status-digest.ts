import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { statusDigestService } from "../services/status-digest.js";
import { accessService } from "../services/access.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Cheap status mode: one read-only call that answers "how is it going?" without
 * waking an agent. Requires company-scope read access; standard agent keys
 * are supported (unlike the board-only attention feed). A report can fetch
 * the whole picture with a single GET and zero board writes.
 */
export function statusDigestRoutes(db: Db) {
  const router = Router();
  const svc = statusDigestService(db);
  const access = accessService(db);

  router.get("/companies/:companyId/status-digest", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // This digest includes company-wide signals, not just visible issue counts.
    // Use the shared resolver so agent-, project-, and run-level containment apply.
    const decision = await access.decide({
      actor: req.actor,
      action: "company_scope:read",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      res.status(403).json({ error: "Status digest is outside this actor's authorization boundary" });
      return;
    }
    // Live counts: never serve a cached digest from a shared proxy.
    res.setHeader("Cache-Control", "no-store");
    res.json(await svc.digest(companyId));
  });

  return router;
}
