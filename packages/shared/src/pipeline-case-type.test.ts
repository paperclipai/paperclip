import { describe, expect, it } from "vitest";
import { caseTypeMatchesPipeline, deriveCaseType } from "./pipeline-case-type.js";

describe("deriveCaseType", () => {
  it("uses the pipeline key as the type", () => {
    expect(deriveCaseType({ id: "p1", key: "content_production" })).toBe("content_production");
  });

  it("trims whitespace", () => {
    expect(deriveCaseType({ id: "p1", key: "  release_coverage  " })).toBe("release_coverage");
  });

  it("falls back to the pipeline id when there is no key", () => {
    expect(deriveCaseType({ id: "p1", key: null })).toBe("p1");
    expect(deriveCaseType({ id: "p1" })).toBe("p1");
  });
});

describe("caseTypeMatchesPipeline", () => {
  const pipeline = { id: "p1", key: "content" };

  it("passes when nothing is declared", () => {
    expect(caseTypeMatchesPipeline(undefined, pipeline)).toBe(true);
    expect(caseTypeMatchesPipeline(null, pipeline)).toBe(true);
    expect(caseTypeMatchesPipeline("", pipeline)).toBe(true);
  });

  it("passes when the declared type agrees with the pipeline", () => {
    expect(caseTypeMatchesPipeline("content", pipeline)).toBe(true);
  });

  it("fails when the declared type disagrees", () => {
    expect(caseTypeMatchesPipeline("release", pipeline)).toBe(false);
  });
});
