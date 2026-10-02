import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { statusDigestService } from "../services/status-digest.js";
import { assertCompanyAccess } from "./authz.js";

/**
 * Cheap status mode: one read-only call that answers "how is it going?" without
 * waking an agent. Readable with an agent key (unlike the board-only attention
 * feed), so a report or verification run can fetch the whole picture with a
 * single GET and zero board writes.
 */
export function statusDigestRoutes(db: Db) {
  const router = Router();
  const svc = statusDigestService(db);

  router.get("/companies/:companyId/status-digest", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    // Live counts: never serve a cached digest from a shared proxy.
    res.setHeader("Cache-Control", "no-store");
    res.json(await svc.digest(companyId));
  });

  return router;
}
