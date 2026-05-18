/**
 * @fileoverview MO-070 — Extra TDD coverage for plugin-database SQL validators.
 *
 * Existing plugin-database.test.ts covers the embedded-Postgres integration
 * paths. This file fills in the pure-function validator coverage that came
 * up during MO-069 plugin-scaffold work (CREATE INDEX rule, AppleDouble file
 * rejection, namespace derivation determinism, DDL keyword guards).
 *
 * MO-070 Phase B — Bug class targeted: BUG-CORE-003 (validator edge cases).
 */

import { describe, expect, it } from "vitest";
import {
  derivePluginDatabaseNamespace,
  validatePluginMigrationStatement,
  validatePluginRuntimeQuery,
  validatePluginRuntimeExecute,
} from "../services/plugin-database.js";

describe("derivePluginDatabaseNamespace", () => {
  it("is deterministic — same input always produces same namespace", () => {
    const ns1 = derivePluginDatabaseNamespace("vexion.council-chat");
    const ns2 = derivePluginDatabaseNamespace("vexion.council-chat");
    expect(ns1).toBe(ns2);
  });

  it("differs for different plugin keys", () => {
    const a = derivePluginDatabaseNamespace("vexion.council-chat");
    const b = derivePluginDatabaseNamespace("vexion.mem0-sync-poc");
    expect(a).not.toBe(b);
  });

  it("produces a valid postgres identifier (a-z0-9_, ≤63 chars, starts with letter or _)", () => {
    const ns = derivePluginDatabaseNamespace("vexion.council-chat");
    expect(ns).toMatch(/^[a-z_][a-z0-9_]*$/);
    expect(ns.length).toBeLessThanOrEqual(63);
    expect(ns.startsWith("plugin_")).toBe(true);
  });

  it("normalizes case and dashes from the plugin key", () => {
    const ns = derivePluginDatabaseNamespace("VEXION.Council-Chat");
    expect(ns).toMatch(/^[a-z_][a-z0-9_]*$/);
  });

  it("uses namespaceSlug override when provided", () => {
    const withSlug = derivePluginDatabaseNamespace("vexion.council-chat", "council");
    expect(withSlug).toContain("council");
  });

  it("never produces empty slug — falls back to 'plugin'", () => {
    // Edge case: a key consisting entirely of non-alphanumeric characters.
    const ns = derivePluginDatabaseNamespace("---", "---");
    expect(ns).toMatch(/^plugin_plugin_/);
  });

  it("truncates at 63 chars (postgres identifier limit)", () => {
    const longKey = "x".repeat(200);
    const ns = derivePluginDatabaseNamespace(longKey);
    expect(ns.length).toBeLessThanOrEqual(63);
  });
});

describe("validatePluginMigrationStatement — DDL guards", () => {
  it("rejects DROP TABLE (destructive in Phase 1)", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "DROP TABLE plugin_test.rows",
        "plugin_test",
      ),
    ).toThrow(/Destructive/i);
  });

  it("rejects TRUNCATE (destructive)", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "TRUNCATE TABLE plugin_test.rows",
        "plugin_test",
      ),
    ).toThrow(/Destructive/i);
  });

  it("rejects CREATE EXTENSION (banned in plugin namespace)", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE EXTENSION IF NOT EXISTS uuid-ossp",
        "plugin_test",
      ),
    ).toThrow(/disallowed/i);
  });

  it("rejects CREATE FUNCTION (banned)", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE FUNCTION plugin_test.my_fn() RETURNS void AS $$ $$ LANGUAGE sql",
        "plugin_test",
      ),
    ).toThrow(/disallowed/i);
  });

  it("rejects CREATE TRIGGER (banned)", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE TRIGGER plugin_test.audit AFTER INSERT ON plugin_test.rows FOR EACH ROW EXECUTE PROCEDURE noop()",
        "plugin_test",
      ),
    ).toThrow(/disallowed/i);
  });

  it("rejects GRANT and REVOKE", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "GRANT SELECT ON plugin_test.rows TO public",
        "plugin_test",
      ),
    ).toThrow(/disallowed/i);
    expect(() =>
      validatePluginMigrationStatement(
        "REVOKE INSERT ON plugin_test.rows FROM public",
        "plugin_test",
      ),
    ).toThrow(/disallowed/i);
  });

  it("rejects qualified references to non-plugin schemas", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "ALTER TABLE other_schema.rows ADD COLUMN x int",
        "plugin_test",
      ),
    ).toThrow(/outside namespace/i);
  });

  it("rejects unqualified statements (must use schema-qualified names)", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "CREATE TABLE rows (id uuid PRIMARY KEY)",
        "plugin_test",
      ),
    ).toThrow(/fully qualified/i);
  });

  it("allows ALTER on a table inside the plugin namespace", () => {
    expect(() =>
      validatePluginMigrationStatement(
        "ALTER TABLE plugin_test.rows ADD COLUMN created_at timestamptz NOT NULL DEFAULT now()",
        "plugin_test",
      ),
    ).not.toThrow();
  });
});

