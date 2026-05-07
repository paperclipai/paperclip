import { Router } from "express";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { agentService, companyService, secretService } from "../services/index.js";
import { logger } from "../middleware/logger.js";

// In-memory rate limit: one demo per hashed IP per 2 hours
const ipLastDemo = new Map<string, number>();
const DEMO_COOLDOWN_MS = 2 * 60 * 60 * 1000;

function hashIp(ip: string) {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

export function demoRoutes(db: Db) {
  const router = Router();

  router.post("/demo/start", async (req, res) => {
    const { anthropicApiKey } = req.body ?? {};
    if (!anthropicApiKey || typeof anthropicApiKey !== "string" || !anthropicApiKey.startsWith("sk-")) {
      res.status(400).json({ error: "anthropicApiKey is required and must be a valid Anthropic key (starts with sk-)" });
      return;
    }

    // Rate limit by IP
    const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";
    const ipHash = hashIp(ip);
    const now = Date.now();
    const last = ipLastDemo.get(ipHash);
    if (last && now - last < DEMO_COOLDOWN_MS) {
      const retryAfterSec = Math.ceil((last + DEMO_COOLDOWN_MS - now) / 1000);
      res.status(429).json({ error: "Demo cooldown active. Try again later.", retryAfterSec });
      return;
    }

    // Validate Anthropic API key
    try {
      const check = await fetch("https://api.anthropic.com/v1/models", {
        headers: {
          "x-api-key": anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
      });
      if (check.status === 401 || check.status === 403) {
        res.status(400).json({ error: "Invalid Anthropic API key" });
        return;
      }
    } catch (err) {
      logger.warn({ err }, "Failed to validate Anthropic API key");
      res.status(400).json({ error: "Could not validate Anthropic API key — check your network" });
      return;
    }

    // Create ephemeral demo company
    const companySvc = companyService(db);
    const demoPrefix = `DM${Date.now().toString(36).slice(-4).toUpperCase()}`;
    const company = await companySvc.create({
      name: "Paperclip Demo",
      issuePrefix: demoPrefix,
      requireBoardApprovalForNewAgents: false,
    });

    // Store API key as company secret — heartbeat service auto-injects it as ANTHROPIC_API_KEY
    const secretsSvc = secretService(db);
    await secretsSvc.create(
      company.id,
      {
        name: "ANTHROPIC_API_KEY",
        provider: "local_encrypted",
        value: anthropicApiKey,
        description: "Demo user BYOT API key",
      },
      { userId: null, agentId: null },
    );

    // Create a demo CEO agent with minimal config
    const agentsSvc = agentService(db);
    const agent = await agentsSvc.create(company.id, {
      name: "Operations Lead",
      role: "ceo",
      icon: "crown",
      status: "idle",
      adapterType: "claude_local",
      adapterConfig: {
        model: "claude-haiku-4-5-20251001",
        effort: "low",
        maxTurnsPerRun: 50,
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 300,
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
    });

    // Create an agent API key for the demo user to call the API
    const apiKey = await agentsSvc.createApiKey(agent.id, "demo-session");

    // Record IP to enforce cooldown
    ipLastDemo.set(ipHash, now);

    const expiresAt = new Date(now + DEMO_COOLDOWN_MS).toISOString();

    logger.info({ companyId: company.id, agentId: agent.id, ipHash }, "Demo company provisioned");

    res.status(201).json({
      companyId: company.id,
      agentId: agent.id,
      agentApiKey: apiKey.token,
      apiUrl: `${req.protocol}://${req.get("host")}/api`,
      expiresAt,
    });
  });

  return router;
}
