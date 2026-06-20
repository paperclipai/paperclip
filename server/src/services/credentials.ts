import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, gt, gte, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentCredentials, agents, costEvents, providerCredentials } from "@paperclipai/db";
import type {
  CredentialType,
  ProviderCredentialUsage,
  ProviderCredentialUsageModel,
  ProviderCredentialUsageWindow,
  QuotaWindow,
} from "@paperclipai/shared";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import { estimateApiEquivalentCostCents, isSubscriptionBillingType } from "./api-equivalent-cost.js";
import { resolveCodexAccountId } from "./codex-account-id.js";
import { getReusableQuotaCache } from "./credential-quota-cache.js";
import {
  decryptCredential,
  encryptCredential,
  isEncryptedCredentialMaterial,
} from "./credential-encryption.js";

type CredentialRow = typeof providerCredentials.$inferSelect;
type SafeCredential = Omit<CredentialRow, "credential">;
type CredentialSelectionRow = Pick<CredentialRow, "id" | "type">;
type CredentialUsageAggregate = Omit<ProviderCredentialUsageWindow, "label" | "hours">;
type CredentialUsageWindowSpec = { label: string; hours: number; key: string; since?: Date };

export type CredentialAssignmentValidationResult =
  | { ok: true; credentials: SafeCredential[] }
  | { ok: false; error: "credential_not_found"; credentialId: string }
  | { ok: false; error: "mixed_codex_auth_modes"; message: string };

function stripCredential(row: CredentialRow): SafeCredential {
  const { credential: _credential, ...safe } = row;
  return safe;
}

function decryptPayload(row: CredentialRow): Record<string, unknown> {
  if (isEncryptedCredentialMaterial(row.credential)) {
    return decryptCredential(row.credential);
  }
  // Back-compat: rows written before encryption rollout stored plaintext JSON.
  if (row.credential && typeof row.credential === "object" && !Array.isArray(row.credential)) {
    return row.credential as Record<string, unknown>;
  }
  return {};
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readCredentialConfigString(record: Record<string, unknown> | null | undefined, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function emptyCredentialUsageAggregate(): CredentialUsageAggregate {
  return {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    apiEquivalentCostCents: 0,
    subscriptionApiEquivalentCostCents: 0,
    events: 0,
  };
}

function buildCredentialUsageWindowSpecs(sinceMs: number): {
  specs: CredentialUsageWindowSpec[];
  primaryKey: string;
} {
  const requestedHours = Math.max(1, Math.round(Math.max(1, sinceMs) / (60 * 60 * 1000)));
  const requestedLabel = requestedHours % 24 === 0 ? `${requestedHours / 24}d` : `${requestedHours}h`;
  const requestedKey = String(requestedHours);
  const base: CredentialUsageWindowSpec[] = [
    { label: "5h", hours: 5, key: "5" },
    { label: "24h", hours: 24, key: "24" },
    { label: "7d", hours: 7 * 24, key: String(7 * 24) },
    { label: requestedLabel, hours: requestedHours, key: requestedKey },
  ];
  const seen = new Map<string, CredentialUsageWindowSpec>();
  for (const spec of base) {
    if (!seen.has(spec.key)) seen.set(spec.key, spec);
  }
  return { specs: [...seen.values()], primaryKey: requestedKey };
}

function buildCredentialUsageMonthToDateWindowSpecs(now = new Date()): {
  specs: CredentialUsageWindowSpec[];
  primaryKey: string;
  since: Date;
} {
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0));
  const elapsedHours = Math.max(1, Math.ceil((now.getTime() - since.getTime()) / (60 * 60 * 1000)));
  const base: CredentialUsageWindowSpec[] = [
    { label: "5h", hours: 5, key: "5" },
    { label: "24h", hours: 24, key: "24" },
    { label: "7d", hours: 7 * 24, key: String(7 * 24) },
    { label: "MTD", hours: elapsedHours, key: "mtd", since },
  ];
  return { specs: base, primaryKey: "mtd", since };
}