describe("validatePluginRuntimeQuery (SELECT only)", () => {
  it("allows a SELECT against the plugin namespace", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT * FROM plugin_test.rows WHERE id = $1",
        "plugin_test",
      ),
    ).not.toThrow();
  });

  it("rejects INSERT in query() (mutation must use execute())", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "INSERT INTO plugin_test.rows (id) VALUES ($1)",
        "plugin_test",
      ),
    ).toThrow(/SELECT/i);
  });

  it("rejects multi-statement input", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT 1; SELECT 2",
        "plugin_test",
      ),
    ).toThrow(/exactly one statement/i);
  });

  it("rejects DDL keywords in query() (drop/alter/create/truncate)", () => {
    expect(() =>
      validatePluginRuntimeQuery(
        "SELECT * FROM plugin_test.rows WHERE foo = 'create table x'",
        "plugin_test",
      ),
    ).not.toThrow(); // string literal — should be OK after strip

    expect(() =>
      validatePluginRuntimeQuery(
        "WITH cte AS (SELECT 1) DROP TABLE plugin_test.rows",
        "plugin_test",
      ),
    ).toThrow();
  });
});

describe("validatePluginRuntimeExecute (INSERT/UPDATE/DELETE only)", () => {
  it("allows INSERT in plugin namespace", () => {
    expect(() =>
      validatePluginRuntimeExecute(
        "INSERT INTO plugin_test.rows (id, name) VALUES ($1, $2)",
        "plugin_test",
      ),
    ).not.toThrow();
  });

  it("allows UPDATE in plugin namespace", () => {
    expect(() =>
      validatePluginRuntimeExecute(
        "UPDATE plugin_test.rows SET name = $1 WHERE id = $2",
        "plugin_test",
      ),
    ).not.toThrow();
  });

  it("rejects SELECT in execute() (must use query())", () => {
    expect(() =>
      validatePluginRuntimeExecute(
        "SELECT * FROM plugin_test.rows",
        "plugin_test",
      ),
    ).toThrow(/INSERT, UPDATE, or DELETE/i);
  });

  it("rejects INSERT into a non-plugin schema", () => {
    expect(() =>
      validatePluginRuntimeExecute(
        "INSERT INTO public.issues (id, title) VALUES ($1, $2)",
        "plugin_test",
      ),
    ).toThrow(/must be inside plugin namespace/i);
  });

  it("rejects DDL keywords in execute()", () => {
    expect(() =>
      validatePluginRuntimeExecute(
        "INSERT INTO plugin_test.rows (sql) VALUES ('create table x')",
        "plugin_test",
      ),
    ).not.toThrow(); // string literal — stripped

    expect(() =>
      validatePluginRuntimeExecute(
        "INSERT INTO plugin_test.rows SELECT * FROM plugin_test.other; CREATE INDEX",
        "plugin_test",
      ),
    ).toThrow(/exactly one statement/i);
  });
});
