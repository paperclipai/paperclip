import { is } from "drizzle-orm";
import { PgTable, getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import * as schema from "@paperclipai/db";
import { companyRemoveCascadeOrder, companyRemoveSpecialCasedTables } from "../services/companies.js";

// onDelete values that block deleting the referenced row. Drizzle's default
// (undefined) maps to Postgres NO ACTION, which blocks like RESTRICT.
const BLOCKING_RULES = new Set(["no action", "restrict", undefined]);

interface BlockingEdge {
  src: string;
  dst: string;
}

function allTables(): Map<string, PgTable> {
  const tables = new Map<string, PgTable>();
  for (const value of Object.values(schema)) {
    if (is(value, PgTable)) {
      tables.set(getTableConfig(value).name, value);
    }
  }
  return tables;
}

function blockingEdges(tables: Map<string, PgTable>): BlockingEdge[] {
  const edges: BlockingEdge[] = [];
  for (const [src, table] of tables) {
    for (const fk of getTableConfig(table).foreignKeys) {
      if (!BLOCKING_RULES.has(fk.onDelete)) continue;
      const dst = getTableConfig(fk.reference().foreignTable).name;
      if (dst !== src) edges.push({ src, dst });
    }
  }
  return edges;
}

describe("company remove cascade", () => {
  const tables = allTables();
  const edges = blockingEdges(tables);
  const orderNames = companyRemoveCascadeOrder.map((table) => getTableConfig(table).name);
  // Special-cased tables have no company_id; remove() sweeps them with a
  // dedicated delete before the ordered cascade, so they count as covered.
  const specialNames = companyRemoveSpecialCasedTables.map((table) => getTableConfig(table).name);
  // companies is deleted last by remove(), after the ordered list.
  const covered = new Set([...orderNames, ...specialNames, "companies"]);

  it("introspects a non-trivial schema (guards against vacuous passes)", () => {
    expect(tables.size).toBeGreaterThan(50);
    expect(edges.length).toBeGreaterThan(50);
    expect(tables.has("companies")).toBe(true);
    expect(tables.has("issue_thread_interactions")).toBe(true);
  });

  it("has no duplicate tables in the cascade order", () => {
    expect(new Set(orderNames).size).toBe(orderNames.length);
  });

  it("special-cases only tables that lack company_id and are not in the ordered list", () => {
    for (const table of companyRemoveSpecialCasedTables) {
      const config = getTableConfig(table);
      expect(
        config.columns.some((column) => column.name === "company_id"),
        `${config.name} has a company_id column; move it into companyRemoveCascadeOrder`,
      ).toBe(false);
      expect(orderNames).not.toContain(config.name);
    }
  });

  it("deletes by company_id, so every listed table must carry that column", () => {
    for (const table of companyRemoveCascadeOrder) {
      const config = getTableConfig(table);
      expect(
        config.columns.some((column) => column.name === "company_id"),
        `${config.name} has no company_id column; it needs a special-case delete in remove()`,
      ).toBe(true);
    }
  });

  it("covers every table whose blocking FK would abort a company delete", () => {
    // If src blocks dst and dst gets deleted by remove(), src must be swept
    // first — i.e. it must be in the cascade list too. This is exactly how
    // issue_thread_interactions broke company deletion (LOOA-1064).
    const missing = edges
      .filter((edge) => covered.has(edge.dst) && !covered.has(edge.src))
      .map((edge) => `${edge.src} (blocks ${edge.dst})`);
    expect(missing, `add these tables to companyRemoveCascadeOrder: ${missing.join(", ")}`).toEqual(
      [],
    );
  });

  it("orders referencing tables before the tables they block", () => {
    const position = new Map(orderNames.map((name, index) => [name, index]));
    const violations = edges
      .filter((edge) => position.has(edge.src) && position.has(edge.dst))
      .filter((edge) => (position.get(edge.src) as number) >= (position.get(edge.dst) as number))
      .map((edge) => `${edge.src} must be deleted before ${edge.dst}`);
    expect(violations, violations.join("; ")).toEqual([]);
  });
});
