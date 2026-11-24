import { getTableConfig } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";
import { authAccounts } from "./schema/auth.js";

describe("account issuer schema", () => {
  it("keeps issuer nullable and identifies accounts by provider and account ID", () => {
    const config = getTableConfig(authAccounts);
    const issuer = config.columns.find((column) => column.name === "issuer");
    expect(issuer).toBeDefined();
    expect(issuer?.notNull).toBe(false);

    const unique = config.indexes.find((index) => index.config.name === "account_provider_account_id_uq");
    expect(unique?.config.unique).toBe(true);
    expect(unique?.config.columns.map((column) => (column as { name: string }).name)).toEqual([
      "provider_id",
      "account_id",
    ]);
  });
});
