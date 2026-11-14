import { describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

describe("bob-shell testEnvironment", () => {
  it("fails when the configured bob command cannot be resolved", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "bob_shell",
      config: { bobCommand: "definitely-not-a-real-bob-binary" },
    });

    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "bob_cli_not_found" && c.level === "error")).toBe(true);
  });

  it("does not interpret shell syntax in bobCommand", async () => {
    const result = await testEnvironment({
      companyId: "company-1",
      adapterType: "bob_shell",
      config: { bobCommand: "bob & echo pwned" },
    });

    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "bob_cli_not_found")).toBe(true);
    expect(JSON.stringify(result.checks)).not.toContain("IBM Bob Shell version");
  });
});