export function credentialService(db: Db) {
  async function usageByCredentialForSpecs(
    companyId: string,
    specs: CredentialUsageWindowSpec[],
    primaryKey: string,
  ): Promise<ProviderCredentialUsage[]> {
    async function aggregateWindow(
      spec: CredentialUsageWindowSpec,
      includeModels = false,
    ): Promise<{
      byCredential: Map<string, CredentialUsageAggregate>;
      modelsByCredential: Map<string, ProviderCredentialUsageModel[]>;
    }> {
      const since = spec.since ?? new Date(Date.now() - spec.hours * 60 * 60 * 1000);
      const rows = await db
        .select({
          credentialId: costEvents.credentialId,
          provider: costEvents.provider,
          biller: costEvents.biller,
          billingType: costEvents.billingType,
          model: costEvents.model,
          inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)::double precision`,
          outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)::double precision`,
          cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)::double precision`,
          costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision`,
          events: sql<number>`count(*)::double precision`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, since),
            isNotNull(costEvents.credentialId),
          ),
        )
        .groupBy(
          costEvents.credentialId,
          costEvents.provider,
          costEvents.biller,
          costEvents.billingType,
          costEvents.model,
        );

      const byCredential = new Map<string, CredentialUsageAggregate>();
      const modelsByCredential = new Map<string, ProviderCredentialUsageModel[]>();
      for (const row of rows) {
        if (!row.credentialId) continue;
        const aggregate = byCredential.get(row.credentialId) ?? emptyCredentialUsageAggregate();
        const inputTokens = Number(row.inputTokens);
        const outputTokens = Number(row.outputTokens);
        const cachedInputTokens = Number(row.cachedInputTokens);
        const costCents = Number(row.costCents);
        const events = Number(row.events);
        const apiEquivalent = estimateApiEquivalentCostCents({
          provider: row.provider,
          biller: row.biller,
          model: row.model,
          inputTokens,
          cachedInputTokens,
          outputTokens,
          fallbackCostCents: costCents,
        });

        aggregate.inputTokens += inputTokens;
        aggregate.outputTokens += outputTokens;
        aggregate.cachedInputTokens += cachedInputTokens;
        aggregate.costCents += costCents;
        aggregate.apiEquivalentCostCents += apiEquivalent.costCents;
        if (isSubscriptionBillingType(row.billingType)) {
          aggregate.subscriptionApiEquivalentCostCents += apiEquivalent.costCents;
        }
        aggregate.events += events;
        byCredential.set(row.credentialId, aggregate);

        if (includeModels) {
          const models = modelsByCredential.get(row.credentialId) ?? [];
          models.push({
            provider: row.provider,
            biller: row.biller,
            billingType: row.billingType,
            model: row.model,
            inputTokens,
            cachedInputTokens,
            outputTokens,
            costCents,
            apiEquivalentCostCents: apiEquivalent.costCents,
            subscriptionApiEquivalentCostCents: isSubscriptionBillingType(row.billingType)
              ? apiEquivalent.costCents
              : 0,
            events,
            pricingLabel: apiEquivalent.pricingLabel,
          });
          modelsByCredential.set(row.credentialId, models);
        }
      }
      for (const models of modelsByCredential.values()) {
        models.sort((a, b) =>
          b.apiEquivalentCostCents - a.apiEquivalentCostCents
          || b.costCents - a.costCents
          || b.inputTokens + b.cachedInputTokens + b.outputTokens - (a.inputTokens + a.cachedInputTokens + a.outputTokens),
        );
      }
      return { byCredential, modelsByCredential };
    }

    const windowPairs = await Promise.all(
      specs.map(async (spec) => [spec, await aggregateWindow(spec, spec.key === primaryKey)] as const),
    );
    const primary = windowPairs.find(([spec]) => spec.key === primaryKey)?.[1] ?? {
      byCredential: new Map<string, CredentialUsageAggregate>(),
      modelsByCredential: new Map<string, ProviderCredentialUsageModel[]>(),
    };
    const credentialIds = new Set<string>();
    for (const [, aggregate] of windowPairs) {
      for (const credentialId of aggregate.byCredential.keys()) credentialIds.add(credentialId);
    }

    return [...credentialIds].sort().map((credentialId) => {
      const primaryAggregate = primary.byCredential.get(credentialId) ?? emptyCredentialUsageAggregate();
      return {
        credentialId,
        inputTokens: primaryAggregate.inputTokens,
        outputTokens: primaryAggregate.outputTokens,
        cachedInputTokens: primaryAggregate.cachedInputTokens,
        costCents: primaryAggregate.costCents,
        apiEquivalentCostCents: primaryAggregate.apiEquivalentCostCents,
        subscriptionApiEquivalentCostCents: primaryAggregate.subscriptionApiEquivalentCostCents,
        events: primaryAggregate.events,
        windows: windowPairs.map(([spec, aggregate]) => ({
          label: spec.label,
          hours: spec.hours,
          ...(aggregate.byCredential.get(credentialId) ?? emptyCredentialUsageAggregate()),
        })),
        models: primary.modelsByCredential.get(credentialId) ?? [],
      };
    });
  }

  const svc = {
    async list(companyId: string): Promise<SafeCredential[]> {
      const rows = await db
        .select()
        .from(providerCredentials)
        .where(eq(providerCredentials.companyId, companyId))
        .orderBy(providerCredentials.name);
      return rows.map(stripCredential);
    },

    async getById(id: string): Promise<CredentialRow | null> {
      const [row] = await db
        .select()
        .from(providerCredentials)
        .where(eq(providerCredentials.id, id))
        .limit(1);
      return row ?? null;
    },

    async getDecryptedPayload(id: string): Promise<Record<string, unknown> | null> {
      const row = await svc.getById(id);
      if (!row) return null;
      return decryptPayload(row);
    },

    async create(
      companyId: string,
      data: { name: string; type: string; credential: Record<string, unknown>; isDefault?: boolean },
    ): Promise<SafeCredential> {
      const material = encryptCredential(data.credential);

      if (data.isDefault) {
        await db
          .update(providerCredentials)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(providerCredentials.companyId, companyId),
              eq(providerCredentials.type, data.type),
              eq(providerCredentials.isDefault, true),
            ),
          );
      }

      const [created] = await db
        .insert(providerCredentials)
        .values({
          companyId,
          name: data.name,
          type: data.type,
          credential: material,
          isDefault: data.isDefault ?? false,
        })
        .returning();

      return stripCredential(created);
    },

    async update(
      id: string,
      data: { name?: string; credential?: Record<string, unknown>; isDefault?: boolean },
    ): Promise<SafeCredential | null> {
      const existing = await svc.getById(id);
      if (!existing) return null;

      if (data.isDefault) {
        await db
          .update(providerCredentials)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(
            and(
              eq(providerCredentials.companyId, existing.companyId),
              eq(providerCredentials.type, existing.type),
              eq(providerCredentials.isDefault, true),
            ),
          );
      }

      const updates: Record<string, unknown> = { updatedAt: new Date() };
      if (data.name !== undefined) updates.name = data.name;
      if (data.credential !== undefined) updates.credential = encryptCredential(data.credential);
      if (data.isDefault !== undefined) updates.isDefault = data.isDefault;
      // Pasting a fresh secret is the natural "I fixed it" signal — clear the
      // failover state so a previously-disabled/cooling credential rejoins the
      // rotation pool immediately.
      if (data.credential !== undefined) {
        updates.disabledAt = null;
        updates.disabledReason = null;
        updates.cooldownUntil = null;
        updates.cooldownReason = null;
        updates.consecutiveFailureCount = 0;
      }

      const [updated] = await db
        .update(providerCredentials)
        .set(updates)
        .where(eq(providerCredentials.id, id))
        .returning();

      return updated ? stripCredential(updated) : null;
    },

    /**
     * Re-enable a credential the user disabled or that was auto-disabled after
     * repeated failures: clears the disabled flag, any active cooldown, and the
     * consecutive-failure counter so it rejoins the rotation pool.
     */
    async reenable(id: string): Promise<SafeCredential | null> {
      const [updated] = await db
        .update(providerCredentials)
        .set({
          disabledAt: null,
          disabledReason: null,
          cooldownUntil: null,
          cooldownReason: null,
          consecutiveFailureCount: 0,
          updatedAt: new Date(),
        })
        .where(eq(providerCredentials.id, id))
        .returning();
      return updated ? stripCredential(updated) : null;
    },

    async remove(id: string, force?: boolean) {
      const legacyRefs = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.credentialId, id));
      const joinRefs = await db
        .select({ id: agentCredentials.id })
        .from(agentCredentials)
        .where(eq(agentCredentials.credentialId, id));

      if (legacyRefs.length > 0 || joinRefs.length > 0) {
        if (!force) {
          return { error: "credential_in_use" as const };
        }
        if (legacyRefs.length > 0) {
          await db
            .update(agents)
            .set({ credentialId: null, updatedAt: new Date() })
            .where(eq(agents.credentialId, id));
        }
        // joinRefs are cleared via ON DELETE CASCADE on the FK.
      }

      const [removed] = await db
        .delete(providerCredentials)
        .where(eq(providerCredentials.id, id))
        .returning();

      return removed ? stripCredential(removed) : null;
    },

    async listForAgent(agentId: string): Promise<SafeCredential[]> {
      const rows = await db
        .select({ credential: providerCredentials })
        .from(agentCredentials)
        .innerJoin(providerCredentials, eq(agentCredentials.credentialId, providerCredentials.id))
        .where(eq(agentCredentials.agentId, agentId))
        .orderBy(providerCredentials.type, providerCredentials.name);
      return rows.map((row) => stripCredential(row.credential));
    },

    /**
     * Replace the full set of credentials assigned to an agent.
     *
     * Multiple credentials of the same provider type ARE allowed — they form a
     * rotation pool that the heartbeat picker rotates through (least-recently-
     * used, skipping any on cooldown). The `duplicate_type` error variant is
     * retained in the return type for backward compatibility but is no longer
     * produced.
     */
    async setForAgent(
      agentId: string,
      credentialIds: string[],
      options?: { adapterType?: string; adapterConfig?: Record<string, unknown> | null },
    ): Promise<
      | { ok: true; credentials: SafeCredential[] }
      | { ok: false; error: "duplicate_type"; type: string }
      | { ok: false; error: "credential_not_found"; credentialId: string }
      | { ok: false; error: "mixed_codex_auth_modes"; message: string }
    > {
      const uniqueIds = Array.from(new Set(credentialIds));

      if (uniqueIds.length === 0) {
        await db.delete(agentCredentials).where(eq(agentCredentials.agentId, agentId));
        return { ok: true, credentials: [] };
      }

      const [agentRow] = await db
        .select({
          companyId: agents.companyId,
          adapterType: agents.adapterType,
          adapterConfig: agents.adapterConfig,
        })
        .from(agents)
        .where(eq(agents.id, agentId))
        .limit(1);

      if (!agentRow) {
        return { ok: false, error: "credential_not_found", credentialId: uniqueIds[0] };
      }

      const creds = await db
        .select()
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.companyId, agentRow.companyId),
            inArray(providerCredentials.id, uniqueIds),
          ),
        );

      if (creds.length !== uniqueIds.length) {
        const found = new Set(creds.map((c) => c.id));
        const missing = uniqueIds.find((id) => !found.has(id))!;
        return { ok: false, error: "credential_not_found", credentialId: missing };
      }

      const authModeValidation = validateCredentialSelectionForAdapter({
        adapterType: options?.adapterType ?? agentRow.adapterType,
        adapterConfig: options?.adapterConfig ?? asRecord(agentRow.adapterConfig) ?? {},
        credentials: creds,
      });
      if (!authModeValidation.ok) return authModeValidation;

      await db.transaction(async (tx) => {
        await tx.delete(agentCredentials).where(eq(agentCredentials.agentId, agentId));
        await tx.insert(agentCredentials).values(uniqueIds.map((credentialId) => ({ agentId, credentialId })));
      });

      return { ok: true, credentials: creds.map(stripCredential) };
    },

    async validateForAdapterAssignment(input: {
      companyId: string;
      adapterType: string;
      adapterConfig: Record<string, unknown> | null | undefined;
      credentialIds: string[];
    }): Promise<CredentialAssignmentValidationResult> {
      const uniqueIds = Array.from(new Set(input.credentialIds));
      if (uniqueIds.length === 0) return { ok: true, credentials: [] };

      const creds = await db
        .select()
        .from(providerCredentials)
        .where(
          and(
            eq(providerCredentials.companyId, input.companyId),
            inArray(providerCredentials.id, uniqueIds),
          ),
        );

      if (creds.length !== uniqueIds.length) {
        const found = new Set(creds.map((c) => c.id));
        const missing = uniqueIds.find((id) => !found.has(id))!;
        return { ok: false, error: "credential_not_found", credentialId: missing };
      }

      const authModeValidation = validateCredentialSelectionForAdapter({
        adapterType: input.adapterType,
        adapterConfig: input.adapterConfig ?? {},
        credentials: creds,
      });
      if (!authModeValidation.ok) return authModeValidation;

      return { ok: true, credentials: creds.map(stripCredential) };
    },

    async usageByCredential(companyId: string, sinceMs: number): Promise<ProviderCredentialUsage[]> {
      const { specs, primaryKey } = buildCredentialUsageWindowSpecs(sinceMs);
      return usageByCredentialForSpecs(companyId, specs, primaryKey);
    },

    async usageByCredentialMonthToDate(companyId: string): Promise<{
      since: Date;
      usage: ProviderCredentialUsage[];
    }> {
      const { specs, primaryKey, since } = buildCredentialUsageMonthToDateWindowSpecs();
      return { since, usage: await usageByCredentialForSpecs(companyId, specs, primaryKey) };
    },
  };

  return svc;
}

