import { describe, expect, it } from "vitest";
import {
  analyzeMigrationSafety,
  type MigrationSafetyInput,
} from "./check-migration-safety.js";
import {
  TABLE_SIZE_ESTIMATE_FACTOR,
  TABLE_SIZE_BUCKET_THRESHOLDS,
  type TableSizeEstimate,
} from "./table-size-estimates.js";

const testEstimates: readonly TableSizeEstimate[] = [
  {
    table: "issue_comments",
    localRows: 5_034,
    estimateFactor: TABLE_SIZE_ESTIMATE_FACTOR,
    estimatedRows: 5_034 * TABLE_SIZE_ESTIMATE_FACTOR,
    bucket: "large",
  },
  {
    table: "companies",
    localRows: 1,
    estimateFactor: TABLE_SIZE_ESTIMATE_FACTOR,
    estimatedRows: TABLE_SIZE_ESTIMATE_FACTOR,
    bucket: "small",
  },
];

function analyze(sql: string) {
  const migrations: readonly MigrationSafetyInput[] = [{ fileName: "9999_fixture.sql", sql }];
  return analyzeMigrationSafety(migrations, { baselineIds: [], estimates: testEstimates });
}

describe("migration safety check", () => {
  it("documents the large table threshold used by the estimates", () => {
    expect(TABLE_SIZE_BUCKET_THRESHOLDS.largeRows).toBe(1_000_000);
    expect(testEstimates[0]?.estimatedRows).toBeGreaterThanOrEqual(
      TABLE_SIZE_BUCKET_THRESHOLDS.largeRows,
    );
  });

  it("fails a 0126-shaped batched loop over a large table without a support index", () => {
    const result = analyze(`
      DO $$
      DECLARE
        last_comment_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
      BEGIN
        LOOP
          WITH batch AS MATERIALIZED (
            SELECT c."id"
            FROM "issue_comments" c
            WHERE c."id" > last_comment_id
              AND c."author_agent_id" IS NULL
            ORDER BY c."id"
            LIMIT 5000
          )
          UPDATE "issue_comments" c
          SET "derived_author_agent_id" = NULL
          FROM batch b
          WHERE c."id" = b."id";

          EXIT WHEN NOT FOUND;
        END LOOP;
      END $$;
    `);

    expect(result.newFindings.map((finding) => finding.rule)).toEqual(
      expect.arrayContaining([
        "loop-mutation-large-table",
        "batched-mutation-large-table-missing-index",
      ]),
    );
    expect(result.newFindings[0]?.table).toBe("issue_comments");
  });

  it("passes the same bounded large-table backfill when a matching concurrent support index exists", () => {
    const result = analyze(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_comments_fixture_backfill_idx"
        ON "issue_comments" USING btree ("id")
        WHERE "author_agent_id" IS NULL;--> statement-breakpoint
      DO $$
      DECLARE
        last_comment_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
      BEGIN
        LOOP
          WITH batch AS MATERIALIZED (
            SELECT c."id"
            FROM "issue_comments" c
            WHERE c."id" > last_comment_id
              AND c."author_agent_id" IS NULL
            ORDER BY c."id"
            LIMIT 5000
          )
          UPDATE "issue_comments" c
          SET "derived_author_agent_id" = NULL
          FROM batch b
          WHERE c."id" = b."id";

          EXIT WHEN NOT FOUND;
        END LOOP;
      END $$;
    `);

    expect(result.newFindings).toEqual([]);
  });

  it("does not suppress missing-index finding when a partial support index predicate is incompatible with the batch WHERE", () => {
    const result = analyze(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_comments_fixture_backfill_idx"
        ON "issue_comments" USING btree ("id")
        WHERE "author_agent_id" IS NOT NULL;--> statement-breakpoint
      DO $$
      DECLARE
        last_comment_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
      BEGIN
        LOOP
          WITH batch AS MATERIALIZED (
            SELECT c."id"
            FROM "issue_comments" c
            WHERE c."id" > last_comment_id
              AND c."author_agent_id" IS NULL
            ORDER BY c."id"
            LIMIT 5000
          )
          UPDATE "issue_comments" c
          SET "derived_author_agent_id" = NULL
          FROM batch b
          WHERE c."id" = b."id";

          EXIT WHEN NOT FOUND;
        END LOOP;
      END $$;
    `);

    expect(result.newFindings.map((finding) => finding.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("passes a batched backfill over a small-bucket table", () => {
    const result = analyze(`
      DO $$
      BEGIN
        LOOP
          WITH batch AS (
            SELECT "id"
            FROM "companies"
            ORDER BY "id"
            LIMIT 100
          )
          UPDATE "companies" c
          SET "description" = c."description"
          FROM batch b
          WHERE c."id" = b."id";

          EXIT WHEN NOT FOUND;
        END LOOP;
      END $$;
    `);

    expect(result.newFindings).toEqual([]);
  });

  it("flags UPDATE ... FROM (SELECT ... LIMIT N) subquery batch on a large table", () => {
    const result = analyze(`
      UPDATE "issue_comments" c
      SET "derived_author_agent_id" = NULL
      FROM (
        SELECT "id"
        FROM "issue_comments"
        WHERE "author_agent_id" IS NULL
        ORDER BY "id"
        LIMIT 5000
      ) batch
      WHERE c."id" = batch."id";
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags UPDATE ... FROM (SELECT ... FETCH FIRST N ROWS ONLY) subquery batch on a large table", () => {
    const result = analyze(`
      UPDATE "issue_comments" c
      SET "derived_author_agent_id" = NULL
      FROM (
        SELECT "id"
        FROM "issue_comments"
        WHERE "author_agent_id" IS NULL
        ORDER BY "id"
        FETCH FIRST 5000 ROWS ONLY
      ) batch
      WHERE c."id" = batch."id";
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags UPDATE ... FROM (SELECT ... FETCH NEXT N ROWS ONLY) subquery batch on a large table", () => {
    const result = analyze(`
      UPDATE "issue_comments" c
      SET "derived_author_agent_id" = NULL
      FROM (
        SELECT "id"
        FROM "issue_comments"
        WHERE "author_agent_id" IS NULL
        ORDER BY "id"
        FETCH NEXT 5000 ROWS ONLY
      ) batch
      WHERE c."id" = batch."id";
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags UPDATE ... FROM (SELECT ... FETCH FIRST N ROWS WITH TIES) subquery batch on a large table", () => {
    const result = analyze(`
      UPDATE "issue_comments" c
      SET "derived_author_agent_id" = NULL
      FROM (
        SELECT "id"
        FROM "issue_comments"
        WHERE "author_agent_id" IS NULL
        ORDER BY "id"
        FETCH FIRST 5000 ROWS WITH TIES
      ) batch
      WHERE c."id" = batch."id";
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags UPDATE ... FROM (SELECT ... FETCH FIRST ROW ONLY) subquery batch on a large table", () => {
    const result = analyze(`
      UPDATE "issue_comments" c
      SET "derived_author_agent_id" = NULL
      FROM (
        SELECT "id"
        FROM "issue_comments"
        WHERE "author_agent_id" IS NULL
        ORDER BY "id"
        FETCH FIRST ROW ONLY
      ) batch
      WHERE c."id" = batch."id";
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags UPDATE ... WHERE IN (SELECT ... LIMIT N) subquery batch on a large table", () => {
    const result = analyze(`
      UPDATE "issue_comments"
      SET "derived_author_agent_id" = NULL
      WHERE "id" IN (
        SELECT "id"
        FROM "issue_comments"
        WHERE "author_agent_id" IS NULL
        ORDER BY "id"
        LIMIT 5000
      );
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags a CTE with a selective WHERE when the outer UPDATE has no WHERE clause", () => {
    const result = analyze(`
      WITH selective AS (
        SELECT "id" FROM "issue_comments" WHERE "author_agent_id" IS NULL
      )
      UPDATE "issue_comments"
      SET "derived_author_agent_id" = NULL
      FROM selective;
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not treat WHERE inside a block comment as a selective predicate", () => {
    const result = analyze(`
      UPDATE "issue_comments"
      SET "derived_author_agent_id" = NULL /* ignored
        /* nested WHERE "id" > '0' */
        still ignored
      */;
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not treat WHERE inside an inline line comment as a selective predicate", () => {
    const result = analyze(`
      UPDATE "issue_comments"
      SET "derived_author_agent_id" = NULL -- WHERE "id" > '0'
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not treat WHERE inside a string literal as a selective predicate", () => {
    const result = analyze(`
      UPDATE "issue_comments"
      SET "body" = 'WHERE "id" > ''0''';
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not treat WHERE inside a tagged dollar-quoted string as a selective predicate", () => {
    const result = analyze(`
      UPDATE "issue_comments"
      SET "body" = $msg$WHERE "id" > '0'$msg$;
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not treat WHERE inside an untagged dollar-quoted string as a selective predicate", () => {
    const result = analyze(`
      UPDATE "issue_comments"
      SET "body" = $$WHERE "id" > '0'$$;
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("still accepts a real selective WHERE clause", () => {
    const result = analyze(`
      UPDATE "issue_comments"
      SET "derived_author_agent_id" = NULL
      WHERE "id" > '0';
    `);

    expect(result.newFindings.map((f) => f.rule)).not.toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not suppress full-table finding when WHERE only constrains a joined table", () => {
    const result = analyze(`
      UPDATE "issue_comments"
        SET "derived_author_agent_id" = NULL
        FROM "companies"
        WHERE "companies"."id" = '00000000-0000-0000-0000-000000000000';
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not suppress full-table finding when WHERE only constrains a joined table via an unquoted alias", () => {
    const result = analyze(`
      UPDATE "issue_comments"
        SET "derived_author_agent_id" = NULL
        FROM "companies" c
        WHERE c."id" = '00000000-0000-0000-0000-000000000000';
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not suppress full-table finding when WHERE only constrains an unquoted joined table", () => {
    const result = analyze(`
      UPDATE "issue_comments"
        SET "derived_author_agent_id" = NULL
        FROM companies
        WHERE companies.id = '00000000-0000-0000-0000-000000000000';
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "full-table-mutation-large-table",
    );
  });

  it("does not suppress missing-index finding when support index uses an expression", () => {
    const result = analyze(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_comments_expr_idx"
        ON "issue_comments" ((lower("body")));--> statement-breakpoint
      UPDATE "issue_comments" c
        SET "derived_author_agent_id" = NULL
        FROM (
          SELECT "id"
          FROM "issue_comments"
          ORDER BY "id"
          LIMIT 5000
        ) b
        WHERE c."id" = b."id";
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags a batch backfill when the support index does not cover the ORDER BY key", () => {
    const result = analyze(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_comments_author_idx"
        ON "issue_comments" ("author_agent_id");--> statement-breakpoint
      DO $$
      DECLARE
        last_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
      BEGIN
        LOOP
          WITH batch AS MATERIALIZED (
            SELECT "id"
            FROM "issue_comments"
            WHERE "id" > last_id
            ORDER BY "id"
            LIMIT 5000
          )
          UPDATE "issue_comments" c
          SET "derived_author_agent_id" = NULL
          FROM batch b
          WHERE c."id" = b."id";

          EXIT WHEN NOT FOUND;
        END LOOP;
      END $$;
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("flags a batch backfill when the support index only covers a later ORDER BY column", () => {
    const result = analyze(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS "issue_comments_created_idx"
        ON "issue_comments" ("created_at");--> statement-breakpoint
      DO $$
      DECLARE
        last_id uuid := '00000000-0000-0000-0000-000000000000'::uuid;
      BEGIN
        LOOP
          WITH batch AS MATERIALIZED (
            SELECT "id"
            FROM "issue_comments"
            WHERE "id" > last_id
            ORDER BY "id", "created_at"
            LIMIT 5000
          )
          UPDATE "issue_comments" c
          SET "derived_author_agent_id" = NULL
          FROM batch b
          WHERE c."id" = b."id";

          EXIT WHEN NOT FOUND;
        END LOOP;
      END $$;
    `);

    expect(result.newFindings.map((f) => f.rule)).toContain(
      "batched-mutation-large-table-missing-index",
    );
  });

  it("honors suppressions only when they name a rule and reason", () => {
    const result = analyze(`
      -- paperclip:migration-safety-ignore full-table-mutation-large-table: one-time metadata reset approved in issue thread
      UPDATE "issue_comments"
      SET "derived_author_source" = NULL;
    `);

    expect(result.newFindings).toEqual([]);
  });
});
