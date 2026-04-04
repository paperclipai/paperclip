import { Router } from "express";
import { assertBoard } from "./authz.js";
import { getBuiltInTemplate, listBuiltInTemplates } from "../templates/registry.js";
import type { TemplateRegistryOptions } from "../templates/types.js";

export function templateRoutes(opts?: TemplateRegistryOptions) {
  const router = Router();

  router.get("/", async (req, res, next) => {
    try {
      assertBoard(req);
      const templates = await listBuiltInTemplates(opts);
      res.json(templates);
    } catch (err) {
      next(err);
    }
  });

  router.get("/:templateId", async (req, res, next) => {
    try {
      assertBoard(req);
      const template = await getBuiltInTemplate(req.params.templateId as string, opts);
      res.json(template);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
