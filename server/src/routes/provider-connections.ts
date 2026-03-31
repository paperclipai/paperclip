import { Router } from "express";
import type { Db } from "@paperclipai/db";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { badRequest } from "../errors.js";
import { logActivity, secretService } from "../services/index.js";

type ProviderName = "openai" | "anthropic";

type ValidationResult = {
  ok: boolean;
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function asProviderName(value: unknown): ProviderName | null {
  if (value === "openai" || value === "anthropic") return value;
  return null;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  return fallback;
}

async function validateOpenAiKey(apiKey: string): Promise<ValidationResult> {
  if (!apiKey.startsWith("sk-")) {
    return { ok: false, message: "OpenAI API key must begin with sk-" };
  }
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
    });
    if (response.ok) {
      return { ok: true, message: "OpenAI API key validated successfully." };
    }
    return {
      ok: false,
      message: `OpenAI rejected the key (status ${response.status}).`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `OpenAI validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function validateAnthropicKey(apiKey: string): Promise<ValidationResult> {
  if (!apiKey.startsWith("sk-ant-")) {
    return { ok: false, message: "Anthropic API key must begin with sk-ant-" };
  }
  try {
    const response = await fetch("https://api.anthropic.com/v1/models", {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    });
    if (response.ok) {
      return { ok: true, message: "Anthropic API key validated successfully." };
    }
    return {
      ok: false,
      message: `Anthropic rejected the key (status ${response.status}).`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Anthropic validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function providerSecretName(provider: ProviderName): "OPENAI_API_KEY" | "ANTHROPIC_API_KEY" {
  return provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
}

async function validateProviderKey(provider: ProviderName, apiKey: string): Promise<ValidationResult> {
  if (provider === "openai") return validateOpenAiKey(apiKey);
  return validateAnthropicKey(apiKey);
}

export function providerConnectionRoutes(db: Db) {
  const router = Router();
  const secrets = secretService(db);

  router.get("/companies/:companyId/provider-connections", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const openai = await secrets.getByName(companyId, "OPENAI_API_KEY");
    const anthropic = await secrets.getByName(companyId, "ANTHROPIC_API_KEY");

    res.json({
      openai: {
        connected: Boolean(openai),
        secretId: openai?.id ?? null,
        latestVersion: openai?.latestVersion ?? null,
        updatedAt: openai?.updatedAt ?? null,
      },
      anthropic: {
        connected: Boolean(anthropic),
        secretId: anthropic?.id ?? null,
        latestVersion: anthropic?.latestVersion ?? null,
        updatedAt: anthropic?.updatedAt ?? null,
      },
    });
  });

  router.post("/companies/:companyId/provider-connections", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    if (!isRecord(req.body)) throw badRequest("Request body must be an object");
    const provider = asProviderName(req.body.provider);
    const apiKey = asNonEmptyString(req.body.apiKey);
    const validateOnly = asBoolean(req.body.validateOnly, false);
    if (!provider) throw badRequest("provider must be one of: openai, anthropic");
    if (!apiKey) throw badRequest("apiKey is required");

    const validation = await validateProviderKey(provider, apiKey);
    if (!validation.ok) {
      res.status(422).json({
        error: validation.message,
        ok: false,
        provider,
        message: validation.message,
      });
      return;
    }

    if (validateOnly) {
      res.json({
        ok: true,
        provider,
        stored: false,
        message: validation.message,
      });
      return;
    }

    const secretName = providerSecretName(provider);
    const existing = await secrets.getByName(companyId, secretName);
    const actor = { userId: req.actor.userId ?? "board", agentId: null };

    const stored = existing
      ? await secrets.rotate(existing.id, { value: apiKey }, actor)
      : await secrets.create(
        companyId,
        {
          name: secretName,
          provider: "local_encrypted",
          value: apiKey,
          description: `${provider} BYOK key`,
        },
        actor,
      );

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "provider.connected",
      entityType: "secret",
      entityId: stored.id,
      details: {
        provider,
        mode: existing ? "rotated" : "created",
      },
    });

    res.json({
      ok: true,
      provider,
      stored: true,
      mode: existing ? "rotated" : "created",
      secretId: stored.id,
      latestVersion: stored.latestVersion,
      message: validation.message,
    });
  });

  return router;
}
