import { eq, fillPlaceholders, sql } from "drizzle-orm";
import { PgDialect, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { columnPlaceholder, preparedStatements } from "../services/prepared-statements.js";

describe("prepared statements", () => {
  it("prepares a shape one time for a client, and again for another client or shape", () => {
    const prepare = vi.fn((db: Db, shape: "first" | "after") => ({ db, shape }));
    const statements = preparedStatements(prepare);
    const root = {} as Db, transaction = {} as Db;
    const first = statements(root, "first");
    expect(statements(root, "first")).toBe(first);
    expect(statements(root, "after")).not.toBe(first);
    expect(statements(root, "after")).toBe(statements(root, "after"));
    expect(statements(transaction, "first")).toEqual({ db: transaction, shape: "first" });
    expect(statements(transaction, "first")).not.toBe(first);
    expect(prepare.mock.calls).toEqual([[root, "first"], [root, "after"], [transaction, "first"]]);
  });

  it("encodes a placeholder value with the column, as the query builder encodes a bound value", () => {
    const table = pgTable("prepared_statement_fixture", { id: uuid("id"), at: timestamp("at", { withTimezone: true }) });
    const at = new Date("2026-11-12T10:00:00.123Z");
    const dialect = new PgDialect();
    const bound = dialect.sqlToQuery(sql`select 1 from ${table} where ${eq(table.at, at)} and ${eq(table.id, "a")}`);
    const prepared = dialect.sqlToQuery(sql`select 1 from ${table} where ${eq(table.at, columnPlaceholder("at", table.at))} and ${
      eq(table.id, sql.placeholder("id"))}`);
    expect(prepared.sql).toBe(bound.sql);
    expect(fillPlaceholders(prepared.params, { at, id: "a" })).toEqual(bound.params);
    expect(bound.params).toEqual(["2026-11-12T10:00:00.123Z", "a"]);
  });
});
