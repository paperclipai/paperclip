import { describe, expect, it } from "vitest";
import {
  computeMigrationHash,
  normalizeMigrationContent,
  splitMigrationStatements,
} from "./migration-utils.js";

describe("normalizeMigrationContent", () => {
  it("converts CRLF line endings to LF", () => {
    const crlf = "CREATE TABLE foo (\r\n  id INT\r\n);\r\n";
    const result = normalizeMigrationContent(crlf);
    expect(result).toBe("CREATE TABLE foo (\n  id INT\n);\n");
    expect(result).not.toContain("\r\n");
  });

  it("leaves LF-only content unchanged", () => {
    const lf = "CREATE TABLE foo (\n  id INT\n);\n";
    const result = normalizeMigrationContent(lf);
    expect(result).toBe(lf);
  });

  it("handles mixed line endings (CRLF and LF)", () => {
    const mixed = "line1\r\nline2\nline3\r\nline4\n";
    const result = normalizeMigrationContent(mixed);
    expect(result).toBe("line1\nline2\nline3\nline4\n");
  });

  it("handles empty string", () => {
    expect(normalizeMigrationContent("")).toBe("");
  });

  it("handles content with no line endings", () => {
    const single = "SELECT 1;";
    expect(normalizeMigrationContent(single)).toBe(single);
  });

  it("does not modify standalone CR characters", () => {
    const cr = "line1\rline2\rline3";
    expect(normalizeMigrationContent(cr)).toBe(cr);
  });
});

describe("computeMigrationHash", () => {
  it("returns a 64-character hex SHA-256 hash", () => {
    const hash = computeMigrationHash("CREATE TABLE foo (id INT);");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns the same hash for identical content", () => {
    const content = "CREATE TABLE foo (\n  id INT\n);\n";
    const hash1 = computeMigrationHash(content);
    const hash2 = computeMigrationHash(content);
    expect(hash1).toBe(hash2);
  });

  it("returns different hashes for different content", () => {
    const hash1 = computeMigrationHash("CREATE TABLE foo (id INT);");
    const hash2 = computeMigrationHash("CREATE TABLE bar (id INT);");
    expect(hash1).not.toBe(hash2);
  });
});

describe("CRLF normalization produces consistent hashes", () => {
  it("CRLF and LF versions of the same migration produce identical hashes after normalization", () => {
    const lfContent = "CREATE TABLE foo (\n  id INT PRIMARY KEY,\n  name TEXT NOT NULL\n);\n";
    const crlfContent = "CREATE TABLE foo (\r\n  id INT PRIMARY KEY,\r\n  name TEXT NOT NULL\r\n);\r\n";

    const normalizedLf = normalizeMigrationContent(lfContent);
    const normalizedCrlf = normalizeMigrationContent(crlfContent);

    expect(normalizedLf).toBe(normalizedCrlf);
    expect(computeMigrationHash(normalizedLf)).toBe(computeMigrationHash(normalizedCrlf));
  });

  it("without normalization, CRLF and LF produce different hashes", () => {
    const lfContent = "CREATE TABLE foo (\n  id INT\n);\n";
    const crlfContent = "CREATE TABLE foo (\r\n  id INT\r\n);\r\n";

    // This is the bug that normalization fixes: raw hashes differ
    expect(computeMigrationHash(lfContent)).not.toBe(computeMigrationHash(crlfContent));
  });

  it("handles realistic multi-statement migration with CRLF", () => {
    const lfMigration = [
      "CREATE TABLE users (",
      "  id SERIAL PRIMARY KEY,",
      "  email TEXT NOT NULL UNIQUE",
      ");",
      "--> statement-breakpoint",
      "CREATE INDEX idx_users_email ON users (email);",
    ].join("\n");

    const crlfMigration = lfMigration.replace(/\n/g, "\r\n");

    const hashLf = computeMigrationHash(normalizeMigrationContent(lfMigration));
    const hashCrlf = computeMigrationHash(normalizeMigrationContent(crlfMigration));

    expect(hashLf).toBe(hashCrlf);
  });
});

describe("splitMigrationStatements", () => {
  it("splits on statement breakpoint markers", () => {
    const content = "CREATE TABLE foo (id INT);\n--> statement-breakpoint\nCREATE INDEX idx ON foo (id);";
    const statements = splitMigrationStatements(content);
    expect(statements).toEqual([
      "CREATE TABLE foo (id INT);",
      "CREATE INDEX idx ON foo (id);",
    ]);
  });

  it("trims whitespace from statements", () => {
    const content = "  SELECT 1;  \n--> statement-breakpoint\n  SELECT 2;  ";
    const statements = splitMigrationStatements(content);
    expect(statements).toEqual(["SELECT 1;", "SELECT 2;"]);
  });

  it("filters out empty statements", () => {
    const content = "SELECT 1;\n--> statement-breakpoint\n\n--> statement-breakpoint\nSELECT 2;";
    const statements = splitMigrationStatements(content);
    expect(statements).toEqual(["SELECT 1;", "SELECT 2;"]);
  });

  it("returns single statement when no breakpoints exist", () => {
    const content = "CREATE TABLE foo (id INT);";
    const statements = splitMigrationStatements(content);
    expect(statements).toEqual(["CREATE TABLE foo (id INT);"]);
  });

  it("returns empty array for empty content", () => {
    expect(splitMigrationStatements("")).toEqual([]);
    expect(splitMigrationStatements("   ")).toEqual([]);
  });

  it("handles CRLF line endings around breakpoints", () => {
    const content = "CREATE TABLE foo (id INT);\r\n--> statement-breakpoint\r\nCREATE INDEX idx ON foo (id);";
    const statements = splitMigrationStatements(content);
    expect(statements).toEqual([
      "CREATE TABLE foo (id INT);",
      "CREATE INDEX idx ON foo (id);",
    ]);
  });
});
