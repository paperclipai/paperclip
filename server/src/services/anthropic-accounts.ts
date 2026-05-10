import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  anthropicAccounts,
  anthropicActiveAccount,
  type AnthropicAccount,
} from "@paperclipai/db";
import { conflict, notFound, unprocessable } from "../errors.js";

export type AnthropicAccountMode = "oauth" | "api_key" | "bedrock";

export interface CreateAnthropicAccountInput {
  companyId: string;
  label: string;
  mode: AnthropicAccountMode;
  credentialDir?: string | null;
  apiKeySecretId?: string | null;
}

export interface SetActiveActor {
  agentId?: string | null;
  userId?: string | null;
}

export interface ActiveAccountView {
  account: AnthropicAccount;
  setAt: Date;
  setByAgentId: string | null;
  setByUserId: string | null;
}

const VALID_MODES: ReadonlySet<AnthropicAccountMode> = new Set([
  "oauth",
  "api_key",
  "bedrock",
]);

export function anthropicAccountsService(db: Db) {
  async function listAccounts(companyId: string): Promise<AnthropicAccount[]> {
    return db
      .select()
      .from(anthropicAccounts)
      .where(eq(anthropicAccounts.companyId, companyId))
      .orderBy(anthropicAccounts.createdAt);
  }

  async function getAccountById(accountId: string): Promise<AnthropicAccount | null> {
    const rows = await db
      .select()
      .from(anthropicAccounts)
      .where(eq(anthropicAccounts.id, accountId))
      .limit(1);
    return rows[0] ?? null;
  }

  async function createAccount(
    input: CreateAnthropicAccountInput,
  ): Promise<AnthropicAccount> {
    const label = input.label.trim();
    if (label.length === 0) throw unprocessable("label must not be empty");
    if (!VALID_MODES.has(input.mode)) {
      throw unprocessable(`mode must be one of ${[...VALID_MODES].join(", ")}`);
    }
    if (input.mode === "api_key" && !input.apiKeySecretId) {
      throw unprocessable("apiKeySecretId is required when mode is api_key");
    }
    if (input.mode !== "api_key" && input.apiKeySecretId) {
      throw unprocessable("apiKeySecretId is only valid for mode=api_key");
    }
    const rows = await db
      .insert(anthropicAccounts)
      .values({
        companyId: input.companyId,
        label,
        mode: input.mode,
        credentialDir: input.credentialDir ?? null,
        apiKeySecretId: input.apiKeySecretId ?? null,
      })
      .returning();
    const created = rows[0];
    if (!created) throw new Error("Failed to insert anthropic account");
    return created;
  }

  async function deleteAccount(accountId: string): Promise<void> {
    const existing = await getAccountById(accountId);
    if (!existing) throw notFound("Anthropic account not found");

    const activeRow = await db
      .select({ accountId: anthropicActiveAccount.accountId })
      .from(anthropicActiveAccount)
      .where(eq(anthropicActiveAccount.companyId, existing.companyId))
      .limit(1);
    if (activeRow[0] && activeRow[0].accountId === accountId) {
      throw conflict(
        "Cannot delete the currently active Anthropic account; switch to another first",
      );
    }
    await db.delete(anthropicAccounts).where(eq(anthropicAccounts.id, accountId));
  }

  async function setActiveAccount(
    companyId: string,
    accountId: string,
    setBy: SetActiveActor,
  ): Promise<ActiveAccountView> {
    return db.transaction(async (tx) => {
      // Row-lock the active-pointer row (or absence of it) for this company so
      // concurrent switches serialize on the same key.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`anthropic_active_account:${companyId}`}))`,
      );

      const accountRows = await tx
        .select()
        .from(anthropicAccounts)
        .where(
          and(
            eq(anthropicAccounts.id, accountId),
            eq(anthropicAccounts.companyId, companyId),
          ),
        )
        .limit(1);
      const account = accountRows[0];
      if (!account) {
        throw notFound("Anthropic account not found for this company");
      }

      const existing = await tx
        .select()
        .from(anthropicActiveAccount)
        .where(eq(anthropicActiveAccount.companyId, companyId))
        .limit(1);

      const now = new Date();
      if (existing[0]) {
        await tx
          .update(anthropicActiveAccount)
          .set({
            accountId,
            setAt: now,
            setByAgentId: setBy.agentId ?? null,
            setByUserId: setBy.userId ?? null,
          })
          .where(eq(anthropicActiveAccount.companyId, companyId));
      } else {
        await tx.insert(anthropicActiveAccount).values({
          companyId,
          accountId,
          setAt: now,
          setByAgentId: setBy.agentId ?? null,
          setByUserId: setBy.userId ?? null,
        });
      }

      return {
        account,
        setAt: now,
        setByAgentId: setBy.agentId ?? null,
        setByUserId: setBy.userId ?? null,
      };
    });
  }

  async function getActiveAccount(companyId: string): Promise<ActiveAccountView | null> {
    const rows = await db
      .select({
        account: anthropicAccounts,
        setAt: anthropicActiveAccount.setAt,
        setByAgentId: anthropicActiveAccount.setByAgentId,
        setByUserId: anthropicActiveAccount.setByUserId,
      })
      .from(anthropicActiveAccount)
      .innerJoin(
        anthropicAccounts,
        eq(anthropicActiveAccount.accountId, anthropicAccounts.id),
      )
      .where(eq(anthropicActiveAccount.companyId, companyId))
      .limit(1);
    return rows[0] ?? null;
  }

  async function resolveActiveForAgent(
    companyId: string,
    agentId: string,
  ): Promise<AnthropicAccount> {
    const agentRows = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(eq(agents.id, agentId))
      .limit(1);
    const agent = agentRows[0];
    if (!agent) throw notFound("Agent not found");
    if (agent.companyId !== companyId) {
      throw unprocessable("Agent does not belong to the requested company");
    }

    const overrideId = readAccountOverride(agent.adapterConfig);
    if (overrideId) {
      const overrideRows = await db
        .select()
        .from(anthropicAccounts)
        .where(
          and(
            eq(anthropicAccounts.id, overrideId),
            eq(anthropicAccounts.companyId, companyId),
          ),
        )
        .limit(1);
      const override = overrideRows[0];
      if (override) return override;
      // Override points to a stale account; fall back to the company default
      // rather than failing the run.
    }

    const active = await getActiveAccount(companyId);
    if (!active) {
      throw notFound("No active Anthropic account configured for this company");
    }
    return active.account;
  }

  return {
    listAccounts,
    getAccountById,
    createAccount,
    deleteAccount,
    setActiveAccount,
    getActiveAccount,
    resolveActiveForAgent,
  };
}

export type AnthropicAccountsService = ReturnType<typeof anthropicAccountsService>;

function readAccountOverride(config: unknown): string | null {
  if (!config || typeof config !== "object") return null;
  const cfg = config as Record<string, unknown>;
  const direct = cfg.anthropicAccountId;
  if (typeof direct === "string" && direct.length > 0) return direct;
  const nestedRaw = cfg.anthropic;
  if (nestedRaw && typeof nestedRaw === "object") {
    const nested = nestedRaw as Record<string, unknown>;
    if (typeof nested.accountId === "string" && nested.accountId.length > 0) {
      return nested.accountId;
    }
  }
  return null;
}