/**
 * Resolve provider credential environment variables for an agent execution.
 *
 * Dispatches by credential type:
 * - `claude_oauth`: writes `.credentials.json` under an agent-specific HOME and
 *   overrides HOME so the Claude CLI discovers the OAuth token.
 * - `claude_api_key`: sets ANTHROPIC_API_KEY.
 * - `codex_oauth`: writes `auth.json` under an agent-specific CODEX_HOME and
 *   sets CODEX_HOME so the Codex CLI discovers the ChatGPT OAuth token.
 * - `gemini_api_key`: sets GEMINI_API_KEY and GOOGLE_API_KEY.
 * - `openai_api_key`: sets OPENAI_API_KEY (covers codex-local, cursor-local,
 *   opencode-local, and pi-local's OpenAI API-key provider).
 * - `openrouter_api_key`: sets OPENROUTER_API_KEY (covers opencode-local and
 *   pi-local's OpenRouter provider).
 * - `deepseek_api_key`: sets DEEPSEEK_API_KEY (covers deepseek-api), or the
 *   ANTHROPIC_* env when bound to a Claude Code adapter.
 * - `mimo_api_key`: sets the ANTHROPIC_* env routing Claude Code through Xiaomi
 *   MiMo's Anthropic-compatible endpoint, or XIAOMI_TOKEN_PLAN_SGP_API_KEY for
 *   pi-local's Xiaomi MiMo Token Plan provider.
 */
/**
 * Adapter types that drive the real Claude Code CLI. When one of these agents is
 * bound to a `deepseek_api_key` credential, we don't set DEEPSEEK_API_KEY (the
 * CLI wouldn't read it) — instead we point Claude Code at DeepSeek's
 * Anthropic-compatible endpoint so the full agentic loop runs on DeepSeek.
 */
const CLAUDE_CODE_ADAPTER_TYPES = new Set(["claude_local", "claude_tui"]);
const PI_LOCAL_ADAPTER_TYPES = new Set(["pi_local"]);
const PI_OPENAI_CODEX_PROVIDER_ID = "openai-codex";
const PI_CODING_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";
const PAPERCLIP_MANAGED_PI_AGENT_DIR_ENV = "PAPERCLIP_MANAGED_PI_AGENT_DIR";

const DEEPSEEK_ANTHROPIC_BASE_URL = "https://api.deepseek.com/anthropic";
const DEEPSEEK_PRO_MODEL = "deepseek-v4-pro";
const DEEPSEEK_FLASH_MODEL = "deepseek-v4-flash";

/**
 * Env that makes Claude Code talk to DeepSeek's Anthropic-compatible endpoint.
 * Maps Claude Code's model tiers to DeepSeek's two models so the agent's Model
 * dropdown is the control surface:
 *   - Opus   -> deepseek-v4-pro    (the strong model)
 *   - Sonnet -> deepseek-v4-flash  (faster / cheaper)
 *   - Haiku / subagents -> deepseek-v4-flash
 * ANTHROPIC_MODEL (used when no model tier is requested) defaults to Pro. The
 * credential payload may override either model id via proModel / flashModel.
 */
function buildDeepSeekClaudeCodeEnv(
  apiKey: string,
  payload: Record<string, unknown>,
): Record<string, string> {
  const pro = typeof payload.proModel === "string" && payload.proModel.trim()
    ? payload.proModel.trim()
    : DEEPSEEK_PRO_MODEL;
  const flash = typeof payload.flashModel === "string" && payload.flashModel.trim()
    ? payload.flashModel.trim()
    : DEEPSEEK_FLASH_MODEL;
  return {
    ANTHROPIC_BASE_URL: DEEPSEEK_ANTHROPIC_BASE_URL,
    // DeepSeek's guide uses ANTHROPIC_AUTH_TOKEN (sent as a Bearer token).
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_MODEL: pro,
    ANTHROPIC_DEFAULT_OPUS_MODEL: pro,
    ANTHROPIC_DEFAULT_SONNET_MODEL: flash,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: flash,
    CLAUDE_CODE_SUBAGENT_MODEL: flash,
    CLAUDE_CODE_EFFORT_LEVEL: "max",
  };
}

// Xiaomi MiMo's Token-Plan (SGP) Anthropic-compatible endpoint. Unlike DeepSeek,
// MiMo does NOT auto-map claude-* model ids — it hard-rejects them (400 "Not
// supported model"), so the agent's Model dropdown must stay on Default and the
// tier->model resolution is driven entirely by these ANTHROPIC_*_MODEL vars,
// which Claude Code resolves internally to concrete mimo-* ids before any
// request leaves the CLI (MiMo never sees a claude-* id).
const MIMO_ANTHROPIC_BASE_URL = "https://token-plan-sgp.xiaomimimo.com/anthropic";
const MIMO_PRO_MODEL = "mimo-v2.5-pro";
const MIMO_LITE_MODEL = "mimo-v2.5";

/**
 * Env that makes Claude Code talk to Xiaomi MiMo's Anthropic-compatible endpoint.
 * Tier mapping (cost-optimized, user-chosen):
 *   - Opus   -> mimo-v2.5-pro  (flagship; heavy reasoning)
 *   - Sonnet -> mimo-v2.5      (main loop on the ~3x cheaper model)
 *   - Haiku / subagents -> mimo-v2.5
 * ANTHROPIC_MODEL (no tier requested) defaults to the lite model to match the
 * Sonnet main-loop choice. Payload may override via proModel / liteModel.
 */
function buildMimoClaudeCodeEnv(
  apiKey: string,
  payload: Record<string, unknown>,
): Record<string, string> {
  const pro = typeof payload.proModel === "string" && payload.proModel.trim()
    ? payload.proModel.trim()
    : MIMO_PRO_MODEL;
  const lite = typeof payload.liteModel === "string" && payload.liteModel.trim()
    ? payload.liteModel.trim()
    : MIMO_LITE_MODEL;
  return {
    ANTHROPIC_BASE_URL: MIMO_ANTHROPIC_BASE_URL,
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_MODEL: lite,
    ANTHROPIC_DEFAULT_OPUS_MODEL: pro,
    ANTHROPIC_DEFAULT_SONNET_MODEL: lite,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: lite,
    CLAUDE_CODE_SUBAGENT_MODEL: lite,
    CLAUDE_CODE_EFFORT_LEVEL: "max",
  };
}

function piAgentDirForAgent(agentId: string): string {
  return path.join(resolvePaperclipInstanceRoot(), "agent-homes", agentId, ".pi", "agent");
}

async function readJsonObjectFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function writePiCodexAuth(input: {
  agentId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  accountId: string;
}): Promise<{ env: Record<string, string>; home: string }> {
  const agentHome = path.join(resolvePaperclipInstanceRoot(), "agent-homes", input.agentId);
  const piAgentDir = piAgentDirForAgent(input.agentId);
  await fs.mkdir(piAgentDir, { recursive: true });

  const authFile = path.join(piAgentDir, "auth.json");
  const existing = await readJsonObjectFile(authFile);
  const nextAuth: Record<string, unknown> = {
    ...existing,
    [PI_OPENAI_CODEX_PROVIDER_ID]: {
      type: "oauth",
      access: input.accessToken,
      refresh: input.refreshToken,
      expires: input.expiresAt,
      ...(input.accountId ? { accountId: input.accountId } : {}),
    },
  };
  await fs.writeFile(authFile, JSON.stringify(nextAuth, null, 2), "utf-8");
  await fs.chmod(authFile, 0o600).catch(() => undefined);

  return {
    env: {
      [PI_CODING_AGENT_DIR_ENV]: piAgentDir,
      [PAPERCLIP_MANAGED_PI_AGENT_DIR_ENV]: piAgentDir,
    },
    home: agentHome,
  };
}

