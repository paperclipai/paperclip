import { describe, expect, it } from "vitest";
import { testEnvironment } from "./test.js";

describe("kimi_local environment diagnostics", () => {
  it("detects kimi cli and wire protocol", async () => {
    const result = await testEnvironment({
      adapterType: "kimi_local",
      companyId: "test-company",
      config: {},
      environmentName: "local",
    });

    console.log("Status:", result.status);
    for (const check of result.checks) {
      console.log(`  [${check.level}] ${check.code} - ${check.message}`);
    }

    // Command should be resolvable on this machine
    expect(result.checks.some((c) => c.code === "kimi_command_resolvable" && c.level === "info")).toBe(true);
    // Wire init should pass
    expect(result.checks.some((c) => c.code === "kimi_wire_init_passed" && c.level === "info")).toBe(true);
    expect(result.status).toBe("pass");
  }, 30000);
});
