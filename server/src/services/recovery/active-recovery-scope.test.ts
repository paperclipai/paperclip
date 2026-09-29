import { describe, expect, it } from "vitest";
import { companies, issueRecoveryActions } from "@paperclipai/db";
import { activeRecoveryActionCompanyCondition } from "./active-recovery-scope.ts";

describe("active recovery action scope", () => {
  it("limits periodic reconciliation to active companies", () => {
    const condition = activeRecoveryActionCompanyCondition();
    const queryChunks = condition?.queryChunks ?? [];
    const serialized = JSON.stringify(queryChunks, (_key, value) =>
      typeof value === "object" && value && "name" in value ? value.name : value,
    );

    expect(serialized).toContain(issueRecoveryActions.status.name);
    expect(serialized).toContain(companies.status.name);
    expect(serialized).toContain("active");
    expect(serialized).toContain("escalated");
  });
});
