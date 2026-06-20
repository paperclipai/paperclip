import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { ceoControlRoomService } from "../services/ceo-control-room.js";
import { assertCompanyAccess } from "./authz.js";

export function ceoControlRoomRoutes(db: Db) {
  const router = Router();
  const svc = ceoControlRoomService(db);

  router.get("/companies/:companyId/ceo-control-room", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const status = await svc.status(companyId);
    res.json(status);
  });

  return router;
}
