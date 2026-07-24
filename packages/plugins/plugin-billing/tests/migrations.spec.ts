import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DB_NAMESPACE } from "../src/constants.js";

const MIGRATIONS_DIR = new URL("../migrations/", import.meta.url);

function read(name: string): string {
  return readFileSync(new URL(name, MIGRATIONS_DIR), "utf8");
}

describe("migrations", () => {
  it("ships exactly the expected migration files", () => {
    const files = readdirSync(MIGRATIONS_DIR).sort();
    expect(files).toEqual(["001_billing.sql", "002_stub_provider.sql"]);
  });

  it("every CREATE statement is qualified with the plugin namespace", () => {
    for (const file of ["001_billing.sql", "002_stub_provider.sql"]) {
      const statements = read(file)
        .split(";")
        .map((statement) => statement.trim())
        .filter((statement) => statement.startsWith("CREATE"));
      expect(statements.length).toBeGreaterThan(0);
      for (const statement of statements) {
        expect(statement, `${file}: ${statement.slice(0, 60)}`).toContain(`${DB_NAMESPACE}.`);
      }
    }
  });

  it("001 creates the three spec §4 tables with the required columns", () => {
    const sql = read("001_billing.sql");
    expect(sql).toContain(`CREATE TABLE ${DB_NAMESPACE}.billing_customers`);
    expect(sql).toContain(`CREATE TABLE ${DB_NAMESPACE}.subscriptions`);
    expect(sql).toContain(`CREATE TABLE ${DB_NAMESPACE}.billing_events`);
    for (const column of ["user_id", "provider_customer_id", "has_default_payment_method"]) {
      expect(sql).toContain(column);
    }
    for (const column of [
      "company_id uuid NOT NULL UNIQUE",
      "owner_user_id",
      "trial_ends_at",
      "grace_since",
      "current_period_end",
      "cancel_at_period_end",
      "price_cents_override",
      "provider_subscription_id",
      "open_checkout_session_ref",
      "open_checkout_url",
    ]) {
      expect(sql).toContain(column);
    }
    expect(sql).toContain("idempotency_key text NOT NULL UNIQUE");
    expect(sql).toContain(
      "CHECK (status IN ('trialing','awaiting_payment','active','grace','blocked','canceled','complimentary'))",
    );
    // Deliberately NO foreign key to public.companies: subscription rows must
    // survive company deletion so the sweep can cancel at the provider.
    expect(sql).not.toContain("REFERENCES public.companies");
  });

  it("002 creates and seeds the singleton stub_state row", () => {
    const sql = read("002_stub_provider.sql");
    expect(sql).toContain(`CREATE TABLE ${DB_NAMESPACE}.stub_state`);
    expect(sql).toContain(`INSERT INTO ${DB_NAMESPACE}.stub_state`);
    expect(sql).toContain("CHECK (id = 1)");
  });
});
