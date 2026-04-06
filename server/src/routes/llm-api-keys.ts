import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { llmApiKeyService } from "../services/llm-api-keys.js";
import { validate } from "../middleware/validate.js";
import { assertCompanyAccess, assertBoard } from "./authz.js";

const createKeySchema = z.object({
  name: z.string().min(1).max(100),
  provider: z.string().min(1).max(50).default("anthropic"),
  apiKey: z.string().min(1),
  modelFilter: z.string().max(200).nullable().optional(),
  isDefault: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  monthlyBudgetUsd: z.number().min(0).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const updateKeySchema = z.object({
  name: z.string().min(1).max(100).optional(),
  provider: z.string().min(1).max(50).optional(),
  apiKey: z.string().min(1).optional(),
  modelFilter: z.string().max(200).nullable().optional(),
  isDefault: z.boolean().optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().min(0).max(100).optional(),
  monthlyBudgetUsd: z.number().min(0).nullable().optional(),
  notes: z.string().max(500).nullable().optional(),
});

const assignKeySchema = z.object({
  llmApiKeyId: z.string().uuid(),
  assignedBy: z.string().max(100).optional(),
});

export function llmApiKeyRoutes(db: Db) {
  const router = Router();
  const svc = llmApiKeyService(db);

  // === Company-scoped key management ===

  // List all API keys for a company
  router.get(
    "/companies/:companyId/llm-api-keys",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const keys = await svc.list(companyId);
      res.json(keys);
    },
  );

  // Create a new API key
  router.post(
    "/companies/:companyId/llm-api-keys",
    validate(createKeySchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const key = await svc.create({
        companyId,
        ...req.body,
      });
      res.status(201).json(key);
    },
  );

  // Get a single key
  router.get(
    "/companies/:companyId/llm-api-keys/:keyId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const keyId = req.params.keyId as string;
      assertCompanyAccess(req, companyId);
      const key = await svc.getById(companyId, keyId);
      if (!key) {
        res.status(404).json({ error: "API key not found" });
        return;
      }
      res.json(key);
    },
  );

  // Update a key
  router.patch(
    "/companies/:companyId/llm-api-keys/:keyId",
    validate(updateKeySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const keyId = req.params.keyId as string;
      assertCompanyAccess(req, companyId);
      const key = await svc.update(companyId, keyId, req.body);
      if (!key) {
        res.status(404).json({ error: "API key not found" });
        return;
      }
      res.json(key);
    },
  );

  // Delete a key
  router.delete(
    "/companies/:companyId/llm-api-keys/:keyId",
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      const keyId = req.params.keyId as string;
      assertCompanyAccess(req, companyId);
      const deleted = await svc.delete(companyId, keyId);
      if (!deleted) {
        res.status(404).json({ error: "API key not found" });
        return;
      }
      res.json({ ok: true });
    },
  );

  // === Agent key assignments ===

  // List key assignments for an agent
  router.get(
    "/companies/:companyId/agents/:agentId/llm-keys",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      const assignments = await svc.listAgentAssignments(companyId, agentId);
      res.json(assignments);
    },
  );

  // Assign a key to an agent
  router.post(
    "/companies/:companyId/agents/:agentId/llm-keys",
    validate(assignKeySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      const assignment = await svc.assignKeyToAgent({
        companyId,
        agentId,
        ...req.body,
      });
      res.status(201).json(assignment);
    },
  );

  // Set a single key for an agent (replaces all)
  router.put(
    "/companies/:companyId/agents/:agentId/llm-keys",
    validate(assignKeySchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      await svc.setAgentKey(
        companyId,
        agentId,
        req.body.llmApiKeyId,
        req.body.assignedBy ?? "manual",
      );
      res.json({ ok: true });
    },
  );

  // Remove a key assignment from an agent
  router.delete(
    "/companies/:companyId/agents/:agentId/llm-keys/:keyId",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      const keyId = req.params.keyId as string;
      assertCompanyAccess(req, companyId);
      const removed = await svc.removeAgentAssignment(companyId, agentId, keyId);
      if (!removed) {
        res.status(404).json({ error: "Assignment not found" });
        return;
      }
      res.json({ ok: true });
    },
  );

  // === Resolve key for an agent (internal use) ===
  router.get(
    "/companies/:companyId/agents/:agentId/resolve-llm-key",
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const agentId = req.params.agentId as string;
      assertCompanyAccess(req, companyId);
      const provider = (req.query.provider as string) || "anthropic";
      const apiKey = await svc.resolveKeyForAgent(companyId, agentId, provider);
      // Never return the actual key to the frontend — just confirm availability
      res.json({ available: apiKey !== null, provider });
    },
  );

  return router;
}
