/**
 * TSMC-21711 — arm the close-evidence gate on issues that already demand an artifact.
 *
 * `inferDefaultCloseContractForIssueCreate` runs at CREATE only, so broadening it
 * does nothing for work already on the board. This walks open issues with a null
 * closeContract, runs the SAME inference function, and writes what it returns.
 *
 * Reusing the inference function is deliberate: a backfill with its own private
 * copy of "what counts as an artifact demand" would drift from the create path
 * silently, which is the failure the gate extraction (TSMC-21479) exists to end.
 *
 * Dry-run by default. Pass --apply to write.
 *
 * Run it with the workspace's own tsx. A bare `tsx` does not resolve from the
 * repo root (nor do the sibling entries in package.json that assume it does):
 *
 *   TSX=node_modules/.pnpm/tsx@*\/node_modules/tsx/dist/cli.mjs
 *   node $TSX scripts/backfill-close-contracts.ts
 *   node $TSX scripts/backfill-close-contracts.ts --company <uuid> --limit 50
 *   node $TSX scripts/backfill-close-contracts.ts --apply
 *
 * Verified 2026-08-25 against the live control plane: 224 open unarmed issues
 * scanned, 8 matched, exits in ~1.2s.
 */
import { and, createDb, eq, inArray, isNull, issues } from "../packages/db/src/index.js";
import { loadConfig } from "../server/src/config.js";
import { inferDefaultCloseContractForIssueCreate } from "../server/src/services/issue-close-evidence.js";

/** Statuses where arming a contract still changes an outcome. */
const OPEN_STATUSES = ["backlog", "todo", "in_progress", "blocked", "in_review"] as const;

function parseFlag(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : null;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const companyId = parseFlag("--company");
  const limit = Number.parseInt(parseFlag("--limit") ?? "", 10);

  const config = loadConfig();
  const dbUrl =
    process.env.DATABASE_URL?.trim()
    || config.databaseUrl
    || `postgres://paperclip:paperclip@127.0.0.1:${config.embeddedPostgresPort}/paperclip`;
  const db = createDb(dbUrl);
  try {
    await run(db, { apply, companyId, limit });
  } finally {
    // postgres.js keeps the socket open, so the process never exits on its own.
    await (db.$client as unknown as { end: () => Promise<void> }).end();
  }
}

async function run(
  db: ReturnType<typeof createDb>,
  opts: { apply: boolean; companyId: string | null; limit: number },
) {
  const { apply, companyId, limit } = opts;

  const rows = await db
    .select({
      id: issues.id,
      identifier: issues.identifier,
      companyId: issues.companyId,
      title: issues.title,
      description: issues.description,
      status: issues.status,
    })
    .from(issues)
    .where(
      and(
        isNull(issues.closeContract),
        inArray(issues.status, [...OPEN_STATUSES]),
        ...(companyId ? [eq(issues.companyId, companyId)] : []),
      ),
    );

  const planned = [];
  let skippedWithoutIdentifier = 0;
  for (const row of rows) {
    // evidencePath is the issue identifier; a row without one cannot carry a
    // governed path, so it is reported rather than silently dropped.
    if (!row.identifier) {
      skippedWithoutIdentifier += 1;
      continue;
    }
    const contract = inferDefaultCloseContractForIssueCreate({
      title: row.title,
      description: row.description,
      // cardTemplate is not persisted on issues; the template branch is a
      // create-time input only, so DB-driven backfill never takes it.
      cardTemplate: null,
      closeContract: null,
      identifier: row.identifier,
    });
    if (contract) planned.push({ row: { ...row, identifier: row.identifier }, contract });
  }

  const selected = Number.isFinite(limit) && limit > 0 ? planned.slice(0, limit) : planned;

  console.log(
    `Scanned ${rows.length} open issue(s) with no closeContract; ${planned.length} match an artifact demand.`,
  );
  if (skippedWithoutIdentifier > 0) {
    console.log(`Skipped ${skippedWithoutIdentifier} issue(s) with no identifier (cannot form a governed evidencePath).`);
  }
  if (selected.length < planned.length) {
    console.log(`--limit ${limit} applied: writing ${selected.length}, LEAVING ${planned.length - selected.length} unarmed.`);
  }

  for (const { row, contract } of selected) {
    const kind = "artifactKind" in contract ? contract.artifactKind : contract.mode;
    console.log(`  ${row.identifier.padEnd(12)} ${String(row.status).padEnd(12)} ${kind.padEnd(24)} ${row.title.slice(0, 60)}`);
  }

  if (!apply) {
    console.log("\nDry run — nothing written. Re-run with --apply to arm these contracts.");
    return;
  }

  let armed = 0;
  for (const { row, contract } of selected) {
    await db.update(issues).set({ closeContract: contract }).where(eq(issues.id, row.id));
    armed += 1;
  }
  console.log(`\nArmed ${armed} issue(s).`);
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`close-contract backfill failed: ${message}`);
  process.exitCode = 1;
});
