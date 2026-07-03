import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "./schema/index.js";

const POSTGRES_MAX_IDENTIFIER_LENGTH = 63;
const SNAKE_CASE = /^[a-z][a-z0-9_]*$/;

const tables: Array<[string, PgTable]> = Object.entries(schema).flatMap(
  ([exportName, value]) => (value instanceof PgTable ? [[exportName, value] as [string, PgTable]] : []),
);

describe("schema invariants", () => {
  it("exports a non-trivial number of tables", () => {
    expect(tables.length).toBeGreaterThan(50);
  });

  it("uses unique snake_case table names within the identifier length limit", () => {
    const seen = new Map<string, string>();

    for (const [exportName, table] of tables) {
      const { name } = getTableConfig(table);
      expect(name, `table exported as ${exportName}`).toMatch(SNAKE_CASE);
      expect(
        name.length,
        `table name ${name} exceeds the PostgreSQL identifier limit`,
      ).toBeLessThanOrEqual(POSTGRES_MAX_IDENTIFIER_LENGTH);
      expect(
        seen.has(name),
        `duplicate table name ${name} exported as ${exportName} and ${seen.get(name)}`,
      ).toBe(false);
      seen.set(name, exportName);
    }
  });

  it("declares a primary key on every table", () => {
    const missingPrimaryKey: string[] = [];

    for (const [, table] of tables) {
      const config = getTableConfig(table);
      const hasColumnPrimaryKey = config.columns.some((column) => column.primary);
      const hasCompositePrimaryKey = config.primaryKeys.length > 0;
      if (!hasColumnPrimaryKey && !hasCompositePrimaryKey) {
        missingPrimaryKey.push(config.name);
      }
    }

    expect(missingPrimaryKey).toEqual([]);
  });

  it("uses snake_case column names within the identifier length limit", () => {
    for (const [, table] of tables) {
      const config = getTableConfig(table);
      for (const column of config.columns) {
        expect(column.name, `column on table ${config.name}`).toMatch(SNAKE_CASE);
        expect(
          column.name.length,
          `column ${config.name}.${column.name} exceeds the PostgreSQL identifier limit`,
        ).toBeLessThanOrEqual(POSTGRES_MAX_IDENTIFIER_LENGTH);
      }
    }
  });

  it("uses globally unique index names, even after PostgreSQL truncates them", () => {
    // PostgreSQL silently truncates identifiers to 63 bytes, so two index
    // names that only differ after that point would collide in the database.
    const seenTruncated = new Map<string, string>();

    for (const [, table] of tables) {
      const config = getTableConfig(table);
      for (const index of config.indexes) {
        const indexName = index.config.name;
        expect(indexName, `unnamed index on table ${config.name}`).toBeTruthy();
        if (!indexName) continue;
        expect(indexName, `index on table ${config.name}`).toMatch(SNAKE_CASE);
        const truncated = indexName.slice(0, POSTGRES_MAX_IDENTIFIER_LENGTH);
        expect(
          seenTruncated.has(truncated),
          `index name ${indexName} on ${config.name} collides with an index on ` +
            `${seenTruncated.get(truncated)} within the first ${POSTGRES_MAX_IDENTIFIER_LENGTH} characters`,
        ).toBe(false);
        seenTruncated.set(truncated, config.name);
      }
    }
  });

  it("does not add new index names beyond the PostgreSQL identifier limit", () => {
    // These index names already ship in released migrations; PostgreSQL
    // truncates them to 63 characters, so the stored index name differs from
    // the declared one. Do not add new entries to this list.
    const knownOverLengthIndexNames = new Set([
      "document_annotation_anchor_snapshots_company_document_revision_idx",
      "document_annotation_anchor_snapshots_company_thread_created_at_idx",
      "environment_custom_image_templates_environment_provider_status_idx",
      "workspace_runtime_services_company_execution_workspace_status_idx",
    ]);

    const overLength: string[] = [];
    for (const [, table] of tables) {
      for (const index of getTableConfig(table).indexes) {
        const indexName = index.config.name;
        if (indexName && indexName.length > POSTGRES_MAX_IDENTIFIER_LENGTH) {
          overLength.push(indexName);
        }
      }
    }

    expect(overLength.sort()).toEqual([...knownOverLengthIndexNames].sort());
  });

  it("does not reuse a column name twice within a table", () => {
    for (const [, table] of tables) {
      const config = getTableConfig(table);
      const names = config.columns.map((column) => column.name);
      expect(new Set(names).size, `table ${config.name}`).toBe(names.length);
    }
  });
});
