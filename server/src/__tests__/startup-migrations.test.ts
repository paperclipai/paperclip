import { describe, expect, it } from "vitest";
import { shouldAutoApplyStartupMigrations } from "../startup-migrations.ts";

describe("shouldAutoApplyStartupMigrations", () => {
  it("auto-applies pending migrations for embedded postgres even on existing dev databases", () => {
    expect(
      shouldAutoApplyStartupMigrations({
        mode: "embedded",
        clusterAlreadyInitialized: true,
        databaseStatus: "exists",
      }),
    ).toBe(true);
  });

  it("does not auto-apply for existing external databases by default", () => {
    expect(
      shouldAutoApplyStartupMigrations({
        mode: "external",
        clusterAlreadyInitialized: true,
        databaseStatus: "exists",
      }),
    ).toBe(false);
  });
});
