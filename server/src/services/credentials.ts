import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentCredentials, agents, providerCredentials } from "@paperclipai/db";
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
     * Enforces at most one credential per provider type per agent.
     * Returns `{ error: "duplicate_type", type }` if validation fails.
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

      const typeCounts = new Map<string, number>();
      for (const c of creds) {
        const next = (typeCounts.get(c.type) ?? 0) + 1;
        if (next > 1) {
          return { ok: false, error: "duplicate_type", type: c.type };
        }
        typeCounts.set(c.type, next);
      }

      await db.transaction(async (tx) => {
        await tx.delete(agentCredentials).where(eq(agentCredentials.agentId, agentId));
        await tx.insert(agentCredentials).values(uniqueIds.map((credentialId) => ({ agentId, credentialId })));
      });

      return { ok: true, credentials: creds.map(stripCredential) };
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
      // Long-lived tokens (from `claude setup-token`) use a distinct prefix and
      // have no refreshToken / expiresAt; flag them so we can route through the
      // CLAUDE_CODE_OAUTH_TOKEN env var instead of synthesising a fake-expiry
      // .credentials.json that the CLI would otherwise try to refresh.
      const tokenKind = typeof payload.tokenKind === "string" ? payload.tokenKind : null;
      const isLongLivedToken =
        tokenKind === "long_lived" || (accessToken.startsWith("sk-ant-oat") && !payload.refreshToken);
      if (isLongLivedToken) {
        logger.info(
          { agentId, credentialId },
          "resolving claude_oauth long-lived token via CLAUDE_CODE_OAUTH_TOKEN env",
        );
        return { env: { CLAUDE_CODE_OAUTH_TOKEN: accessToken } };
      }
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

      logger.info(
        { agentId, credentialId, credFile, hasRefreshToken: refreshToken.length > 0, subscriptionType },
        "wrote claude_oauth credentials.json for agent",
      );
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

    default:
      logger.warn(
        { agentId, credentialId, type: cred.type },
        "unknown credential type during runtime resolution",
      );
      return { env: {} };
  }
}

/**
 * Resolve env for ALL credentials assigned to an agent via the agent_credentials
 * join table. Falls back to the legacy `agents.credential_id` singular FK when
 * the join is empty so existing single-credential agents keep working.
 *
 * Provider env vars do not collide across types (Anthropic / OpenAI / Gemini /
 * OpenRouter each own distinct keys), but HOME is the one shared key — if both
 * claude_oauth and codex_oauth are assigned, the last write wins. Codex is
 * resolved last so CODEX_HOME + its HOME take precedence; the Claude CLI still
 * finds its .credentials.json via the agent-specific HOME path it shares.
 */
export async function resolveAllCredentialEnv(
  db: Db,
  agentId: string,
): Promise<{ env: Record<string, string>; home?: string; credentialIds: string[] }> {
  const joinRows = await db
    .select({ credentialId: agentCredentials.credentialId, type: providerCredentials.type })
    .from(agentCredentials)
    .innerJoin(providerCredentials, eq(agentCredentials.credentialId, providerCredentials.id))
    .where(eq(agentCredentials.agentId, agentId));

  if (joinRows.length === 0) {
    const [agent] = await db
      .select({ credentialId: agents.credentialId })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    if (!agent?.credentialId) return { env: {}, credentialIds: [] };
    const res = await resolveCredentialEnv(db, agentId, agent.credentialId);
    return { env: res.env, home: res.home, credentialIds: [agent.credentialId] };
  }

  // Resolve oauth types last so their HOME overrides take precedence over any
  // api-key types (which never set HOME).
  const homeOwnerTypes = new Set(["claude_oauth", "codex_oauth"]);
  const ordered = [...joinRows].sort((a, b) => {
    const aHome = homeOwnerTypes.has(a.type) ? 1 : 0;
    const bHome = homeOwnerTypes.has(b.type) ? 1 : 0;
    return aHome - bHome;
  });

  const env: Record<string, string> = {};
  let home: string | undefined;
  const credentialIds: string[] = [];

  for (const row of ordered) {
    const res = await resolveCredentialEnv(db, agentId, row.credentialId);
    Object.assign(env, res.env);
    if (res.home) home = res.home;
    credentialIds.push(row.credentialId);
  }

  return { env, home, credentialIds };
}