export async function resolveCredentialEnv(
  db: Db,
  agentId: string,
  credentialId: string,
  adapterType?: string,
): Promise<{ env: Record<string, string>; home?: string }> {
  const [cred] = await db
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.id, credentialId))
    .limit(1);

  if (!cred) {
    logger.warn({ agentId, credentialId }, "credential not found during runtime resolution");
    return { env: {} };
  }

  let payload: Record<string, unknown>;
  try {
    payload = decryptPayload(cred);
  } catch (err) {
    logger.error(
      { agentId, credentialId, err: err instanceof Error ? err.message : String(err) },
      "failed to decrypt credential for runtime resolution",
    );
    return { env: {} };
  }

  switch (cred.type) {
    case "claude_oauth": {
      const accessToken = typeof payload.accessToken === "string" ? payload.accessToken : "";
      if (!accessToken) {
        logger.warn({ agentId, credentialId }, "claude_oauth credential missing accessToken");
        return { env: {} };
      }
      // Detect long-lived tokens (from `claude setup-token`). They have no
      // refreshToken / expiresAt of their own, so we synthesise a far-future
      // expiry below. We still write `.credentials.json` because the interactive
      // TUI (claude_tui adapter) ignores CLAUDE_CODE_OAUTH_TOKEN and only reads
      // the credentials file. We additionally expose the env var as a redundant
      // fallback for the headless claude_local path.
      const tokenKind = typeof payload.tokenKind === "string" ? payload.tokenKind : null;
      const isLongLivedToken =
        tokenKind === "long_lived" || (accessToken.startsWith("sk-ant-oat") && !payload.refreshToken);
      const refreshToken = typeof payload.refreshToken === "string" ? payload.refreshToken : "";
      const expiresAt = typeof payload.expiresAt === "number" ? payload.expiresAt : 4102444800000;
      const scopes = Array.isArray(payload.scopes) && payload.scopes.every((s) => typeof s === "string")
        ? (payload.scopes as string[])
        : ["user:inference", "user:profile", "user:sessions:claude_code", "user:file_upload", "user:mcp_servers"];
      const subscriptionType = typeof payload.subscriptionType === "string" ? payload.subscriptionType : "max";
      const oauth: Record<string, unknown> = { accessToken, refreshToken, expiresAt, scopes, subscriptionType };
      if (typeof payload.rateLimitTier === "string") oauth.rateLimitTier = payload.rateLimitTier;

      const agentHome = path.join(resolvePaperclipInstanceRoot(), "agent-homes", agentId);
      const claudeDir = path.join(agentHome, ".claude");
      await fs.mkdir(claudeDir, { recursive: true });
      const credFile = path.join(claudeDir, ".credentials.json");
      await fs.writeFile(credFile, JSON.stringify({ claudeAiOauth: oauth }), "utf-8");
      await fs.chmod(credFile, 0o600).catch(() => undefined);

      // Pre-seed ~/.claude.json so the interactive TUI skips its first-run
      // onboarding wizard (theme picker → login picker → OAuth paste). The
      // headless --print path doesn't read this file, but the TUI does. Merge
      // with any existing file in case the adapter has already written a
      // per-project trust entry alongside.
      const globalConfigFile = path.join(agentHome, ".claude.json");
      let existingGlobalConfig: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(globalConfigFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          existingGlobalConfig = parsed as Record<string, unknown>;
        }
      } catch {
        // missing or unreadable — start fresh
      }
      const globalConfig: Record<string, unknown> = {
        ...existingGlobalConfig,
        hasCompletedOnboarding: true,
        lastOnboardingVersion: "2.1.141",
      };
      await fs.writeFile(globalConfigFile, JSON.stringify(globalConfig), "utf-8");
      await fs.chmod(globalConfigFile, 0o600).catch(() => undefined);

      // Pre-seed ~/.claude/settings.json so the interactive TUI skips the
      // "Bypass Permissions mode — Yes, I accept" dialog that fires when
      // --dangerously-skip-permissions is passed, and the auto-mode opt-in
      // dialog. These keys are normally written when the user clicks accept
      // (see binary: `m6("userSettings",{skipDangerousModePermissionPrompt:!0})`).
      const settingsFile = path.join(claudeDir, "settings.json");
      let existingSettings: Record<string, unknown> = {};
      try {
        const raw = await fs.readFile(settingsFile, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          existingSettings = parsed as Record<string, unknown>;
        }
      } catch {
        // missing — start fresh
      }
      const settings: Record<string, unknown> = {
        ...existingSettings,
        skipDangerousModePermissionPrompt: true,
        skipAutoPermissionPrompt: true,
      };
      await fs.writeFile(settingsFile, JSON.stringify(settings), "utf-8");
      await fs.chmod(settingsFile, 0o600).catch(() => undefined);

      logger.info(
        { agentId, credentialId, credFile, hasRefreshToken: refreshToken.length > 0, isLongLivedToken, subscriptionType },
        "wrote claude_oauth credentials.json for agent",
      );
      // Deliberately NOT setting CLAUDE_CODE_OAUTH_TOKEN: when both the env var
      // and a credentials file are present, the interactive TUI auto-pastes
      // the env var into its OAuth-code dialog and rejects it as "Invalid code"
      // instead of reading the file. The file is the canonical credential.
      return { env: { HOME: agentHome }, home: agentHome };
    }

    case "claude_api_key": {
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
      if (!apiKey) {
        logger.warn({ agentId, credentialId }, "claude_api_key credential missing apiKey");
        return { env: {} };
      }
      return { env: { ANTHROPIC_API_KEY: apiKey } };
    }

    case "codex_oauth": {
      const accessToken = typeof payload.accessToken === "string" ? payload.accessToken : "";
      if (!accessToken) {
        logger.warn({ agentId, credentialId }, "codex_oauth credential missing accessToken");
        return { env: {} };
      }
      const refreshToken = typeof payload.refreshToken === "string" ? payload.refreshToken : "";
      const idToken = typeof payload.idToken === "string" ? payload.idToken : "";
      // Backfill account_id from the id_token JWT for credentials captured before
      // JWT decoding existed (or where device-auth omitted it). Without the
      // account_id OpenAI can't see the ChatGPT Pro entitlement and rejects
      // privileged models (e.g. gpt-5.3-codex) as "not supported".
      const accountId =
        resolveCodexAccountId({
          accountId: typeof payload.accountId === "string" ? payload.accountId : null,
          idToken: idToken || null,
          accessToken: accessToken || null,
        }) ?? "";
      const lastRefresh = typeof payload.lastRefresh === "string" ? payload.lastRefresh : new Date().toISOString();

      if (adapterType && PI_LOCAL_ADAPTER_TYPES.has(adapterType)) {
        const expiresAt = typeof payload.expiresAt === "number" ? payload.expiresAt : 4102444800000;
        const piAuth = await writePiCodexAuth({
          agentId,
          accessToken,
          refreshToken,
          expiresAt,
          accountId,
        });
        logger.info(
          { agentId, credentialId, piAgentDir: piAuth.env[PI_CODING_AGENT_DIR_ENV], hasRefreshToken: refreshToken.length > 0, hasAccountId: accountId.length > 0 },
          "wrote pi openai-codex auth.json for agent",
        );
        return piAuth;
      }

      const tokens: Record<string, string> = { access_token: accessToken };
      if (idToken) tokens.id_token = idToken;
      if (refreshToken) tokens.refresh_token = refreshToken;
      if (accountId) tokens.account_id = accountId;
      const authFile: Record<string, unknown> = {
        OPENAI_API_KEY: null,
        tokens,
        last_refresh: lastRefresh,
      };

      const agentHome = path.join(resolvePaperclipInstanceRoot(), "agent-homes", agentId);
      const codexDir = path.join(agentHome, ".codex");
      await fs.mkdir(codexDir, { recursive: true });
      const credFile = path.join(codexDir, "auth.json");
      await fs.writeFile(credFile, JSON.stringify(authFile), "utf-8");
      await fs.chmod(credFile, 0o600).catch(() => undefined);
      logger.info(
        { agentId, credentialId, credFile, hasRefreshToken: refreshToken.length > 0, hasAccountId: accountId.length > 0 },
        "wrote codex_oauth auth.json for agent",
      );
      return { env: { CODEX_HOME: codexDir, HOME: agentHome }, home: agentHome };
    }

    case "gemini_api_key": {
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
      if (!apiKey) {
        logger.warn({ agentId, credentialId }, "gemini_api_key credential missing apiKey");
        return { env: {} };
      }
      return { env: { GEMINI_API_KEY: apiKey, GOOGLE_API_KEY: apiKey } };
    }

    case "openai_api_key": {
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
      if (!apiKey) {
        logger.warn({ agentId, credentialId }, "openai_api_key credential missing apiKey");
        return { env: {} };
      }
      return { env: { OPENAI_API_KEY: apiKey, CURSOR_API_KEY: apiKey } };
    }

    case "openrouter_api_key": {
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
      if (!apiKey) {
        logger.warn({ agentId, credentialId }, "openrouter_api_key credential missing apiKey");
        return { env: {} };
      }
      return { env: { OPENROUTER_API_KEY: apiKey } };
    }

    case "deepseek_api_key": {
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
      if (!apiKey) {
        logger.warn({ agentId, credentialId }, "deepseek_api_key credential missing apiKey");
        return { env: {} };
      }
      // Same key, two consumers: the deepseek_api chat adapter reads
      // DEEPSEEK_API_KEY, while a Claude Code CLI agent (claude_local/claude_tui)
      // needs the ANTHROPIC_* env that routes it through DeepSeek's
      // Anthropic-compatible endpoint.
      if (adapterType && CLAUDE_CODE_ADAPTER_TYPES.has(adapterType)) {
        return { env: buildDeepSeekClaudeCodeEnv(apiKey, payload) };
      }
      return { env: { DEEPSEEK_API_KEY: apiKey } };
    }

    case "mimo_api_key": {
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey.trim() : "";
      if (!apiKey) {
        logger.warn({ agentId, credentialId }, "mimo_api_key credential missing apiKey");
        return { env: {} };
      }
      // MiMo has two consumers: Claude Code uses Xiaomi's Anthropic-compatible
      // endpoint, while Pi reads the Token Plan key from its provider-specific
      // env var for provider xiaomi-token-plan-sgp.
      if (adapterType && CLAUDE_CODE_ADAPTER_TYPES.has(adapterType)) {
        return { env: buildMimoClaudeCodeEnv(apiKey, payload) };
      }
      if (adapterType && PI_LOCAL_ADAPTER_TYPES.has(adapterType)) {
        return { env: { XIAOMI_TOKEN_PLAN_SGP_API_KEY: apiKey } };
      }
      logger.warn(
        { agentId, credentialId, adapterType },
        "mimo_api_key bound to an adapter that does not consume MiMo credentials; no env injected",
      );
      return { env: {} };
    }

    default:
      logger.warn(
        { agentId, credentialId, type: cred.type },
        "unknown credential type during runtime resolution",
      );
      return { env: {} };
  }
}

