import type { Db } from "@paperclipai/db";
import { llmApiKeys, agentLlmKeyAssignments, agents } from "@paperclipai/db";
import { eq, and, desc, asc, sql } from "drizzle-orm";
import crypto from "node:crypto";

// Simple AES-256 encryption for API keys at rest.
// In production, use a proper KMS; for local instances this is sufficient.
const ENCRYPTION_KEY = process.env.LLM_KEY_ENCRYPTION_SECRET || "paperclip-local-dev-key-32chars!";
const ALGORITHM = "aes-256-cbc";

if (!process.env.LLM_KEY_ENCRYPTION_SECRET) {
  console.warn("[SECURITY] LLM_KEY_ENCRYPTION_SECRET is not set — using insecure default key. Set this env var in production.");
}

function ensureKey(): Buffer {
  const key = ENCRYPTION_KEY;
  // Pad or hash to exactly 32 bytes
  return crypto.createHash("sha256").update(key).digest();
}

function encrypt(text: string): string {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ALGORITHM, ensureKey(), iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  return iv.toString("hex") + ":" + encrypted;
}

function decrypt(text: string): string {
  const parts = text.split(":");
  if (parts.length < 2) return text; // fallback for plaintext
  const iv = Buffer.from(parts[0]!, "hex");
  const encrypted = parts.slice(1).join(":");
  const decipher = crypto.createDecipheriv(ALGORITHM, ensureKey(), iv);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

function maskApiKey(key: string): string {
  if (key.length <= 12) return "****";
  return key.slice(0, 7) + "..." + key.slice(-4);
}

export interface LlmApiKey {
  id: string;
  companyId: string;
  name: string;
  provider: string;
  apiKeyMasked: string;
  modelFilter: string | null;
  isDefault: boolean;
  isActive: boolean;
  priority: number;
  monthlyBudgetUsd: number | null;
  currentMonthSpendUsd: number;
  totalSpendUsd: number;
  totalRequests: number;
  lastUsedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentKeyAssignment {
  id: string;
  agentId: string;
  llmApiKeyId: string;
  companyId: string;
  assignedBy: string;
  assignedAt: Date;
  keyName?: string;
  keyProvider?: string;
}

function toApiKey(row: typeof llmApiKeys.$inferSelect): LlmApiKey {
  let maskedKey = "****";
  try {
    maskedKey = maskApiKey(decrypt(row.apiKeyEncrypted));
  } catch {
    maskedKey = "****";
  }
  return {
    id: row.id,
    companyId: row.companyId,
    name: row.name,
    provider: row.provider,
    apiKeyMasked: maskedKey,
    modelFilter: row.modelFilter,
    isDefault: row.isDefault,
    isActive: row.isActive,
    priority: row.priority,
    monthlyBudgetUsd: row.monthlyBudgetUsd ? parseFloat(row.monthlyBudgetUsd) : null,
    currentMonthSpendUsd: parseFloat(row.currentMonthSpendUsd ?? "0"),
    totalSpendUsd: parseFloat(row.totalSpendUsd ?? "0"),
    totalRequests: row.totalRequests,
    lastUsedAt: row.lastUsedAt,
    lastError: row.lastError,
    lastErrorAt: row.lastErrorAt,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function llmApiKeyService(db: Db) {
  return {
    /** List all API keys for a company (keys are masked). */
    async list(companyId: string): Promise<LlmApiKey[]> {
      const rows = await db
        .select()
        .from(llmApiKeys)
        .where(eq(llmApiKeys.companyId, companyId))
        .orderBy(desc(llmApiKeys.isDefault), asc(llmApiKeys.priority), asc(llmApiKeys.createdAt));
      return rows.map(toApiKey);
    },

    /** Get a single key by ID. */
    async getById(companyId: string, keyId: string): Promise<LlmApiKey | null> {
      const [row] = await db
        .select()
        .from(llmApiKeys)
        .where(and(eq(llmApiKeys.id, keyId), eq(llmApiKeys.companyId, companyId)));
      return row ? toApiKey(row) : null;
    },

    /** Create a new API key. */
    async create(input: {
      companyId: string;
      name: string;
      provider: string;
      apiKey: string;
      modelFilter?: string | null;
      isDefault?: boolean;
      priority?: number;
      monthlyBudgetUsd?: number | null;
      notes?: string | null;
    }): Promise<LlmApiKey> {
      const now = new Date();

      // If this is set as default, unset other defaults for this company+provider
      if (input.isDefault) {
        await db
          .update(llmApiKeys)
          .set({ isDefault: false, updatedAt: now })
          .where(and(
            eq(llmApiKeys.companyId, input.companyId),
            eq(llmApiKeys.provider, input.provider),
            eq(llmApiKeys.isDefault, true),
          ));
      }

      const [created] = await db
        .insert(llmApiKeys)
        .values({
          companyId: input.companyId,
          name: input.name,
          provider: input.provider,
          apiKeyEncrypted: encrypt(input.apiKey),
          modelFilter: input.modelFilter ?? null,
          isDefault: input.isDefault ?? false,
          priority: input.priority ?? 0,
          monthlyBudgetUsd: input.monthlyBudgetUsd != null ? String(input.monthlyBudgetUsd) : null,
          notes: input.notes ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .returning();

      return toApiKey(created!);
    },

    /** Update an existing key's metadata (not the actual API key unless provided). */
    async update(
      companyId: string,
      keyId: string,
      patch: {
        name?: string;
        provider?: string;
        apiKey?: string;
        modelFilter?: string | null;
        isDefault?: boolean;
        isActive?: boolean;
        priority?: number;
        monthlyBudgetUsd?: number | null;
        notes?: string | null;
      },
    ): Promise<LlmApiKey | null> {
      const now = new Date();
      const updates: Record<string, unknown> = { updatedAt: now };

      if (patch.name !== undefined) updates.name = patch.name;
      if (patch.provider !== undefined) updates.provider = patch.provider;
      if (patch.apiKey !== undefined) updates.apiKeyEncrypted = encrypt(patch.apiKey);
      if (patch.modelFilter !== undefined) updates.modelFilter = patch.modelFilter;
      if (patch.isActive !== undefined) updates.isActive = patch.isActive;
      if (patch.priority !== undefined) updates.priority = patch.priority;
      if (patch.monthlyBudgetUsd !== undefined) {
        updates.monthlyBudgetUsd = patch.monthlyBudgetUsd != null ? String(patch.monthlyBudgetUsd) : null;
      }
      if (patch.notes !== undefined) updates.notes = patch.notes;

      // Handle default flag
      if (patch.isDefault === true) {
        // Get current row to know provider
        const [current] = await db
          .select()
          .from(llmApiKeys)
          .where(and(eq(llmApiKeys.id, keyId), eq(llmApiKeys.companyId, companyId)));
        if (current) {
          const provider = patch.provider ?? current.provider;
          await db
            .update(llmApiKeys)
            .set({ isDefault: false, updatedAt: now })
            .where(and(
              eq(llmApiKeys.companyId, companyId),
              eq(llmApiKeys.provider, provider),
              eq(llmApiKeys.isDefault, true),
            ));
        }
        updates.isDefault = true;
      } else if (patch.isDefault === false) {
        updates.isDefault = false;
      }

      const [updated] = await db
        .update(llmApiKeys)
        .set(updates)
        .where(and(eq(llmApiKeys.id, keyId), eq(llmApiKeys.companyId, companyId)))
        .returning();

      return updated ? toApiKey(updated) : null;
    },

    /** Delete an API key and its assignments. */
    async delete(companyId: string, keyId: string): Promise<boolean> {
      const result = await db
        .delete(llmApiKeys)
        .where(and(eq(llmApiKeys.id, keyId), eq(llmApiKeys.companyId, companyId)))
        .returning();
      return result.length > 0;
    },

    /** Resolve the actual decrypted API key for an agent.
     *  Priority: agent-specific assignment > company default > env var.
     */
    async resolveKeyForAgent(companyId: string, agentId: string, provider: string = "anthropic"): Promise<string | null> {
      // 1. Check agent-specific assignment
      const assignments = await db
        .select({
          keyId: agentLlmKeyAssignments.llmApiKeyId,
        })
        .from(agentLlmKeyAssignments)
        .where(and(
          eq(agentLlmKeyAssignments.agentId, agentId),
          eq(agentLlmKeyAssignments.companyId, companyId),
        ));

      if (assignments.length > 0) {
        const keyId = assignments[0]!.keyId;
        const [keyRow] = await db
          .select()
          .from(llmApiKeys)
          .where(and(
            eq(llmApiKeys.id, keyId),
            eq(llmApiKeys.isActive, true),
          ));
        if (keyRow) {
          // Update usage stats
          await db
            .update(llmApiKeys)
            .set({
              lastUsedAt: new Date(),
              totalRequests: sql`${llmApiKeys.totalRequests} + 1`,
            })
            .where(eq(llmApiKeys.id, keyRow.id));
          return decrypt(keyRow.apiKeyEncrypted);
        }
      }

      // 2. Check company default for this provider
      const [defaultKey] = await db
        .select()
        .from(llmApiKeys)
        .where(and(
          eq(llmApiKeys.companyId, companyId),
          eq(llmApiKeys.provider, provider),
          eq(llmApiKeys.isDefault, true),
          eq(llmApiKeys.isActive, true),
        ));

      if (defaultKey) {
        // Check budget
        if (defaultKey.monthlyBudgetUsd) {
          const budget = parseFloat(defaultKey.monthlyBudgetUsd);
          const spent = parseFloat(defaultKey.currentMonthSpendUsd ?? "0");
          if (spent >= budget) {
            // Budget exceeded — try next priority key
            return this.resolveKeyByPriority(companyId, provider);
          }
        }
        await db
          .update(llmApiKeys)
          .set({
            lastUsedAt: new Date(),
            totalRequests: sql`${llmApiKeys.totalRequests} + 1`,
          })
          .where(eq(llmApiKeys.id, defaultKey.id));
        return decrypt(defaultKey.apiKeyEncrypted);
      }

      // 3. Try highest priority active key
      return this.resolveKeyByPriority(companyId, provider);
    },

    /** Get highest-priority active key that's within budget. */
    async resolveKeyByPriority(companyId: string, provider: string): Promise<string | null> {
      const rows = await db
        .select()
        .from(llmApiKeys)
        .where(and(
          eq(llmApiKeys.companyId, companyId),
          eq(llmApiKeys.provider, provider),
          eq(llmApiKeys.isActive, true),
        ))
        .orderBy(asc(llmApiKeys.priority), desc(llmApiKeys.isDefault));

      for (const row of rows) {
        if (row.monthlyBudgetUsd) {
          const budget = parseFloat(row.monthlyBudgetUsd);
          const spent = parseFloat(row.currentMonthSpendUsd ?? "0");
          if (spent >= budget) continue;
        }
        await db
          .update(llmApiKeys)
          .set({
            lastUsedAt: new Date(),
            totalRequests: sql`${llmApiKeys.totalRequests} + 1`,
          })
          .where(eq(llmApiKeys.id, row.id));
        return decrypt(row.apiKeyEncrypted);
      }

      return null; // No keys available — fall back to env var
    },

    /** Record spend against a key after a run completes. */
    async recordSpend(keyId: string, costUsd: number): Promise<void> {
      await db
        .update(llmApiKeys)
        .set({
          currentMonthSpendUsd: sql`${llmApiKeys.currentMonthSpendUsd}::numeric + ${costUsd}`,
          totalSpendUsd: sql`${llmApiKeys.totalSpendUsd}::numeric + ${costUsd}`,
          updatedAt: new Date(),
        })
        .where(eq(llmApiKeys.id, keyId));
    },

    /** Record an error for a key. */
    async recordError(keyId: string, error: string): Promise<void> {
      await db
        .update(llmApiKeys)
        .set({
          lastError: error,
          lastErrorAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(llmApiKeys.id, keyId));
    },

    // --- Agent assignments ---

    /** List all key assignments for an agent. */
    async listAgentAssignments(companyId: string, agentId: string): Promise<AgentKeyAssignment[]> {
      const rows = await db
        .select({
          id: agentLlmKeyAssignments.id,
          agentId: agentLlmKeyAssignments.agentId,
          llmApiKeyId: agentLlmKeyAssignments.llmApiKeyId,
          companyId: agentLlmKeyAssignments.companyId,
          assignedBy: agentLlmKeyAssignments.assignedBy,
          assignedAt: agentLlmKeyAssignments.assignedAt,
          keyName: llmApiKeys.name,
          keyProvider: llmApiKeys.provider,
        })
        .from(agentLlmKeyAssignments)
        .innerJoin(llmApiKeys, eq(agentLlmKeyAssignments.llmApiKeyId, llmApiKeys.id))
        .where(and(
          eq(agentLlmKeyAssignments.agentId, agentId),
          eq(agentLlmKeyAssignments.companyId, companyId),
        ));

      return rows;
    },

    /** Assign a key to an agent. */
    async assignKeyToAgent(input: {
      companyId: string;
      agentId: string;
      llmApiKeyId: string;
      assignedBy?: string;
    }): Promise<AgentKeyAssignment> {
      const [row] = await db
        .insert(agentLlmKeyAssignments)
        .values({
          agentId: input.agentId,
          llmApiKeyId: input.llmApiKeyId,
          companyId: input.companyId,
          assignedBy: input.assignedBy ?? "manual",
        })
        .onConflictDoUpdate({
          target: [agentLlmKeyAssignments.agentId, agentLlmKeyAssignments.llmApiKeyId],
          set: {
            assignedBy: input.assignedBy ?? "manual",
            assignedAt: new Date(),
          },
        })
        .returning();

      return {
        id: row!.id,
        agentId: row!.agentId,
        llmApiKeyId: row!.llmApiKeyId,
        companyId: row!.companyId,
        assignedBy: row!.assignedBy,
        assignedAt: row!.assignedAt,
      };
    },

    /** Remove a key assignment from an agent. */
    async removeAgentAssignment(companyId: string, agentId: string, llmApiKeyId: string): Promise<boolean> {
      const result = await db
        .delete(agentLlmKeyAssignments)
        .where(and(
          eq(agentLlmKeyAssignments.agentId, agentId),
          eq(agentLlmKeyAssignments.llmApiKeyId, llmApiKeyId),
          eq(agentLlmKeyAssignments.companyId, companyId),
        ))
        .returning();
      return result.length > 0;
    },

    /** Replace all key assignments for an agent with a single key. */
    async setAgentKey(companyId: string, agentId: string, llmApiKeyId: string, assignedBy: string = "ceo"): Promise<void> {
      await db
        .delete(agentLlmKeyAssignments)
        .where(and(
          eq(agentLlmKeyAssignments.agentId, agentId),
          eq(agentLlmKeyAssignments.companyId, companyId),
        ));

      await db
        .insert(agentLlmKeyAssignments)
        .values({
          agentId,
          llmApiKeyId,
          companyId,
          assignedBy,
        });
    },
  };
}
