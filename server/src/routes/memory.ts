import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { memoryService } from "../services/index.js";
import { assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";

export function memoryRoutes(db: Db) {
  const router = Router();
  const memory = memoryService(db);

  // List bindings
  router.get("/companies/:companyId/memory/bindings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const bindings = await memory.getBindings(companyId);
    res.json(bindings);
  });

  // Create binding
  router.post("/companies/:companyId/memory/bindings", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { key, providerType, config } = req.body;
    if (!key || typeof key !== "string") throw badRequest("'key' is required");
    if (!providerType || typeof providerType !== "string") throw badRequest("'providerType' is required");

    const binding = await memory.createBinding(companyId, key, providerType, config ?? {});
    res.status(201).json(binding);
  });

  // Write memory
  router.post("/companies/:companyId/memory/write", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { bindingKey, scope, source, content, metadata, mode } = req.body;
    if (!bindingKey || typeof bindingKey !== "string") throw badRequest("'bindingKey' is required");
    if (!scope || !scope.companyId) throw badRequest("'scope' with companyId is required");
    if (!source || !source.kind) throw badRequest("'source' with kind is required");
    if (!content || typeof content !== "string") throw badRequest("'content' is required");

    const entry = await memory.write(companyId, bindingKey, {
      scope,
      source,
      content,
      metadata,
      mode,
    });
    res.status(201).json(entry);
  });

  // Query memories
  router.post("/companies/:companyId/memory/query", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const { bindingKey, scope, query, topK } = req.body;
    if (!bindingKey || typeof bindingKey !== "string") throw badRequest("'bindingKey' is required");
    if (!scope || !scope.companyId) throw badRequest("'scope' with companyId is required");
    if (!query || typeof query !== "string") throw badRequest("'query' is required");

    const result = await memory.query(companyId, bindingKey, {
      scope,
      query,
      topK,
    });
    res.json(result);
  });

  // Delete (forget) a memory entry
  router.delete("/companies/:companyId/memory/entries/:entryId", async (req, res) => {
    const companyId = req.params.companyId as string;
    const entryId = req.params.entryId as string;
    assertCompanyAccess(req, companyId);

    const result = await memory.forget(companyId, entryId);
    res.json(result);
  });

  // Audit log of operations
  router.get("/companies/:companyId/memory/operations", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const limitRaw = req.query.limit as string | undefined;
    let limit = 100;
    if (limitRaw) {
      limit = Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(limit) || limit <= 0 || limit > 500) {
        throw badRequest("invalid 'limit' value");
      }
    }

    const operations = await memory.getOperations(companyId, limit);
    res.json(operations);
  });

  return router;
}