const HOME_OWNER_CREDENTIAL_TYPES = new Set(["claude_oauth", "codex_oauth"]);

/**
 * Default cooldown applied to a credential that hit a rate/quota limit when the
 * provider did not send a usable Retry-After header.
 */
export const CREDENTIAL_DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Shorter cooldown for a non-rate-limit credential failure (bad/expired key,
 * provider rejection). These aren't time-windowed like a 429, but we still park
 * the credential briefly so the next run rotates to a different one instead of
 * immediately retrying the same bad key.
 */
export const CREDENTIAL_FAILURE_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * Escalating cooldown ladder for a credential that keeps hitting its provider
 * rate/usage limit (e.g. Claude's 5-hour window). The Nth consecutive limit hit
 * parks the credential for ladder[min(N-1, last)] — 30min, then 2h, then 2h
 * thereafter. A provider Retry-After (when sent) is NOT used to delay the AGENT
 * (it would idle for hours); it only informs how long THIS credential rests,
 * and we cap that at the ladder so a different bound credential is tried first.
 * Rate-limits never freeze — they self-recover when the window resets.
 */
export const CREDENTIAL_RATE_LIMIT_COOLDOWN_LADDER_MS = [
  30 * 60 * 1000, //  1st: 30 min
  2 * 60 * 60 * 1000, // 2nd: 2 h
  2 * 60 * 60 * 1000, // 3rd+: 2 h (a real limit is never > ~5h, so 2h always re-checks in time)
] as const;

/**
 * After this many CONSECUTIVE AUTH/credential failures (bad/expired/invalid key,
 * provider rejection — NOT rate-limits), the credential is frozen (disabled +
 * flagged) so the board fixes it. Rate-limits are excluded: they escalate
 * cooldown forever and self-recover, they never freeze a good key.
 */
export const CREDENTIAL_DISABLE_THRESHOLD = 3;

/**
 * Adapter error codes / families that indicate the CREDENTIAL is at fault (so
 * rotating to another credential of the same type may help): rate/quota limits,
 * auth failures (bad/expired/invalid key), and provider rejections. Deliberately
 * does NOT include agent-logic errors, timeouts, or max-turns — another key
 * won't fix those.
 */
const CREDENTIAL_FAILURE_ERROR_CODES = new Set<string>([
  // auth / bad key
  "claude_auth_required",
  "codex_auth_required",
  "deepseek_api_key_missing",
  "mimo_api_key_missing",
  // provider rejection (e.g. MiMo rejecting a model id, 400 param errors)
  "deepseek_api_request_failed",
]);

/**
 * Classify whether a finished run's failure is credential-related (→ rotate to
 * another credential of the same type) vs not (→ stay; another key won't help).
 * `transient_upstream` (rate/quota/overload) always counts; otherwise we match
 * known auth/rejection error codes, or HTTP-style 401/403/400 signatures in the
 * error message as a fallback.
 */
export function isCredentialFailure(input: {
  errorFamily?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}): boolean {
  if (input.errorFamily === "transient_upstream") return true;
  const code = typeof input.errorCode === "string" ? input.errorCode : "";
  if (code && CREDENTIAL_FAILURE_ERROR_CODES.has(code)) return true;
  const msg = (input.errorMessage ?? "").toLowerCase();
  if (!msg) return false;
  return (
    /\b401\b|\b403\b|\b400\b/.test(msg) ||
    /unauthorized|forbidden|invalid api key|invalid_api_key|invalid key|authentication|expired|param incorrect|not supported model|invalid_request_error/.test(
      msg,
    )
  );
}

/**
 * Provider credential types each adapter authenticates with. Used to map a
 * failed run (known by its adapterType) back to the specific credential the run
 * consumed, so a reactive cooldown lands on the right rotation-pool member.
 * Mirrors the UI's credentialTypesForAdapterType in AgentConfigForm.
 */
const ADAPTER_CREDENTIAL_TYPES: Record<string, readonly string[]> = {
  claude_local: ["claude_oauth", "claude_api_key", "deepseek_api_key", "mimo_api_key"],
  claude_tui: ["claude_oauth", "claude_api_key", "deepseek_api_key", "mimo_api_key"],
  gemini_local: ["gemini_api_key"],
  codex_local: ["codex_oauth", "openai_api_key"],
  cursor: ["openai_api_key"],
  deepseek_api: ["deepseek_api_key"],
  opencode_local: ["openrouter_api_key", "openai_api_key", "claude_api_key", "gemini_api_key"],
  acpx_local: ["claude_oauth", "claude_api_key", "codex_oauth", "openai_api_key"],
  pi_local: [
    "codex_oauth",
    "openai_api_key",
    "deepseek_api_key",
    "mimo_api_key",
    "openrouter_api_key",
    "claude_api_key",
    "gemini_api_key",
  ],
};

export function credentialTypesForAdapterType(adapterType: string): readonly string[] {
  return ADAPTER_CREDENTIAL_TYPES[adapterType] ?? [];
}

function credentialTypesForAdapterRuntime(
  adapterType: string,
  adapterConfig: Record<string, unknown> | null | undefined,
): readonly string[] {
  if (adapterType !== "acpx_local") return credentialTypesForAdapterType(adapterType);

  const acpxAgent = readCredentialConfigString(adapterConfig, "agent") ?? "claude";
  if (acpxAgent === "claude") return ["claude_oauth", "claude_api_key"];
  if (acpxAgent === "codex") return ["codex_oauth", "openai_api_key"];
  return credentialTypesForAdapterType(adapterType);
}

function isCodexCredentialRuntime(input: {
  adapterType: string | null | undefined;
  adapterConfig: Record<string, unknown> | null | undefined;
}): boolean {
  if (input.adapterType === "codex_local") return true;
  if (input.adapterType !== "acpx_local") return false;
  return readCredentialConfigString(input.adapterConfig, "agent") === "codex";
}

export function validateCredentialSelectionForAdapter(input: {
  adapterType: string | null | undefined;
  adapterConfig?: Record<string, unknown> | null;
  credentials: CredentialSelectionRow[];
}): CredentialAssignmentValidationResult {
  if (!isCodexCredentialRuntime({
    adapterType: input.adapterType,
    adapterConfig: input.adapterConfig ?? null,
  })) {
    return { ok: true, credentials: [] };
  }

  const selectedTypes = new Set(input.credentials.map((credential) => credential.type));
  if (selectedTypes.has("codex_oauth") && selectedTypes.has("openai_api_key")) {
    return {
      ok: false,
      error: "mixed_codex_auth_modes",
      message:
        "Codex agents must use one auth mode at a time. Select either Codex OAuth credentials for ChatGPT login rotation or OpenAI API-key credentials, not both.",
    };
  }

  return { ok: true, credentials: [] };
}

export type ResolvedCredentialChoice = { credentialId: string; type: string };

function hasNonEmptyEnvValue(env: Record<string, unknown>, key: string): boolean {
  const raw = env[key];
  return typeof raw === "string" && raw.trim().length > 0;
}

function readAnthropicBaseUrl(env: Record<string, unknown>): string {
  const raw = env.ANTHROPIC_BASE_URL;
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function anthropicBaseUrlUsesDeepSeek(env: Record<string, unknown>): boolean {
  const base = readAnthropicBaseUrl(env);
  return base.includes("api.deepseek.com") || base.includes("deepseek.com/anthropic");
}

function anthropicBaseUrlUsesMimo(env: Record<string, unknown>): boolean {
  return readAnthropicBaseUrl(env).includes("xiaomimimo.com");
}

const PI_PROVIDER_CREDENTIAL_TYPES: Record<string, readonly string[]> = {
  "openai-codex": ["codex_oauth"],
  openai: ["openai_api_key"],
  deepseek: ["deepseek_api_key"],
  "xiaomi-token-plan-sgp": ["mimo_api_key"],
  openrouter: ["openrouter_api_key"],
  anthropic: ["claude_api_key"],
  google: ["gemini_api_key"],
};

const PI_CREDENTIAL_ENV_KEYS: Record<string, readonly string[]> = {
  codex_oauth: [PI_CODING_AGENT_DIR_ENV],
  openai_api_key: ["OPENAI_API_KEY"],
  deepseek_api_key: ["DEEPSEEK_API_KEY"],
  mimo_api_key: ["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
  openrouter_api_key: ["OPENROUTER_API_KEY"],
  claude_api_key: ["ANTHROPIC_API_KEY"],
  gemini_api_key: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
};

function readPiModelProvider(adapterConfig: Record<string, unknown> | null | undefined): string | null {
  const model = readCredentialConfigString(adapterConfig, "model");
  if (!model) return null;
  const slash = model.indexOf("/");
  if (slash <= 0) return null;
  return model.slice(0, slash).trim() || null;
}

function piChoiceHasRuntimeEnv(choice: ResolvedCredentialChoice, env: Record<string, unknown>): boolean {
  const keys = PI_CREDENTIAL_ENV_KEYS[choice.type] ?? [];
  return keys.some((key) => hasNonEmptyEnvValue(env, key));
}

function selectPiActiveCredential(input: {
  adapterConfig: Record<string, unknown> | null | undefined;
  chosen: ResolvedCredentialChoice[];
  env: Record<string, unknown>;
}): ResolvedCredentialChoice | null {
  const provider = readPiModelProvider(input.adapterConfig);
  if (provider) {
    const providerTypes = PI_PROVIDER_CREDENTIAL_TYPES[provider];
    if (providerTypes) {
      return input.chosen.find((choice) => providerTypes.includes(choice.type) && piChoiceHasRuntimeEnv(choice, input.env)) ?? null;
    }
  }

  return input.chosen.find((choice) => piChoiceHasRuntimeEnv(choice, input.env)) ?? null;
}

function selectClaudeCodeActiveCredential(input: {
  chosen: ResolvedCredentialChoice[];
  env: Record<string, unknown>;
}): ResolvedCredentialChoice | null {
  if (anthropicBaseUrlUsesDeepSeek(input.env)) {
    return hasNonEmptyEnvValue(input.env, "ANTHROPIC_AUTH_TOKEN")
      ? input.chosen.find((choice) => choice.type === "deepseek_api_key") ?? null
      : null;
  }

  if (anthropicBaseUrlUsesMimo(input.env)) {
    return hasNonEmptyEnvValue(input.env, "ANTHROPIC_AUTH_TOKEN")
      ? input.chosen.find((choice) => choice.type === "mimo_api_key") ?? null
      : null;
  }

  if (hasNonEmptyEnvValue(input.env, "ANTHROPIC_API_KEY")) {
    return input.chosen.find((choice) => choice.type === "claude_api_key") ?? null;
  }

  if (hasNonEmptyEnvValue(input.env, "HOME")) {
    return input.chosen.find((choice) => choice.type === "claude_oauth") ?? null;
  }

  return input.chosen[0] ?? null;
}

/**
 * Attribute a run to the managed credential that the adapter will actually use.
 * Codex is special because an API key wins over native CODEX_HOME auth, and
 * current Codex reads that key from auth.json rather than directly from env.
 * Pi is provider-scoped: the model prefix decides which assigned credential type
 * is consumed, so we must avoid attributing a DeepSeek Pi run to an OpenAI key
 * that happened to be assigned to the same agent.
 */
export function selectActiveCredentialForAdapter(input: {
  adapterType: string;
  adapterConfig?: Record<string, unknown> | null;
  chosen: ResolvedCredentialChoice[];
  env: Record<string, unknown>;
}): ResolvedCredentialChoice | null {
  const adapterConfig = input.adapterConfig ?? null;
  const eligibleTypes = new Set(credentialTypesForAdapterRuntime(input.adapterType, adapterConfig));
  const eligible = input.chosen.filter((choice) => eligibleTypes.has(choice.type));

  if (CLAUDE_CODE_ADAPTER_TYPES.has(input.adapterType)) {
    return selectClaudeCodeActiveCredential({
      chosen: eligible,
      env: input.env,
    });
  }

  if (isCodexCredentialRuntime({ adapterType: input.adapterType, adapterConfig })) {
    const openAiChoice = eligible.find((choice) => choice.type === "openai_api_key") ?? null;
    if (hasNonEmptyEnvValue(input.env, "OPENAI_API_KEY")) return openAiChoice;

    const codexOAuthChoice = eligible.find((choice) => choice.type === "codex_oauth") ?? null;
    if (hasNonEmptyEnvValue(input.env, "CODEX_HOME")) return codexOAuthChoice;
  }

  if (input.adapterType === "pi_local") {
    return selectPiActiveCredential({
      adapterConfig,
      chosen: eligible,
      env: input.env,
    });
  }

  return eligible[0] ?? input.chosen[0] ?? null;
}

type RotationCandidate = {
  credentialId: string;
  type: string;
  cooldownUntil: Date | null;
  lastUsedAt: Date | null;
  updatedAt: Date;
};

const QUOTA_AWARE_CREDENTIAL_TYPES = new Set<CredentialType>(["claude_oauth", "codex_oauth"]);
const UNKNOWN_QUOTA_PRESSURE = 75;
const QUOTA_PRESSURE_BUCKET_SIZE = 10;

function isQuotaAwareCredentialType(type: string): type is Extract<CredentialType, "claude_oauth" | "codex_oauth"> {
  return QUOTA_AWARE_CREDENTIAL_TYPES.has(type as CredentialType);
}

function quotaPressureFromWindows(windows: QuotaWindow[]): number | null {
  let pressure: number | null = null;
  for (const window of windows) {
    if (window.usedPercent == null || !Number.isFinite(window.usedPercent)) continue;
    const usedPercent = Math.max(0, Math.min(100, window.usedPercent));
    pressure = pressure == null ? usedPercent : Math.max(pressure, usedPercent);
  }
  return pressure;
}

function quotaPressureForCandidate(candidate: RotationCandidate, nowMs: number): number | null {
  if (!isQuotaAwareCredentialType(candidate.type)) return null;
  const cached = getReusableQuotaCache({
    id: candidate.credentialId,
    type: candidate.type,
    updatedAt: candidate.updatedAt,
  }, nowMs);
  if (!cached) return UNKNOWN_QUOTA_PRESSURE;
  return quotaPressureFromWindows(cached.quotaWindows) ?? UNKNOWN_QUOTA_PRESSURE;
}

/**
 * Pick one credential from a same-type pool: prefer credentials not on cooldown,
 * and among those the least-recently-used (null lastUsedAt = never used = first).
 * If every candidate is cooling down, fall back to the one whose cooldown expires
 * soonest so the agent can still attempt a run rather than be wedged.
 */
function pickPoolCredential(candidates: RotationCandidate[], nowMs: number): RotationCandidate {
  const byLru = (a: RotationCandidate, b: RotationCandidate) =>
    (a.lastUsedAt ? a.lastUsedAt.getTime() : 0) - (b.lastUsedAt ? b.lastUsedAt.getTime() : 0);
  const available = candidates.filter(
    (c) => !c.cooldownUntil || c.cooldownUntil.getTime() <= nowMs,
  );
  if (available.length > 0) {
    const ranked = available.map((candidate) => ({
      candidate,
      pressure: quotaPressureForCandidate(candidate, nowMs),
    }));
    if (ranked.every((entry) => entry.pressure == null)) return [...available].sort(byLru)[0];
    return [...ranked].sort((a, b) => {
      const aPressure = a.pressure ?? UNKNOWN_QUOTA_PRESSURE;
      const bPressure = b.pressure ?? UNKNOWN_QUOTA_PRESSURE;
      const aBucket = Math.floor(aPressure / QUOTA_PRESSURE_BUCKET_SIZE);
      const bBucket = Math.floor(bPressure / QUOTA_PRESSURE_BUCKET_SIZE);
      return aBucket - bBucket || byLru(a.candidate, b.candidate);
    })[0].candidate;
  }
  return [...candidates].sort(
    (a, b) => (a.cooldownUntil?.getTime() ?? 0) - (b.cooldownUntil?.getTime() ?? 0),
  )[0];
}

async function touchCredentialLastUsed(db: Db, credentialId: string): Promise<void> {
  await db
    .update(providerCredentials)
    .set({ lastUsedAt: new Date() })
    .where(eq(providerCredentials.id, credentialId));
}

/**
 * Put a credential on cooldown after an upstream rate/quota limit. The heartbeat
 * picker skips it until `cooldownUntil`, rotating the agent to another bound
 * credential of the same provider type.
 */
export async function setCredentialCooldown(
  db: Db,
  credentialId: string,
  cooldownUntil: Date,
  reason: string | null,
): Promise<void> {
  await db
    .update(providerCredentials)
    .set({ cooldownUntil, cooldownReason: reason, updatedAt: new Date() })
    .where(eq(providerCredentials.id, credentialId));
}

export type CredentialFailureKind = "rate_limit" | "auth";

/**
 * Record a credential-related run FAILURE and apply the right policy.
 *
 * `rate_limit` (provider usage/quota window, e.g. Claude's 5-hour limit):
 *   escalating cooldown per CREDENTIAL_RATE_LIMIT_COOLDOWN_LADDER_MS
 *   (30min → 2h → 2h…); NEVER frozen — it self-recovers when the window resets.
 *   The provider's Retry-After, when given, sets a floor on the cooldown but is
 *   capped at the ladder rung so the agent rotates to another key rather than
 *   idling for hours.
 *
 * `auth` (bad/expired/invalid key, provider rejection): short fixed cooldown,
 *   and FROZEN (disabled + flagged) after CREDENTIAL_DISABLE_THRESHOLD
 *   consecutive failures so the board fixes it.
 *
 * The consecutive-failure counter is shared (a success resets it); auth failures
 * are what trip the freeze threshold, rate-limits only escalate the cooldown.
 */
export async function recordCredentialFailure(
  db: Db,
  credentialId: string,
  opts: { kind: CredentialFailureKind; reason: string | null; providerRetryAfter?: Date | null },
): Promise<{ disabled: boolean; failureCount: number; cooldownUntil: Date }> {
  const [current] = await db
    .select({ count: providerCredentials.consecutiveFailureCount })
    .from(providerCredentials)
    .where(eq(providerCredentials.id, credentialId))
    .limit(1);
  const nextCount = (current?.count ?? 0) + 1;
  const now = new Date();

  let cooldownMs: number;
  if (opts.kind === "rate_limit") {
    const ladder = CREDENTIAL_RATE_LIMIT_COOLDOWN_LADDER_MS;
    const rung = ladder[Math.min(nextCount - 1, ladder.length - 1)];
    // Honor Retry-After as a floor, but cap at the rung so we don't idle the
    // agent for the provider's full multi-hour window when another key exists.
    const retryAfterMs =
      opts.providerRetryAfter && opts.providerRetryAfter.getTime() > now.getTime()
        ? opts.providerRetryAfter.getTime() - now.getTime()
        : 0;
    cooldownMs = Math.min(Math.max(rung, retryAfterMs), ladder[ladder.length - 1]);
  } else {
    cooldownMs = CREDENTIAL_FAILURE_COOLDOWN_MS;
  }
  const cooldownUntil = new Date(now.getTime() + cooldownMs);

  // Only AUTH failures freeze; rate-limits escalate cooldown forever.
  const shouldDisable = opts.kind === "auth" && nextCount >= CREDENTIAL_DISABLE_THRESHOLD;

  await db
    .update(providerCredentials)
    .set({
      cooldownUntil,
      cooldownReason: opts.reason,
      consecutiveFailureCount: nextCount,
      ...(shouldDisable
        ? {
            disabledAt: now,
            disabledReason: `Frozen after ${nextCount} consecutive auth failures: ${opts.reason ?? "credential error"}`,
          }
        : {}),
      updatedAt: now,
    })
    .where(eq(providerCredentials.id, credentialId));
  return { disabled: shouldDisable, failureCount: nextCount, cooldownUntil };
}

/**
 * Does this agent have ANOTHER usable (not cooling, not disabled) credential of
 * the given provider type, besides `excludeCredentialId`? Used to decide whether
 * a failed run should be retried immediately (seamless switch to the other key)
 * or just cooled down to wait. Strictly same-type — providers never cross.
 */
export async function hasAlternateCredentialOfType(
  db: Db,
  agentId: string,
  type: string,
  excludeCredentialId: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: agentCredentials.credentialId })
    .from(agentCredentials)
    .innerJoin(providerCredentials, eq(agentCredentials.credentialId, providerCredentials.id))
    .where(
      and(
        eq(agentCredentials.agentId, agentId),
        eq(providerCredentials.type, type),
        isNull(providerCredentials.disabledAt),
      ),
    );
  // A still-cooling alternate counts — the picker prefers non-cooling but will
  // fall back to the soonest-recovering one, which is still better than retrying
  // the just-failed key.
  return rows.some((r) => r.id !== excludeCredentialId);
}

/**
 * Record a SUCCESSFUL run for a credential: reset the consecutive-failure
 * counter so a transient blip doesn't accumulate toward auto-disable. (Does not
 * clear an active cooldown — that expires on its own.)
 */
export async function recordCredentialSuccess(db: Db, credentialId: string): Promise<void> {
  await db
    .update(providerCredentials)
    .set({ consecutiveFailureCount: 0, updatedAt: new Date() })
    .where(and(eq(providerCredentials.id, credentialId), gt(providerCredentials.consecutiveFailureCount, 0)));
}

type CodexDiskTokens = {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  accountId: string;
  expiresAt: number | null;
  updatedAtMs: number;
};

async function fileUpdatedAtMs(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).mtimeMs;
  } catch {
    return 0;
  }
}

