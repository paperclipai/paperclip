import { createDb } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { recoveryService } from "../server/src/services/recovery/service.js";

/**
 * TSMC-20155/20183 one-time, idempotent backfill.
 *
 * Mint/link a board-visible receipt for every owner_type='board' recovery action
 * that is still active/escalated with recovery_issue_id NULL (the inverse
 * stranded-recovery class). Runs across all companies by default; pass --company
 * <id> to scope. Safe to re-run: rows that already carry a receipt are not matched.
 *
 * Usage:
 *   DATABASE_URL=postgres://paperclip:paperclip@127.0.0.1:54329/paperclip \
 *     tsx scripts/backfill-board-recovery-receipts.ts [--company <id>] [--limit <n>]
 */
function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;

  const db = createDb(dbUrl);
  // Backfill never wakes an agent; the receipts are board-owned (unassigned).
  const recovery = recoveryService(db, { enqueueWakeup: async () => null });

  const companyId = parseFlag("--company") ?? undefined;
  const limitFlag = parseFlag("--limit");
  const limit = limitFlag ? Number.parseInt(limitFlag, 10) : undefined;

  console.log(
    `Backfilling board-owned recovery receipts${companyId ? ` for company ${companyId}` : " (all companies)"}...`,
  );
  const result = await recovery.backfillBoardOwnedRecoveryReceipts({ companyId, limit });
  console.log(JSON.stringify(result, null, 2));
  console.log(
    `Done. scanned=${result.scanned} linked=${result.linked} skipped=${result.skipped}`,
  );
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Board-recovery-receipt backfill failed: ${message}`);
  process.exitCode = 1;
});
