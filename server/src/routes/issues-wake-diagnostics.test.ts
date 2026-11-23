import { describe, expect, it } from "vitest";
import { projectWakeDiagnosticReason } from "./issues.js";

describe("issue wake diagnostics", () => {
  it("preserves the reconciliation-required reason", () => {
    expect(projectWakeDiagnosticReason("execution_reconciliation_required")).toBe(
      "execution_reconciliation_required",
    );
  });

  it("continues to redact unrecognized reasons", () => {
    expect(projectWakeDiagnosticReason("private-provider-detail")).toBe("other");
  });
});