async function readCodexCliDiskTokens(agentId: string): Promise<CodexDiskTokens | null> {
  const authPath = path.join(resolvePaperclipInstanceRoot(), "agent-homes", agentId, ".codex", "auth.json");
  const parsed = await readJsonObjectFile(authPath);
  const tokens =
    parsed.tokens && typeof parsed.tokens === "object" && !Array.isArray(parsed.tokens)
      ? (parsed.tokens as Record<string, unknown>)
      : {};
  const accessToken = typeof tokens.access_token === "string" ? tokens.access_token : "";
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: typeof tokens.refresh_token === "string" ? tokens.refresh_token : "",
    idToken: typeof tokens.id_token === "string" ? tokens.id_token : "",
    accountId: typeof tokens.account_id === "string" ? tokens.account_id : "",
    expiresAt: null,
    updatedAtMs: await fileUpdatedAtMs(authPath),
  };
}

async function readPiCodexDiskTokens(agentId: string): Promise<CodexDiskTokens | null> {
  const authPath = path.join(piAgentDirForAgent(agentId), "auth.json");
  const parsed = await readJsonObjectFile(authPath);
  const entry =
    parsed[PI_OPENAI_CODEX_PROVIDER_ID] &&
    typeof parsed[PI_OPENAI_CODEX_PROVIDER_ID] === "object" &&
    !Array.isArray(parsed[PI_OPENAI_CODEX_PROVIDER_ID])
      ? (parsed[PI_OPENAI_CODEX_PROVIDER_ID] as Record<string, unknown>)
      : {};
  const accessToken = typeof entry.access === "string" ? entry.access : "";
  if (!accessToken) return null;
  return {
    accessToken,
    refreshToken: typeof entry.refresh === "string" ? entry.refresh : "",
    idToken: typeof entry.idToken === "string" ? entry.idToken : "",
    accountId: typeof entry.accountId === "string" ? entry.accountId : "",
    expiresAt: typeof entry.expires === "number" && Number.isFinite(entry.expires) ? entry.expires : null,
    updatedAtMs: await fileUpdatedAtMs(authPath),
  };
}

