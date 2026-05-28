import { describe, expect, it } from "vitest";
import {
  isRunId,
  isRunIdParseError,
  parseOptionalRunId,
  parseRunId,
  unsafeRunId,
  type RunId,
} from "./run-id.js";

const VALID = "0190f8e2-7b6c-7c1f-9e7f-3d3f4a2b1c8a";
const VALID_UPPER = "0190F8E2-7B6C-7C1F-9E7F-3D3F4A2B1C8A";

describe("parseRunId", () => {
  it("accepts a canonical lowercase UUID", () => {
    const out = parseRunId(VALID, "header");
    expect(out).toBe(VALID);
  });

  it("normalizes uppercase UUIDs to lowercase", () => {
    const out = parseRunId(VALID_UPPER, "header");
    expect(out).toBe(VALID);
  });

  it("trims surrounding whitespace before validating", () => {
    const out = parseRunId(`  ${VALID}\n`, "header");
    expect(out).toBe(VALID);
  });

  it("rejects the smoke-script label pattern", () => {
    const out = parseRunId("smoke-run-1717000000", "env");
    expect(isRunIdParseError(out)).toBe(true);
    if (isRunIdParseError(out)) {
      expect(out.source).toBe("env");
      expect(out.got).toBe("smoke-run-1717000000");
    }
  });

  it("rejects the manual session label pattern", () => {
    const out = parseRunId("manual-smilerite-20260527T141106Z", "header");
    expect(isRunIdParseError(out)).toBe(true);
  });

  it("rejects empty string", () => {
    const out = parseRunId("", "header");
    expect(isRunIdParseError(out)).toBe(true);
    if (isRunIdParseError(out)) expect(out.got).toBe("");
  });

  it("rejects whitespace-only input", () => {
    const out = parseRunId("   ", "header");
    expect(isRunIdParseError(out)).toBe(true);
  });

  it("rejects non-string input", () => {
    const out = parseRunId(12345, "config");
    expect(isRunIdParseError(out)).toBe(true);
    if (isRunIdParseError(out)) expect(out.got).toBe("");
  });

  it("rejects null and undefined", () => {
    expect(isRunIdParseError(parseRunId(null, "claim"))).toBe(true);
    expect(isRunIdParseError(parseRunId(undefined, "claim"))).toBe(true);
  });

  it("rejects almost-UUID shapes", () => {
    // wrong segment lengths
    expect(isRunIdParseError(parseRunId("0190f8e2-7b6c-7c1f-9e7f-3d3f4a2b1c8", "header"))).toBe(
      true,
    );
    // non-hex chars
    expect(isRunIdParseError(parseRunId("0190f8e2-7b6c-7c1f-9e7f-3d3f4a2b1cZZ", "header"))).toBe(
      true,
    );
  });
});

describe("parseOptionalRunId", () => {
  it("returns null when input is absent", () => {
    expect(parseOptionalRunId(undefined, "header")).toBeNull();
    expect(parseOptionalRunId(null, "header")).toBeNull();
  });

  it("returns RunId when input is a valid UUID", () => {
    expect(parseOptionalRunId(VALID, "header")).toBe(VALID);
  });

  it("returns an error for empty string (do not silently accept)", () => {
    const out = parseOptionalRunId("", "header");
    expect(isRunIdParseError(out)).toBe(true);
  });

  it("returns an error for invalid present input", () => {
    const out = parseOptionalRunId("garbage", "header");
    expect(isRunIdParseError(out)).toBe(true);
  });
});

describe("unsafeRunId", () => {
  it("brands a string without validation", () => {
    const out: RunId = unsafeRunId(VALID);
    expect(out).toBe(VALID);
  });
});

describe("isRunId", () => {
  it("narrows valid UUIDs", () => {
    expect(isRunId(VALID)).toBe(true);
  });

  it("rejects non-UUIDs", () => {
    expect(isRunId("smoke-run-1")).toBe(false);
    expect(isRunId("")).toBe(false);
    expect(isRunId(123)).toBe(false);
    expect(isRunId(null)).toBe(false);
  });

  it("does NOT lowercase-normalize when narrowing (use parseRunId for that)", () => {
    // isRunId is a pure type guard; the canonical-form contract is the
    // caller's responsibility. Uppercase passes only after parseRunId.
    expect(isRunId(VALID_UPPER)).toBe(false);
  });
});
