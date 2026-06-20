import type { Db } from "@paperclipai/db";
import { agents } from "@paperclipai/db";
import { reconcileManagedCodexHome } from "@paperclipai/adapter-codex-local/server";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

export interface CodexAuthReconciliationSummary {
  scanned: number;
  seeded: number;
  alreadySeeded: number;
  externalOverride: number;
  noManagedHome: number;
  failed: number;
  seededAgentIds: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * Extracts a literal (non-secret) env value. Adapter env bindings persist either
 * as a bare string or as a `{ type: "plain", value }` object; secret bindings
 * are intentionally NOT resolved here (we never write an unresolved secret
 * placeholder into auth.json). Mirrors the server-side env-binding extraction in
 * routes/agents.ts.
 */
function readPlainEnvValue(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  const record = asRecord(value);
  if (record?.type !== "plain") return null;
  return readPlainEnvValue(record.value);
}

type ApiKeyBinding =
  | { kind: "plain"; value: string }
  | { kind: "secret" }
  | { kind: "none" };

/**
 * Classifies an `OPENAI_API_KEY` env binding so reconciliation can tell the
 * difference between three states it must treat differently:
 *  - `plain`: a literal value we can write into auth.json.
 *  - `secret`: a secret binding (e.g. `{ type: "secret_ref", ... }`) we cannot
 *    resolve at startup; the resolved value may already exist on disk from a
 *    prior execute-time run, so reconciliation must not clobber it.
 *  - `none`: no key configured (chatgpt-subscription mode); seed the shared
 *    auth symlink.
 */
function classifyApiKeyBinding(value: unknown): ApiKeyBinding {
  const plain = readPlainEnvValue(value);
  if (plain) return { kind: "plain", value: plain };
  const record = asRecord(value);
  if (record && typeof record.type === "string" && record.type !== "plain") {
    return { kind: "secret" };
  }
  return { kind: "none" };
}

/**
 * Startup backfill: seed `auth.json` into any already-
 * isolated `codex_local` managed home that was created (by the #8272 isolation
 * guard) before the Phase 1 seeding fix landed. Phase 1 seeds at execute time;
 * this repairs persisted homes proactively so a stranded agent recovers without
 * waiting to run and without a manual symlink. Idempotent and safe to re-run on
 * every boot: a home that already has valid auth is a no-op.
 */
export async function reconcileCodexLocalManagedHomesOnStartup(
  db: Db,
): Promise<CodexAuthReconciliationSummary> {
  const summary: CodexAuthReconciliationSummary = {
    scanned: 0,
    seeded: 0,
    alreadySeeded: 0,
    externalOverride: 0,
    noManagedHome: 0,
    failed: 0,
    seededAgentIds: [],
  };

  const rows = await db
    .select({
      id: agents.id,
      companyId: agents.companyId,
      adapterConfig: agents.adapterConfig,
    })
    .from(agents)
    .where(eq(agents.adapterType, "codex_local"));

  for (const row of rows) {
    summary.scanned += 1;
    const env = asRecord(asRecord(row.adapterConfig)?.env);
    const configuredCodexHome = env ? readPlainEnvValue(env.CODEX_HOME) : null;
    const apiKeyBinding = classifyApiKeyBinding(env?.OPENAI_API_KEY);

    try {
      const result = await reconcileManagedCodexHome({
        companyId: row.companyId,
        configuredCodexHome,
        apiKey: apiKeyBinding.kind === "plain" ? apiKeyBinding.value : null,
        apiKeySecretBound: apiKeyBinding.kind === "secret",
      });
      switch (result.status) {
        case "seeded":
          summary.seeded += 1;
          summary.seededAgentIds.push(row.id);
          logger.info(
            { agentId: row.id, companyId: row.companyId, home: result.home },
            "seeded auth into already-isolated codex_local managed home",
          );
          break;
        case "already_seeded":
          summary.alreadySeeded += 1;
          break;
        case "external_override":
          summary.externalOverride += 1;
          break;
        case "no_managed_home":
          summary.noManagedHome += 1;
          break;
      }
    } catch (err) {
      summary.failed += 1;
      logger.warn(
        {
          agentId: row.id,
          companyId: row.companyId,
          home: configuredCodexHome,
          err: err instanceof Error ? err.message : String(err),
        },
        "failed to reconcile codex_local managed home on startup",
      );
    }
  }

  return summary;
}
