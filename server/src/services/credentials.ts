import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentCredentials, agents, costEvents, providerCredentials } from "@paperclipai/db";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { logger } from "../middleware/logger.js";
import {
  decryptCredential,
  encryptCredential,
  isEncryptedCredentialMaterial,
} from "./credential-encryption.js";

type CredentialRow = typeof providerCredentials.$inferSelect;
type SafeCredential = Omit<CredentialRow, "credential">;

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

export function credentialService(db: Db) {
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

      const [updated] = await db
        .update(providerCredentials)
        .set(updates)
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
    ): Promise<{ ok: true; credentials: SafeCredential[] } | { ok: false; error: "duplicate_type"; type: string } | { ok: false; error: "credential_not_found"; credentialId: string }> {
      const uniqueIds = Array.from(new Set(credentialIds));

      if (uniqueIds.length === 0) {
        await db.delete(agentCredentials).where(eq(agentCredentials.agentId, agentId));
        return { ok: true, credentials: [] };
      }

      const creds = await db
        .select()
        .from(providerCredentials)
        .where(inArray(providerCredentials.id, uniqueIds));

      if (creds.length !== uniqueIds.length) {
        const found = new Set(creds.map((c) => c.id));
        const missing = uniqueIds.find((id) => !found.has(id))!;
        return { ok: false, error: "credential_not_found", credentialId: missing };
      }

      await db.transaction(async (tx) => {
        await tx.delete(agentCredentials).where(eq(agentCredentials.agentId, agentId));
        await tx.insert(agentCredentials).values(uniqueIds.map((credentialId) => ({ agentId, credentialId })));
      });

      return { ok: true, credentials: creds.map(stripCredential) };
    },

    /**
     * Aggregate token/cost usage per managed credential for a company over a
     * trailing window, from cost_events.credentialId. Used by the Credentials
     * UI to show how much each credential (and each pool member) has spent.
     */
    async usageByCredential(
      companyId: string,
      sinceMs: number,
    ): Promise<
      Array<{
        credentialId: string;
        inputTokens: number;
        outputTokens: number;
        cachedInputTokens: number;
        costCents: number;
        events: number;
      }>
    > {
      const since = new Date(Date.now() - Math.max(0, sinceMs));
      const rows = await db
        .select({
          credentialId: costEvents.credentialId,
          inputTokens: sql<number>`coalesce(sum(${costEvents.inputTokens}), 0)`,
          outputTokens: sql<number>`coalesce(sum(${costEvents.outputTokens}), 0)`,
          cachedInputTokens: sql<number>`coalesce(sum(${costEvents.cachedInputTokens}), 0)`,
          costCents: sql<number>`coalesce(sum(${costEvents.costCents}), 0)`,
          events: sql<number>`count(*)`,
        })
        .from(costEvents)
        .where(
          and(
            eq(costEvents.companyId, companyId),
            gte(costEvents.occurredAt, since),
            isNotNull(costEvents.credentialId),
          ),
        )
        .groupBy(costEvents.credentialId);
      return rows
        .filter((r): r is typeof r & { credentialId: string } => r.credentialId != null)
        .map((r) => ({
          credentialId: r.credentialId,
          inputTokens: Number(r.inputTokens),
          outputTokens: Number(r.outputTokens),
          cachedInputTokens: Number(r.cachedInputTokens),
          costCents: Number(r.costCents),
          events: Number(r.events),
        }));
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
 * - `openai_api_key`: sets OPENAI_API_KEY (covers codex-local and cursor-local).
 * - `openrouter_api_key`: sets OPENROUTER_API_KEY (covers opencode-local).
 * - `deepseek_api_key`: sets DEEPSEEK_API_KEY (covers deepseek-api).
 */
export async function resolveCredentialEnv(
  db: Db,
  agentId: string,
  credentialId: string,
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
      const accountId = typeof payload.accountId === "string" ? payload.accountId : "";
      const lastRefresh = typeof payload.lastRefresh === "string" ? payload.lastRefresh : new Date().toISOString();
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
      const apiKey = typeof payload.apiKey === "string" ? payload.apiKey : "";
      if (!apiKey) {
        logger.warn({ agentId, credentialId }, "deepseek_api_key credential missing apiKey");
        return { env: {} };
      }
      return { env: { DEEPSEEK_API_KEY: apiKey } };
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
 * Provider credential types each adapter authenticates with. Used to map a
 * failed run (known by its adapterType) back to the specific credential the run
 * consumed, so a reactive cooldown lands on the right rotation-pool member.
 * Mirrors the UI's credentialTypesForAdapterType in AgentConfigForm.
 */
const ADAPTER_CREDENTIAL_TYPES: Record<string, readonly string[]> = {
  claude_local: ["claude_oauth", "claude_api_key"],
  claude_tui: ["claude_oauth", "claude_api_key"],
  gemini_local: ["gemini_api_key"],
  codex_local: ["codex_oauth", "openai_api_key"],
  cursor: ["openai_api_key"],
  deepseek_api: ["deepseek_api_key"],
  opencode_local: ["openrouter_api_key", "openai_api_key", "claude_api_key", "gemini_api_key"],
  acpx_local: ["claude_oauth", "claude_api_key", "codex_oauth", "openai_api_key"],
};

export function credentialTypesForAdapterType(adapterType: string): readonly string[] {
  return ADAPTER_CREDENTIAL_TYPES[adapterType] ?? [];
}

type RotationCandidate = {
  credentialId: string;
  type: string;
  cooldownUntil: Date | null;
  lastUsedAt: Date | null;
};

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
  if (available.length > 0) return [...available].sort(byLru)[0];
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
): Promise<{
  env: Record<string, string>;
  home?: string;
  credentialIds: string[];
  chosen: Array<{ credentialId: string; type: string }>;
}> {
  const joinRows = await db
    .select({
      credentialId: agentCredentials.credentialId,
      type: providerCredentials.type,
      cooldownUntil: providerCredentials.cooldownUntil,
      lastUsedAt: providerCredentials.lastUsedAt,
    })
    .from(agentCredentials)
    .innerJoin(providerCredentials, eq(agentCredentials.credentialId, providerCredentials.id))
    .where(eq(agentCredentials.agentId, agentId));

  if (joinRows.length === 0) {
    const [agent] = await db
      .select({ credentialId: agents.credentialId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (!agent?.credentialId) return { env: {}, credentialIds: [], chosen: [] };
    const res = await resolveCredentialEnv(db, agentId, agent.credentialId);
    await touchCredentialLastUsed(db, agent.credentialId);
    const [row] = await db
      .select({ type: providerCredentials.type })
      .from(providerCredentials)
      .where(eq(providerCredentials.id, agent.credentialId))
      .limit(1);
    return {
      env: res.env,
      home: res.home,
      credentialIds: [agent.credentialId],
      chosen: row ? [{ credentialId: agent.credentialId, type: row.type }] : [],
    };
  }

  // Group bound credentials by provider type, then select exactly one per type
  // (rotation pool). Preserves behaviour for agents with a single credential per
  // type while enabling LRU rotation when several of the same type are bound.
  const nowMs = Date.now();
  const byType = new Map<string, RotationCandidate[]>();
  for (const r of joinRows) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }
  const chosenCandidates: RotationCandidate[] = [];
  for (const list of byType.values()) {
    chosenCandidates.push(pickPoolCredential(list, nowMs));
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
    const res = await resolveCredentialEnv(db, agentId, candidate.credentialId);
    Object.assign(env, res.env);
    if (res.home) home = res.home;
    credentialIds.push(candidate.credentialId);
    chosen.push({ credentialId: candidate.credentialId, type: candidate.type });
    await touchCredentialLastUsed(db, candidate.credentialId);
  }

  return { env, home, credentialIds, chosen };
}
