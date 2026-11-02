import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { summarySlots } from "./schema/summary_slots.js";

function indexColumns(table: Parameters<typeof getTableConfig>[0], indexName: string): string[] {
  const index = getTableConfig(table).indexes.find((candidate) => candidate.config.name === indexName);
  if (!index) return [];
  return index.config.columns.map((column) => (column as { name: string }).name);
}

function uniqueConstraint(table: Parameters<typeof getTableConfig>[0], constraintName: string) {
  return getTableConfig(table).uniqueConstraints.find((candidate) => candidate.name === constraintName);
}

function column(table: Parameters<typeof getTableConfig>[0], columnName: string) {
  const match = getTableConfig(table).columns.find((candidate) => candidate.name === columnName);
  if (!match) throw new Error(`Column ${columnName} not found`);
  return match;
}

describe("summary slot schema", () => {
  it("enforces one slot per company scope and key, including null singleton scope ids", () => {
    const constraint = uniqueConstraint(summarySlots, "summary_slots_company_scope_slot_uq");

    expect(constraint?.columns.map((candidate) => candidate.name)).toEqual([
      "company_id",
      "scope_kind",
      "scope_id",
      "slot_key",
    ]);
    expect(constraint?.nullsNotDistinct).toBe(true);
  });

  it("keeps lookup indexes company-scoped", () => {
    expect(indexColumns(summarySlots, "summary_slots_company_scope_idx")).toEqual([
      "company_id",
      "scope_kind",
      "scope_id",
    ]);
    expect(indexColumns(summarySlots, "summary_slots_company_generating_issue_idx")).toEqual([
      "company_id",
      "generating_issue_id",
    ]);
    expect(indexColumns(summarySlots, "summary_slots_company_updated_idx")).toEqual([
      "company_id",
      "updated_at",
    ]);
  });

  it("wires document revisions and generation metadata without inline markdown", () => {
    const columnNames = getTableConfig(summarySlots).columns.map((candidate) => candidate.name);

    expect(columnNames).toEqual(expect.arrayContaining([
      "document_id",
      "status",
      "generating_issue_id",
      "last_generated_at",
      "last_generated_by_agent_id",
      "last_model",
    ]));
    expect(columnNames).not.toContain("markdown");
    expect(columnNames).not.toContain("body");
    expect(column(summarySlots, "document_id").notNull).toBe(false);
    expect(column(summarySlots, "status").notNull).toBe(true);
    expect(column(summarySlots, "status").default).toBe("idle");
  });
});
