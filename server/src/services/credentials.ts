import fs from "node:fs/promises";
import path from "node:path";
import { eq, and } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { providerCredentials, agents } from "@paperclipai/db";
import { resolvePaperclipHomeDir } from "../home-paths.js";
import { logger } from "../middleware/logger.js";

export function credentialService(db: Db) {
  return {
    async list(companyId: string) {
      const rows = await db
        .select({
          id: providerCredentials.id,
          companyId: providerCredentials.companyId,
          name: providerCredentials.name,
          type: providerCredentials.type,
          isDefault: providerCredentials.isDefault,
          createdAt: providerCredentials.createdAt,
          updatedAt: providerCredentials.updatedAt,
        })
        .from(providerCredentials)
        .where(eq(providerCredentials.companyId, companyId))
        .orderBy(providerCredentials.name);
      return rows;
    },

    async getById(id: string) {
      const [row] = await db
        .select()
        .from(providerCredentials)
        .where(eq(providerCredentials.id, id))
        .limit(1);
      return row ?? null;
    },

    async create(
      companyId: string,
      data: { name: string; type: string; credential: Record<string, unknown>; isDefault?: boolean },
    ) {
      // If setting as default, unset other defaults of same type in company
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
          credential: data.credential,
          isDefault: data.isDefault ?? false,
        })
        .returning();

      return created;
    },

    async update(
      id: string,
      data: { name?: string; credential?: Record<string, unknown>; isDefault?: boolean },
    ) {
      const existing = await this.getById(id);
      if (!existing) return null;

      // If setting as default, unset other defaults of same type in company
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
      if (data.credential !== undefined) updates.credential = data.credential;
      if (data.isDefault !== undefined) updates.isDefault = data.isDefault;

      const [updated] = await db
        .update(providerCredentials)
        .set(updates)
        .where(eq(providerCredentials.id, id))
        .returning();

      return updated ?? null;
    },

    async remove(id: string) {
      // Check if any agents reference this credential
      const [agentRef] = await db
        .select({ id: agents.id })
        .from(agents)
        .where(eq(agents.credentialId, id))
        .limit(1);

      if (agentRef) {
        return { error: "credential_in_use" as const };
      }

      const [removed] = await db
        .delete(providerCredentials)
        .where(eq(providerCredentials.id, id))
        .returning();

      return removed ?? null;
    },
  };
}

/**
 * Resolve provider credential environment variables for an agent execution.
 *
 * - For `claude_oauth`: writes `.credentials.json` into an agent-specific HOME
 *   directory so the Claude CLI picks up the OAuth token.
 * - For `qwen_api_key`: sets ANTHROPIC_BASE_URL to the local Qwen proxy and
 *   passes the API key as QWEN_API_KEY.
 *
 * Returns env vars to merge (overriding) into the adapter config env, plus an
 * optional `home` path when a custom HOME was provisioned.
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

  if (cred.type === "claude_oauth") {
    const accessToken = (cred.credential as { accessToken?: string }).accessToken;
    if (!accessToken) {
      logger.warn({ agentId, credentialId }, "claude_oauth credential missing accessToken");
      return { env: {} };
    }

    // Write .credentials.json to an agent-specific HOME so the Claude CLI
    // discovers the OAuth token automatically.
    const agentHome = path.join(resolvePaperclipHomeDir(), "agent-homes", agentId);
    const claudeDir = path.join(agentHome, ".claude");
    await fs.mkdir(claudeDir, { recursive: true });
    const credFile = path.join(claudeDir, ".credentials.json");
    await fs.writeFile(
      credFile,
      JSON.stringify({
        claudeAiOauth: {
          accessToken,
          refreshToken: "",
          expiresAt: 4102444800000,
          scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
        },
      }),
      "utf-8",
    );

    return { env: { HOME: agentHome }, home: agentHome };
  }

  if (cred.type === "qwen_api_key") {
    const apiKey = (cred.credential as { apiKey?: string }).apiKey;
    if (!apiKey) {
      logger.warn({ agentId, credentialId }, "qwen_api_key credential missing apiKey");
      return { env: {} };
    }

    const proxyPort = process.env.QWEN_PROXY_PORT || "3199";
    return {
      env: {
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${proxyPort}`,
        ANTHROPIC_API_KEY: "dummy",
        QWEN_API_KEY: apiKey,
      },
    };
  }

  logger.warn({ agentId, credentialId, type: cred.type }, "unknown credential type during runtime resolution");
  return { env: {} };
}

/**
 * Ensure a claude_local agent has a HOME directory with OAuth credentials.
 *
 * For agents WITHOUT a credentialId, falls back to the global CLAUDE_OAUTH_TOKEN
 * env var. This handles agents created after container boot that weren't
 * provisioned by the entrypoint script.
 *
 * Returns env vars to merge (HOME) if provisioning was needed, or empty if
 * the agent already has HOME configured.
 */
export async function ensureAgentHome(
  agentId: string,
  currentEnv: Record<string, string>,
): Promise<Record<string, string>> {
  // Already has HOME set — nothing to do
  if (currentEnv.HOME) return {};

  const agentHome = path.join(resolvePaperclipHomeDir(), "agent-homes", agentId);
  const claudeDir = path.join(agentHome, ".claude");
  const credFile = path.join(claudeDir, ".credentials.json");

  // Check if credentials already exist on disk (from entrypoint or previous run)
  try {
    await fs.access(credFile);
    // File exists — just set HOME
    return { HOME: agentHome };
  } catch {
    // Not provisioned yet
  }

  // Use global CLAUDE_OAUTH_TOKEN if available
  const globalToken = process.env.CLAUDE_OAUTH_TOKEN;
  if (!globalToken) {
    logger.warn({ agentId }, "agent has no HOME and no CLAUDE_OAUTH_TOKEN to provision with");
    return {};
  }

  await fs.mkdir(claudeDir, { recursive: true });
  await fs.writeFile(
    credFile,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: globalToken,
        refreshToken: "",
        expiresAt: 4102444800000,
        scopes: ["user:inference", "user:profile", "user:sessions:claude_code"],
      },
    }),
    "utf-8",
  );

  logger.info({ agentId, agentHome }, "auto-provisioned agent HOME with global OAuth token");
  return { HOME: agentHome };
}
