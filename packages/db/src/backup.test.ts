import { describe, it, expect } from "vitest";
import { splitSqlStatements } from "./backup.js";

describe("splitSqlStatements", () => {
  it("splits simple statements", () => {
    const sql = "SELECT 1; SELECT 2;";
    expect(splitSqlStatements(sql)).toEqual(["SELECT 1;", "SELECT 2;"]);
  });

  it("ignores semicolons inside single quotes", () => {
    const sql = "INSERT INTO t VALUES ('hello;'); SELECT 2;";
    expect(splitSqlStatements(sql)).toEqual([
      "INSERT INTO t VALUES ('hello;');",
      "SELECT 2;"
    ]);
  });

  it("handles newlines inside string literals", () => {
    const sql = "INSERT INTO t VALUES ('hello;\nworld');\nSELECT 2;";
    expect(splitSqlStatements(sql)).toEqual([
      "INSERT INTO t VALUES ('hello;\nworld');",
      "SELECT 2;"
    ]);
  });

  it("handles SQL comments correctly", () => {
    const sql = "-- This is a comment;\nSELECT 1;\n-- Another comment\nSELECT 2;";
    expect(splitSqlStatements(sql)).toEqual([
      "SELECT 1;",
      "SELECT 2;"
    ]);
  });

  it("does not strip -- inside strings", () => {
    const sql = "INSERT INTO t VALUES ('--not a comment');";
    expect(splitSqlStatements(sql)).toEqual([
      "INSERT INTO t VALUES ('--not a comment');"
    ]);
  });

  it("handles escaped quotes properly", () => {
    const sql = "INSERT INTO t VALUES ('don''t break; here'); SELECT 2;";
    expect(splitSqlStatements(sql)).toEqual([
      "INSERT INTO t VALUES ('don''t break; here');",
      "SELECT 2;"
    ]);
  });

  it("handles trailing statements without semicolons", () => {
    const sql = "SELECT 1; SELECT 2";
    expect(splitSqlStatements(sql)).toEqual(["SELECT 1;", "SELECT 2"]);
  });
});