/**
 * After a codex run, the Codex CLI may have refreshed the OAuth token in place at
 * `agent-homes/<agentId>/.codex/auth.json`. Pi runs can also refresh the same
 * OpenAI Codex OAuth token in its managed `agent-homes/<agentId>/.pi/agent/auth.json`.
 * Persist refreshed access/refresh tokens back to the DB credential so the next
 * run uses a live token instead of the stored-and-stale one (the intermittent
 * "works then stops working" cause).
 *
 * OpenAI drops chatgpt_account_id from the refreshed access_token, so we preserve
 * the stored account_id (and re-derive from the id_token if needed). Only writes
 * when the access_token actually changed, to avoid needless churn. Best-effort:
 * any error is swallowed by the caller.
 */
export async function persistCodexRefreshedTokens(
  db: Db,
  agentId: string,
  credentialId: string,
): Promise<{ updated: boolean }> {
  const [cred] = await db
    .select()
    .from(providerCredentials)
    .where(eq(providerCredentials.id, credentialId))
    .limit(1);
  if (!cred || cred.type !== "codex_oauth") return { updated: false };

  const stored = decryptPayload(cred);
  const storedAccess = typeof stored.accessToken === "string" ? stored.accessToken : "";
  const disk = (await Promise.all([
    readCodexCliDiskTokens(agentId),
    readPiCodexDiskTokens(agentId),
  ]))
    .filter((candidate): candidate is CodexDiskTokens => candidate != null)
    .filter((candidate) => candidate.accessToken !== storedAccess)
    .sort((a, b) => b.updatedAtMs - a.updatedAtMs)[0] ?? null;
  if (!disk) return { updated: false }; // CLI/Pi didn't refresh — nothing to do

  const storedId = typeof stored.idToken === "string" ? stored.idToken : "";
  // Keep the id_token (and thus account_id source) if the refresh dropped it.
  const effectiveIdToken = disk.idToken || storedId;
  const accountId = resolveCodexAccountId({
    accountId: disk.accountId || (typeof stored.accountId === "string" ? stored.accountId : null),
    idToken: effectiveIdToken || null,
    accessToken: disk.accessToken || null,
  });

  const nextPayload: Record<string, unknown> = { ...stored, accessToken: disk.accessToken };
  if (disk.refreshToken) nextPayload.refreshToken = disk.refreshToken;
  if (effectiveIdToken) nextPayload.idToken = effectiveIdToken;
  if (accountId) nextPayload.accountId = accountId;
  if (disk.expiresAt != null) nextPayload.expiresAt = disk.expiresAt;
  nextPayload.lastRefresh = new Date().toISOString();

  await db
    .update(providerCredentials)
    .set({ credential: encryptCredential(nextPayload), updatedAt: new Date() })
    .where(eq(providerCredentials.id, credentialId));
  return { updated: true };
}

