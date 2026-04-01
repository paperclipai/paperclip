import { Router } from "express";
import type { Db } from "@paperclipai/db";
import {
  KNOWN_PROVIDER_CREDENTIAL_PROVIDERS,
  adapterAuthStatusRequestSchema,
  createProviderCredentialSchema,
  providerConnectionLegacySchema,
  rotateProviderCredentialSchema,
  updateProviderCredentialSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { assertBoard, assertCompanyAccess } from "./authz.js";
import { adapterAuthService, logActivity, providerCredentialService, secretService } from "../services/index.js";

type ValidationResult = {
  ok: boolean;
  message: string;
};

function asCanonicalProvider(provider: string): string {
  return provider.trim().toLowerCase();
}

function defaultEnvKeyForProvider(provider: string): string {
  const canonical = asCanonicalProvider(provider);
  if (canonical === "openai") return "OPENAI_API_KEY";
  if (canonical === "anthropic") return "ANTHROPIC_API_KEY";
  if (canonical === "gemini") return "GEMINI_API_KEY";
  if (canonical === "google") return "GOOGLE_API_KEY";
  if (canonical === "cursor") return "CURSOR_API_KEY";
  const normalized = canonical
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `${normalized || "PROVIDER"}_API_KEY`;
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

async function validateGeminiOrGoogleKey(apiKey: string): Promise<ValidationResult> {
  if (apiKey.trim().length < 16) {
    return {
      ok: false,
      message: "Gemini/Google API key appears too short.",
    };
  }
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
      { method: "GET" },
    );
    if (response.ok) {
      return { ok: true, message: "Gemini/Google API key validated successfully." };
    }
    return {
      ok: false,
      message: `Gemini/Google rejected the key (status ${response.status}).`,
    };
  } catch (error) {
    return {
      ok: false,
      message: `Gemini/Google validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function validateCursorKey(apiKey: string): ValidationResult {
  if (apiKey.trim().length < 10) {
    return {
      ok: false,
      message: "Cursor API key appears too short.",
    };
  }
  return {
    ok: true,
    message: "Cursor key format accepted (no live validation endpoint configured).",
  };
}

async function validateProviderKey(provider: string, apiKey: string): Promise<ValidationResult> {
  const canonical = asCanonicalProvider(provider);
  if (canonical === "openai") return validateOpenAiKey(apiKey);
  if (canonical === "anthropic") return validateAnthropicKey(apiKey);
  if (canonical === "gemini" || canonical === "google") {
    return validateGeminiOrGoogleKey(apiKey);
  }
  if (canonical === "cursor") {
    return validateCursorKey(apiKey);
  }
  if (apiKey.trim().length < 8) {
    return {
      ok: false,
      message: "API key appears too short.",
    };
  }
  return {
    ok: true,
    message: "Credential accepted (no provider-specific live validation configured).",
  };
}

export function providerConnectionRoutes(db: Db) {
  const router = Router();
  const secrets = secretService(db);
  const providerCredentials = providerCredentialService(db);
  const adapterAuth = adapterAuthService(db);

  async function resolveLegacyConnectionStatus(
    companyId: string,
    grouped: Awaited<ReturnType<typeof providerCredentials.listByProvider>>,
    provider: string,
    envKey: string,
  ) {
    const bucket = grouped.find((entry) => String(entry.provider) === provider) ?? null;
    const selectedCredential = bucket
      ? bucket.credentials.find((credential) => credential.isDefault) ?? bucket.credentials[0] ?? null
      : null;

    if (selectedCredential) {
      return {
        connected: true,
        secretId: selectedCredential.secretId,
        latestVersion: selectedCredential.secretLatestVersion,
        updatedAt: selectedCredential.secretUpdatedAt,
      };
    }

    const legacySecret = await secrets.getByName(companyId, envKey);
    return {
      connected: Boolean(legacySecret),
      secretId: legacySecret?.id ?? null,
      latestVersion: legacySecret?.latestVersion ?? null,
      updatedAt: legacySecret?.updatedAt ?? null,
    };
  }

  router.get("/companies/:companyId/provider-connections", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);

    const providers = await providerCredentials.listByProvider(companyId);
    const [openai, anthropic] = await Promise.all([
      resolveLegacyConnectionStatus(companyId, providers, "openai", "OPENAI_API_KEY"),
      resolveLegacyConnectionStatus(companyId, providers, "anthropic", "ANTHROPIC_API_KEY"),
    ]);

    res.json({
      providers,
      knownProviders: KNOWN_PROVIDER_CREDENTIAL_PROVIDERS,
      openai,
      anthropic,
    });
  });

  router.post(
    "/companies/:companyId/provider-connections",
    validate(providerConnectionLegacySchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const provider = providerCredentials.normalizeProviderId(req.body.provider);
      const apiKey = req.body.apiKey;
      const validateOnly = req.body.validateOnly === true;
      const label = (req.body.label?.trim() || "Default");
      const envKey = providerCredentials.normalizeEnvKey(
        req.body.envKey ?? defaultEnvKeyForProvider(provider),
      );
      const isDefault = req.body.isDefault !== false;
      const validation = await validateProviderKey(provider, apiKey);

      if (!validation.ok) {
        res.status(422).json({
          error: validation.message,
          ok: false,
          provider,
          envKey,
          label,
          message: validation.message,
        });
        return;
      }

      if (validateOnly) {
        res.json({
          ok: true,
          provider,
          envKey,
          label,
          stored: false,
          message: validation.message,
        });
        return;
      }

      const actor = { userId: req.actor.userId ?? "board", agentId: null };
      let mode: "created" | "rotated" = "created";
      let credential = await providerCredentials.getByProviderLabel(
        companyId,
        provider,
        label,
      );

      if (credential) {
        credential = await providerCredentials.rotate(companyId, credential.id, apiKey, actor);
        if (isDefault) {
          credential = await providerCredentials.setDefault(companyId, credential.id);
        }
        mode = "rotated";
      } else if (label === "Default" && envKey === defaultEnvKeyForProvider(provider)) {
        const canonicalSecret = await secrets.getByName(companyId, envKey);
        if (canonicalSecret) {
          credential = await providerCredentials.ensureForSecret(companyId, {
            provider,
            envKey,
            label,
            secretId: canonicalSecret.id,
            isDefault,
          });
          credential = await providerCredentials.rotate(companyId, credential.id, apiKey, actor);
          mode = "rotated";
        }
      }

      if (!credential) {
        credential = await providerCredentials.create(
          companyId,
          {
            provider,
            envKey,
            label,
            apiKey,
            isDefault,
            preferredSecretName:
              label === "Default" && envKey === defaultEnvKeyForProvider(provider)
                ? envKey
                : null,
            description: `${provider} credential (${label})`,
          },
          actor,
        );
        mode = "created";
      }

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "provider.connected",
        entityType: "secret",
        entityId: credential.secretId,
        details: {
          provider,
          envKey,
          label,
          credentialId: credential.id,
          mode,
          isDefault,
        },
      });

      res.json({
        ok: true,
        provider,
        envKey,
        label,
        stored: true,
        mode,
        credentialId: credential.id,
        secretId: credential.secretId,
        latestVersion: credential.secretLatestVersion,
        message: validation.message,
      });
    },
  );

  router.post(
    "/companies/:companyId/provider-connections/credentials",
    validate(createProviderCredentialSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const provider = providerCredentials.normalizeProviderId(req.body.provider);
      const envKey = providerCredentials.normalizeEnvKey(req.body.envKey);
      const label = req.body.label.trim();
      const validation = await validateProviderKey(provider, req.body.apiKey);
      if (!validation.ok) {
        res.status(422).json({
          error: validation.message,
          ok: false,
          provider,
          envKey,
          label,
          message: validation.message,
        });
        return;
      }

      if (req.body.validateOnly === true) {
        res.json({
          ok: true,
          provider,
          envKey,
          label,
          stored: false,
          message: validation.message,
        });
        return;
      }

      const created = await providerCredentials.create(
        companyId,
        {
          provider,
          envKey,
          label,
          apiKey: req.body.apiKey,
          isDefault: req.body.isDefault,
          description: `${provider} credential (${label})`,
        },
        { userId: req.actor.userId ?? "board", agentId: null },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "provider.credential_created",
        entityType: "secret",
        entityId: created.secretId,
        details: {
          provider,
          envKey,
          label,
          credentialId: created.id,
          isDefault: created.isDefault,
        },
      });

      res.status(201).json(created);
    },
  );

  router.patch(
    "/companies/:companyId/provider-connections/credentials/:id",
    validate(updateProviderCredentialSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const credentialId = req.params.id as string;

      const updated = await providerCredentials.update(companyId, credentialId, {
        label: req.body.label,
        isDefault: req.body.isDefault,
      });

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "provider.credential_updated",
        entityType: "secret",
        entityId: updated.secretId,
        details: {
          provider: updated.provider,
          envKey: updated.envKey,
          label: updated.label,
          credentialId: updated.id,
          isDefault: updated.isDefault,
        },
      });

      res.json(updated);
    },
  );

  router.post(
    "/companies/:companyId/provider-connections/credentials/:id/rotate",
    validate(rotateProviderCredentialSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);
      const credentialId = req.params.id as string;
      const credential = await providerCredentials.getById(credentialId);
      if (!credential || credential.companyId !== companyId) {
        res.status(404).json({ error: "Provider credential not found" });
        return;
      }

      const validation = await validateProviderKey(String(credential.provider), req.body.apiKey);
      if (!validation.ok) {
        res.status(422).json({
          error: validation.message,
          ok: false,
          provider: credential.provider,
          envKey: credential.envKey,
          label: credential.label,
          message: validation.message,
        });
        return;
      }

      if (req.body.validateOnly === true) {
        res.json({
          ok: true,
          provider: credential.provider,
          envKey: credential.envKey,
          label: credential.label,
          stored: false,
          message: validation.message,
        });
        return;
      }

      const rotated = await providerCredentials.rotate(
        companyId,
        credentialId,
        req.body.apiKey,
        { userId: req.actor.userId ?? "board", agentId: null },
      );

      await logActivity(db, {
        companyId,
        actorType: "user",
        actorId: req.actor.userId ?? "board",
        action: "provider.credential_rotated",
        entityType: "secret",
        entityId: rotated.secretId,
        details: {
          provider: rotated.provider,
          envKey: rotated.envKey,
          label: rotated.label,
          credentialId: rotated.id,
          latestVersion: rotated.secretLatestVersion,
        },
      });

      res.json(rotated);
    },
  );

  router.delete("/companies/:companyId/provider-connections/credentials/:id", async (req, res) => {
    assertBoard(req);
    const companyId = req.params.companyId as string;
    assertCompanyAccess(req, companyId);
    const credentialId = req.params.id as string;

    const removed = await providerCredentials.remove(companyId, credentialId);

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: req.actor.userId ?? "board",
      action: "provider.credential_deleted",
      entityType: "secret",
      entityId: removed.secretId,
      details: {
        provider: removed.provider,
        envKey: removed.envKey,
        label: removed.label,
        credentialId: removed.id,
      },
    });

    res.json({ ok: true, id: removed.id });
  });

  router.post(
    "/companies/:companyId/provider-connections/adapter-auth-status",
    validate(adapterAuthStatusRequestSchema),
    async (req, res) => {
      assertBoard(req);
      const companyId = req.params.companyId as string;
      assertCompanyAccess(req, companyId);

      const status = await adapterAuth.getStatus(
        companyId,
        req.body.adapterType,
        req.body.adapterConfig,
      );
      res.json(status);
    },
  );

  return router;
}
