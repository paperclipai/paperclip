import { describe, expect, it } from "vitest";
import { caseTypeMatchesPipeline, deriveCaseType } from "./pipeline-case-type.js";

describe("deriveCaseType", () => {
  it("uses the pipeline key when present", () => {
    expect(deriveCaseType({ id: "pipe-1", key: "bug-reports" })).toBe("bug-reports");
  });

  it("trims the key before using it", () => {
    expect(deriveCaseType({ id: "pipe-1", key: "  bug-reports  " })).toBe("bug-reports");
  });

  it("falls back to the pipeline id when key is absent, null, or blank", () => {
    expect(deriveCaseType({ id: "pipe-1" })).toBe("pipe-1");
    expect(deriveCaseType({ id: "pipe-1", key: null })).toBe("pipe-1");
    expect(deriveCaseType({ id: "pipe-1", key: "   " })).toBe("pipe-1");
  });
});

describe("caseTypeMatchesPipeline", () => {
  const pipeline = { id: "pipe-1", key: "bug-reports" };

  it("accepts an absent or empty declared type", () => {
    expect(caseTypeMatchesPipeline(undefined, pipeline)).toBe(true);
    expect(caseTypeMatchesPipeline(null, pipeline)).toBe(true);
    expect(caseTypeMatchesPipeline("", pipeline)).toBe(true);
  });

  it("accepts a declared type that matches the derived type", () => {
    expect(caseTypeMatchesPipeline("bug-reports", pipeline)).toBe(true);
    expect(caseTypeMatchesPipeline("pipe-2", { id: "pipe-2" })).toBe(true);
  });

  it("rejects a declared type that disagrees with the pipeline", () => {
    expect(caseTypeMatchesPipeline("feature-requests", pipeline)).toBe(false);
    expect(caseTypeMatchesPipeline("pipe-1", pipeline)).toBe(false);
  });
});