/**
 * Resolve env for an agent's bound credentials, ONE per provider type. When an
 * agent binds several credentials of the same type they form a rotation pool;
 * the least-recently-used non-cooling member is selected (see pickPoolCredential)
 * and its lastUsedAt is bumped. Falls back to the legacy `agents.credential_id`
 * singular FK when the join is empty so existing single-credential agents keep
 * working.
 *
 * Provider env vars do not collide across types (Anthropic / OpenAI / Gemini /
 * OpenRouter / DeepSeek each own distinct keys), but HOME is the one shared key —
 * if both claude_oauth and codex_oauth are chosen, the last write wins. Codex is
 * resolved last so CODEX_HOME + its HOME take precedence; the Claude CLI still
 * finds its .credentials.json via the agent-specific HOME path it shares.
 *
 * Returns `chosen` (the selected credentialId + type per provider type) so the
 * caller can attribute a run's usage and any rate-limit cooldown to the exact
 * credential it used.
 */
export async function resolveAllCredentialEnv(
  db: Db,
  agentId: string,
  adapterTypeOverride?: string | null,
  credentialIdAllowList?: string[] | null,
): Promise<{
  env: Record<string, string>;
  home?: string;
  credentialIds: string[];
  chosen: Array<{ credentialId: string; type: string }>;
}> {
  // adapterType decides how some credentials resolve (e.g. a deepseek_api_key on
  // a Claude Code agent routes the CLI through DeepSeek's Anthropic endpoint).
  const [agentRow] = await db
    .select({ credentialId: agents.credentialId, adapterType: agents.adapterType, companyId: agents.companyId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  const adapterType = adapterTypeOverride ?? agentRow?.adapterType ?? undefined;
  const allowedCredentialIds = credentialIdAllowList && credentialIdAllowList.length > 0
    ? new Set(credentialIdAllowList)
    : null;

  // Disabled credentials (auto-disabled after repeated failures, or manually)
  // are excluded from the rotation pool entirely — the picker never selects
  // them until the user re-enables them from the Credentials UI. Lock the pool
  // rows before picking/touching so concurrent heartbeats spread across LRU
  // candidates instead of racing on the same oldest credential.
  const chosenCandidates = await db.transaction(async (tx) => {
    await tx.execute(sql`
      select ${providerCredentials.id}
      from ${agentCredentials}
      inner join ${providerCredentials}
        on ${agentCredentials.credentialId} = ${providerCredentials.id}
      where ${agentCredentials.agentId} = ${agentId}
        and ${providerCredentials.disabledAt} is null
      for update of provider_credentials
    `);

    const joinRows = await tx
      .select({
        credentialId: agentCredentials.credentialId,
        type: providerCredentials.type,
        cooldownUntil: providerCredentials.cooldownUntil,
        lastUsedAt: providerCredentials.lastUsedAt,
        updatedAt: providerCredentials.updatedAt,
      })
      .from(agentCredentials)
      .innerJoin(providerCredentials, eq(agentCredentials.credentialId, providerCredentials.id))
      .where(and(eq(agentCredentials.agentId, agentId), isNull(providerCredentials.disabledAt)));
    const routeRows = allowedCredentialIds && agentRow?.companyId
      ? await tx
          .select({
            credentialId: providerCredentials.id,
            type: providerCredentials.type,
            cooldownUntil: providerCredentials.cooldownUntil,
            lastUsedAt: providerCredentials.lastUsedAt,
            updatedAt: providerCredentials.updatedAt,
          })
          .from(providerCredentials)
          .where(and(
            eq(providerCredentials.companyId, agentRow.companyId),
            inArray(providerCredentials.id, Array.from(allowedCredentialIds)),
            isNull(providerCredentials.disabledAt),
          ))
      : [];

    const nowMs = Date.now();
    const byType = new Map<string, RotationCandidate[]>();
    for (const row of [...joinRows, ...routeRows]) {
      if (allowedCredentialIds && !allowedCredentialIds.has(row.credentialId)) continue;
      const list = byType.get(row.type) ?? [];
      list.push(row);
      byType.set(row.type, list);
    }

    const picked: RotationCandidate[] = [];
    for (const list of byType.values()) {
      picked.push(pickPoolCredential(list, nowMs));
    }

    const lastUsedAt = new Date(nowMs);
    for (const candidate of picked) {
      await tx
        .update(providerCredentials)
        .set({ lastUsedAt })
        .where(eq(providerCredentials.id, candidate.credentialId));
    }

    return picked;
  });

  if (chosenCandidates.length === 0) {
    if (!agentRow?.credentialId) return { env: {}, credentialIds: [], chosen: [] };
    const [row] = await db
      .select({ type: providerCredentials.type, disabledAt: providerCredentials.disabledAt })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, agentRow.credentialId))
      .limit(1);
    if (!row) return { env: {}, credentialIds: [], chosen: [] };
    if (row.disabledAt) {
      logger.warn(
        { agentId, credentialId: agentRow.credentialId },
        "legacy agent credential is disabled; skipping runtime resolution",
      );
      return { env: {}, credentialIds: [], chosen: [] };
    }
    const res = await resolveCredentialEnv(db, agentId, agentRow.credentialId, adapterType);
    await touchCredentialLastUsed(db, agentRow.credentialId);
    return {
      env: res.env,
      home: res.home,
      credentialIds: [agentRow.credentialId],
      chosen: [{ credentialId: agentRow.credentialId, type: row.type }],
    };
  }

  // Resolve oauth (HOME-owning) types last so their HOME overrides take
  // precedence over any api-key types (which never set HOME).
  const ordered = [...chosenCandidates].sort((a, b) => {
    const aHome = HOME_OWNER_CREDENTIAL_TYPES.has(a.type) ? 1 : 0;
    const bHome = HOME_OWNER_CREDENTIAL_TYPES.has(b.type) ? 1 : 0;
    return aHome - bHome;
  });

  const env: Record<string, string> = {};
  let home: string | undefined;
  const credentialIds: string[] = [];
  const chosen: Array<{ credentialId: string; type: string }> = [];

  for (const candidate of ordered) {
    const res = await resolveCredentialEnv(db, agentId, candidate.credentialId, adapterType);
    Object.assign(env, res.env);
    if (res.home) home = res.home;
    credentialIds.push(candidate.credentialId);
    chosen.push({ credentialId: candidate.credentialId, type: candidate.type });
  }

  return { env, home, credentialIds, chosen };
}
