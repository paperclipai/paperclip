import { describe, expect, it } from "vitest";
import { parseYamlSingleQuotedScalar } from "../services/company-portability.js";

describe("parseYamlSingleQuotedScalar", () => {
  it("strips surrounding single quotes", () => {
    expect(parseYamlSingleQuotedScalar("'CEO / Editor'")).toBe("CEO / Editor");
  });

  it("unescapes doubled single quotes per YAML spec", () => {
    expect(parseYamlSingleQuotedScalar("'it''s alive'")).toBe("it's alive");
  });

  it("handles value with no special chars", () => {
    expect(parseYamlSingleQuotedScalar("'hello'")).toBe("hello");
  });

  it("handles empty quoted string", () => {
    expect(parseYamlSingleQuotedScalar("''")).toBe("");
  });

  it("returns short strings unchanged", () => {
    expect(parseYamlSingleQuotedScalar("'")).toBe("'");
  });
});
