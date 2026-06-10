import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { mergerGateService, workProductService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";

export function workProductRoutes(db: Db) {
  const router = Router();
  const workProductsSvc = workProductService(db);
  const mergerGatesSvc = mergerGateService(db);

  router.get("/work-products/:id/merge-gates", async (req, res) => {
    const id = req.params.id as string;
    const workProduct = await workProductsSvc.getById(id);
    if (!workProduct) {
      res.status(404).json({ error: "Work product not found" });
      return;
    }
    assertCompanyAccess(req, workProduct.companyId);

    const result = await mergerGatesSvc.evaluateGates(id);
    res.json(result);
  });

  return router;
}
