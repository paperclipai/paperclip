import { describe, it, expect } from "vitest";
import { renderTemplate } from "../template-engine.js";

describe("template-engine", () => {
  it("interpolates output fields", () => {
    const result = renderTemplate("Fix validation failures: {{ output.errors }}", {
      output: { errors: ["test failed", "lint error"] },
    });
    expect(result).toBe("Fix validation failures: test failed,lint error");
  });

  it("interpolates nested objects as JSON", () => {
    const result = renderTemplate("Findings: {{ output.findings }}", {
      output: { findings: [{ file: "a.ts", description: "issue" }] },
    });
    expect(result).toContain("a.ts");
  });

  it("handles missing fields gracefully", () => {
    const result = renderTemplate("Error: {{ output.missing }}", { output: {} });
    expect(result).toBe("Error: ");
  });

  it("passes through text without templates", () => {
    const result = renderTemplate("No templates here", { output: {} });
    expect(result).toBe("No templates here");
  });
});
