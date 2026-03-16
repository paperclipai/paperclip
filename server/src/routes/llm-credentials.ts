import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { validate } from "../middleware/validate.js";
import { llmProvidersService } from "../services/llm-providers.js";
import { z } from "zod";

const createCredentialSchema = z.object({
  providerType: z.enum(["openrouter", "anthropic", "openai", "huggingface", "ollama", "custom"]),
  apiKey: z.string().min(1),
  baseUrl: z.string().url().optional(),
});

const validateCredentialSchema = z.object({
  providerType: z.enum(["openrouter", "anthropic", "openai", "huggingface", "ollama", "custom"]),
  apiKey: z.string().min(1),
  baseUrl: z.string().optional(),
});

export function llmCredentialsRoutes(db: Db) {
  const router = Router();
  const llmService = llmProvidersService(db);

  // GET /api/users/me/llm-credentials
  router.get("/", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const credentials = await llmService.listUserCredentials(req.actor.userId);

      // Redact encrypted payload
      res.json(
        credentials.map((c) => ({
          id: c.id,
          providerType: c.providerType,
          keyFingerprint: c.keyFingerprint,
          baseUrl: c.baseUrl,
          isActive: c.isActive,
          testedAt: c.testedAt,
          testError: c.testError,
          createdAt: c.createdAt,
        })),
      );
    } catch (error) {
      res.status(500).json({ error: "Failed to list credentials" });
    }
  });

  // POST /api/users/me/llm-credentials
  router.post("/", validate(createCredentialSchema), async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      // First validate the credential
      const validation = await llmService.validateCredential(
        req.body.providerType,
        req.body.apiKey,
        req.body.baseUrl,
      );

      if (!validation.valid) {
        return res.status(400).json({
          error: "Invalid credential",
          details: validation.error,
        });
      }

      const credential = await llmService.createUserCredential(
        req.actor.userId,
        req.body.providerType,
        req.body.apiKey,
        req.body.baseUrl,
      );

      res.status(201).json({
        id: credential.id,
        providerType: credential.providerType,
        keyFingerprint: credential.keyFingerprint,
        baseUrl: credential.baseUrl,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes("already exists")) {
        return res.status(409).json({ error: error.message });
      }
      res.status(400).json({ error: error instanceof Error ? error.message : "Failed to create credential" });
    }
  });

  // DELETE /api/users/me/llm-credentials/:id
  router.delete("/:id", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      await llmService.deleteUserCredential(req.params.id, req.actor.userId);
      res.json({ success: true });
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: "Failed to delete credential" });
    }
  });

  // POST /api/users/me/llm-credentials/validate
  router.post("/validate", validate(validateCredentialSchema), async (req, res) => {
    try {
      const result = await llmService.validateCredential(
        req.body.providerType,
        req.body.apiKey,
        req.body.baseUrl,
      );

      res.json(result);
    } catch (error) {
      res.status(500).json({
        valid: false,
        modelCount: 0,
        error: error instanceof Error ? error.message : "Validation failed",
      });
    }
  });

  // POST /api/users/me/llm-credentials/:id/test
  router.post("/:id/test", async (req, res) => {
    if (req.actor.type !== "board" || !req.actor.userId) {
      return res.status(401).json({ error: "Authentication required" });
    }

    try {
      const result = await llmService.testCredential(req.params.id, req.actor.userId);
      res.json(result);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        return res.status(404).json({ error: error.message });
      }
      res.status(500).json({ error: "Test failed" });
    }
  });

  return router;
}
