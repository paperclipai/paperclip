import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const MIGRATION_FILE = "0241_pricing_methodology.sql";

async function readMigration() {
  return readFile(
    fileURLToPath(new URL(`./migrations/${MIGRATION_FILE}`, import.meta.url)),
    "utf8",
  );
}

describe("0241_pricing_methodology migration", () => {
  it("adds pricing_methodology column with the three legal values", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(
      /ALTER TABLE\s+"cost_events"\s+ADD COLUMN\s+IF NOT EXISTS\s+"pricing_methodology"\s+text\s+DEFAULT\s+'measured'\s+NOT NULL/i,
    );
  });

  it("drops NOT NULL on rate_card_cents", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(
      /ALTER TABLE\s+"cost_events"\s+ALTER COLUMN\s+"rate_card_cents"\s+DROP NOT NULL/i,
    );
  });

  it("backfills pre-cache_write_aware rows using cache_write_tokens=0 AND created_at cutoff", async () => {
    const sql = await readMigration();
    // The backfill must only touch rows still at the default
    // pricing_methodology='measured' to stay idempotent on rerun.
    const updateMatch = sql.match(
      /UPDATE\s+"cost_events"\s+SET\s+"pricing_methodology"\s*=\s*'pre_cache_write_aware'[\s\S]*?WHERE\s+"pricing_methodology"\s*=\s*'measured'[\s\S]*?AND\s+"cache_write_tokens"\s*=\s*0[\s\S]*?AND\s+"created_at"\s*<\s*'[^']+'::timestamptz/i,
    );
    expect(updateMatch, "pre_cache_write_aware backfill should match schema").not.toBeNull();
  });

  it("updates cost_status for the same pre-migration row set without losing the original 'reported' record", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(
      /UPDATE\s+"cost_events"\s+SET\s+"cost_status"\s*=\s*'reported_pre_migration'[\s\S]*?WHERE\s+"cost_status"\s*=\s*'reported'[\s\S]*?AND\s+"pricing_methodology"\s*=\s*'pre_cache_write_aware'/i,
    );
  });

  it("enforces a CHECK constraint on the three allowed values", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(
      /CHECK\s*\(\s*"pricing_methodology"\s+IN\s*\(\s*'measured'\s*,\s*'pre_cache_write_aware'\s*,\s*'unpriced'\s*\)\s*\)/i,
    );
  });

  it("documents a backout path in the migration comment", async () => {
    const sql = await readMigration();
    expect(sql).toMatch(/--\s*Backout:/i);
    // Backout flips pricing_methodology back to 'measured' where it is currently
    // 'pre_cache_write_aware', and cost_status back to 'reported' where it is
    // 'reported_pre_migration'. Statements in the backout block are commented out
    // (each line is prefixed with `-- `) so they sit in the migration as a recipe,
    // not as live SQL. Multi-line SQL is broken across lines with a `-- ` prefix
    // on every continuation, so we allow `(?:\n--\s+)*` between tokens.
    const commentLine = String.raw`(?:\s|--\s+)*`;
    expect(sql).toMatch(
      new RegExp(
        String.raw`--\s*UPDATE\s+"cost_events"${commentLine}SET\s+"pricing_methodology"\s*=\s*'measured'${commentLine}WHERE\s+"pricing_methodology"\s*=\s*'pre_cache_write_aware'`,
        "i",
      ),
    );
    expect(sql).toMatch(
      new RegExp(
        String.raw`--\s*UPDATE\s+"cost_events"${commentLine}SET\s+"cost_status"\s*=\s*'reported'${commentLine}WHERE\s+"cost_status"\s*=\s*'reported_pre_migration'`,
        "i",
      ),
    );
    expect(sql).toMatch(
      new RegExp(
        String.raw`--\s*ALTER TABLE\s+"cost_events"${commentLine}ALTER COLUMN\s+"rate_card_cents"\s+SET NOT NULL`,
        "i",
      ),
    );
    expect(sql).toMatch(
      new RegExp(
        String.raw`--\s*ALTER TABLE\s+"cost_events"${commentLine}DROP COLUMN\s+IF EXISTS\s+"pricing_methodology"`,
        "i",
      ),
    );
  });
});