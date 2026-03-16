import { and, desc, eq, lte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { userLlmCredentials, companyLlmSettings, llmModelCache } from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";
import {
  encryptLlmApiKey,
  decryptLlmApiKey,
  asStoredLlmCredential,
  getKeyFingerprint,
  getKeyHash,
} from "../utils/llm-encryption.js";
import { getProviderModule } from "./llm-provider-modules/index.js";
import type { LlmProviderType } from "./llm-provider-modules/types.js";

const MODEL_CACHE_TTL_HOURS = 1; // Remote providers
const OLLAMA_CACHE_TTL_MINUTES = 5; // Local only

export function llmProvidersService(db: Db) {
  // ===== USER CREDENTIALS =====

  async function getUserCredential(userId: string, providerType: LlmProviderType) {
    return db
      .select()
      .from(userLlmCredentials)
      .where(
        and(
          eq(userLlmCredentials.userId, userId),
          eq(userLlmCredentials.providerType, providerType),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function createUserCredential(
    userId: string,
    providerType: LlmProviderType,
    apiKey: string,
    baseUrl?: string,
  ) {
    const existing = await getUserCredential(userId, providerType);
    if (existing) {
      throw conflict("Credential for this provider already exists");
    }

    const encryptedPayload = encryptLlmApiKey(apiKey);

    return db
      .insert(userLlmCredentials)
      .values({
        userId,
        providerType,
        encryptedPayload,
        keyFingerprint: getKeyFingerprint(apiKey),
        baseUrl,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  async function updateUserCredential(
    credentialId: string,
    userId: string,
    apiKey: string,
    baseUrl?: string,
  ) {
    const cred = await db
      .select()
      .from(userLlmCredentials)
      .where(eq(userLlmCredentials.id, credentialId))
      .then((rows) => rows[0]);

    if (!cred || cred.userId !== userId) {
      throw notFound("Credential not found");
    }

    const encryptedPayload = encryptLlmApiKey(apiKey);

    return db
      .update(userLlmCredentials)
      .set({
        encryptedPayload,
        keyFingerprint: getKeyFingerprint(apiKey),
        baseUrl,
        updatedAt: new Date(),
      })
      .where(eq(userLlmCredentials.id, credentialId))
      .returning()
      .then((rows) => rows[0]);
  }

  async function deleteUserCredential(credentialId: string, userId: string) {
    const cred = await db
      .select()
      .from(userLlmCredentials)
      .where(eq(userLlmCredentials.id, credentialId))
      .then((rows) => rows[0]);

    if (!cred || cred.userId !== userId) {
      throw notFound("Credential not found");
    }

    await db.delete(userLlmCredentials).where(eq(userLlmCredentials.id, credentialId));
  }

  async function listUserCredentials(userId: string) {
    return db
      .select()
      .from(userLlmCredentials)
      .where(eq(userLlmCredentials.userId, userId))
      .orderBy(desc(userLlmCredentials.createdAt));
  }

  async function decryptUserCredential(credentialId: string, userId: string) {
    const cred = await db
      .select()
      .from(userLlmCredentials)
      .where(eq(userLlmCredentials.id, credentialId))
      .then((rows) => rows[0]);

    if (!cred || cred.userId !== userId) {
      throw notFound("Credential not found");
    }

    const encrypted = asStoredLlmCredential(cred.encryptedPayload);
    return decryptLlmApiKey(encrypted);
  }

  // ===== COMPANY SETTINGS =====

  async function getCompanySettings(companyId: string) {
    return db
      .select()
      .from(companyLlmSettings)
      .where(eq(companyLlmSettings.companyId, companyId))
      .then((rows) => rows[0] ?? null);
  }

  async function setCompanySettings(
    companyId: string,
    providerType: LlmProviderType,
    modelId: string,
  ) {
    const existing = await getCompanySettings(companyId);

    if (existing) {
      return db
        .update(companyLlmSettings)
        .set({
          preferredProviderType: providerType,
          preferredModelId: modelId,
          updatedAt: new Date(),
        })
        .where(eq(companyLlmSettings.companyId, companyId))
        .returning()
        .then((rows) => rows[0]);
    }

    return db
      .insert(companyLlmSettings)
      .values({
        companyId,
        preferredProviderType: providerType,
        preferredModelId: modelId,
      })
      .returning()
      .then((rows) => rows[0]);
  }

  // ===== MODEL CACHING =====

  async function getCachedModels(providerType: LlmProviderType) {
    const ttlMinutes = providerType === "ollama" ? OLLAMA_CACHE_TTL_MINUTES : MODEL_CACHE_TTL_HOURS * 60;
    const cutoffTime = new Date(Date.now() - ttlMinutes * 60 * 1000);

    return db
      .select()
      .from(llmModelCache)
      .where(and(eq(llmModelCache.providerType, providerType), lte(llmModelCache.createdAt, cutoffTime)));
  }

  async function invalidateModelCache(providerType: LlmProviderType) {
    await db.delete(llmModelCache).where(eq(llmModelCache.providerType, providerType));
  }

  async function cacheModels(
    providerType: LlmProviderType,
    models: Array<{ id: string; metadata: Record<string, unknown> }>,
  ) {
    // Clear old cache for this provider
    await invalidateModelCache(providerType);

    // Insert fresh models
    if (models.length > 0) {
      await db.insert(llmModelCache).values(
        models.map((m) => ({
          providerType,
          modelId: m.id,
          metadata: m.metadata,
        })),
      );
    }
  }

  // ===== CREDENTIAL VALIDATION =====

  async function validateCredential(
    providerType: LlmProviderType,
    apiKey: string,
    baseUrl?: string,
  ): Promise<{ valid: boolean; modelCount: number; error?: string }> {
    try {
      const module = getProviderModule(providerType);
      const result = await module.validateCredential(apiKey, baseUrl);
      return result;
    } catch (error) {
      return {
        valid: false,
        modelCount: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  // ===== SYNC MODELS =====

  async function syncModels(providerType: LlmProviderType, apiKey?: string, baseUrl?: string) {
    const module = getProviderModule(providerType);
    const models = await module.listModels(apiKey, baseUrl);
    await cacheModels(providerType, models);
    return models;
  }

  // ===== TESTS =====

  async function testCredential(credentialId: string, userId: string) {
    const cred = await db
      .select()
      .from(userLlmCredentials)
      .where(eq(userLlmCredentials.id, credentialId))
      .then((rows) => rows[0]);

    if (!cred || cred.userId !== userId) {
      throw notFound("Credential not found");
    }

    const encrypted = asStoredLlmCredential(cred.encryptedPayload);
    const apiKey = decryptLlmApiKey(encrypted);

    const validation = await validateCredential(cred.providerType as LlmProviderType, apiKey, cred.baseUrl || undefined);

    // Update test result
    await db
      .update(userLlmCredentials)
      .set({
        testedAt: new Date(),
        testError: validation.valid ? null : validation.error,
      })
      .where(eq(userLlmCredentials.id, credentialId));

    return validation;
  }

  return {
    // User credentials
    getUserCredential,
    createUserCredential,
    updateUserCredential,
    deleteUserCredential,
    listUserCredentials,
    decryptUserCredential,
    testCredential,

    // Company settings
    getCompanySettings,
    setCompanySettings,

    // Model caching
    getCachedModels,
    invalidateModelCache,
    cacheModels,

    // Validation
    validateCredential,
    syncModels,
  };
}
