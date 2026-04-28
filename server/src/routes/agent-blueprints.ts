import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  createAgentBlueprintSchema,
  updateAgentBlueprintSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertAuthenticated } from "./authz.js";
import { notFound } from "../errors.js";
import { agentBlueprintService } from "../services/agent-blueprints.js";

export function agentBlueprintRoutes(db: Db) {
  const router = Router();
  const svc = agentBlueprintService(db);

  // Read endpoints are open to both board users and agents (agents need to
  // query blueprints when the CEO is asked to hire from a template).
  router.get("/blueprints", async (req, res) => {
    assertAuthenticated(req);
    const search = typeof req.query.search === "string" ? req.query.search : undefined;
    const role = typeof req.query.role === "string" ? req.query.role : undefined;
    res.json(await svc.list({ search, role }));
  });

  router.get("/blueprints/:id", async (req, res) => {
    assertAuthenticated(req);
    const blueprint = await svc.get(req.params.id as string);
    if (!blueprint) throw notFound("Blueprint not found");
    res.json(blueprint);
  });

  router.post(
    "/blueprints",
    validate(createAgentBlueprintSchema),
    async (req, res) => {
      assertBoard(req);
      const blueprint = await svc.create(req.body);
      res.status(201).json(blueprint);
    },
  );

  router.patch(
    "/blueprints/:id",
    validate(updateAgentBlueprintSchema),
    async (req, res) => {
      assertBoard(req);
      const existing = await svc.get(req.params.id as string);
      if (!existing) throw notFound("Blueprint not found");
      const updated = await svc.update(req.params.id as string, req.body);
      res.json(updated);
    },
  );

  router.delete("/blueprints/:id", async (req, res) => {
    assertBoard(req);
    const existing = await svc.get(req.params.id as string);
    if (!existing) throw notFound("Blueprint not found");
    await svc.delete(req.params.id as string);
    res.status(204).end();
  });

  return router;
}
