import { describe, expect, it } from "vitest";
import {
  COMPLETION_REQUIREMENT_KINDS,
  type DeclaredWorkProduct,
  type ExpectedWorkProduct,
  decideCompletionGate,
  matchesExpectation,
} from "./completion-gate.js";

const expectedFile: ExpectedWorkProduct = {
  type: "file",
  location: "WHITESTAG.ACADEMY/content/ki-datenschutz-dsgvo.md",
};

function declared(overrides: Partial<DeclaredWorkProduct> = {}): DeclaredWorkProduct {
  return {
    type: "file",
    provider: "git",
    externalId: "WHITESTAG.ACADEMY/content/ki-datenschutz-dsgvo.md",
    url: null,
    isPrimary: true,
    healthStatus: "verified",
    ...overrides,
  };
}

describe("matchesExpectation", () => {
  it("accepts a declared file at the expected path", () => {
    expect(matchesExpectation(expectedFile, declared())).toBe(true);
  });

  it("normalizes leading ./ and surrounding whitespace in paths", () => {
    expect(matchesExpectation(expectedFile, declared({
      externalId: "  ./WHITESTAG.ACADEMY/content/ki-datenschutz-dsgvo.md ",
    }))).toBe(true);
  });

  // The WHI-2519 case: real work, delivered to the wrong medium.
  it("rejects a paperclip document when a file was expected", () => {
    expect(matchesExpectation(expectedFile, declared({
      type: "document",
      provider: "paperclip",
      externalId: "ef6c0ebf-51b3-40d9-8efc-b1fe33a171b9",
    }))).toBe(false);
  });

  it("rejects a file at a different path", () => {
    expect(matchesExpectation(expectedFile, declared({
      externalId: "WHITESTAG.ACADEMY/content/ki-vertrieb.md",
    }))).toBe(false);
  });

  it("matches a url expectation against the declared url", () => {
    const expected: ExpectedWorkProduct = { type: "url", location: "https://example.test/kurs" };
    expect(matchesExpectation(expected, declared({
      type: "url",
      provider: "http",
      externalId: null,
      url: "https://example.test/kurs",
    }))).toBe(true);
  });

  it("ignores location when the expectation only pins a type", () => {
    const expected: ExpectedWorkProduct = { type: "document", location: null };
    expect(matchesExpectation(expected, declared({
      type: "document",
      provider: "paperclip",
      externalId: "any-doc-id",
    }))).toBe(true);
  });
});

describe("decideCompletionGate", () => {
  it("passes issues that require nothing", () => {
    const d = decideCompletionGate({ requirement: "none", expected: null, declared: [] });
    expect(d.allowed).toBe(true);
  });

  it("blocks when a work product is required but none was declared", () => {
    const d = decideCompletionGate({ requirement: "work_product", expected: expectedFile, declared: [] });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no_work_product");
    expect(d.message).toMatch(/no work product/i);
  });

  it("blocks when the declared work product could not be verified", () => {
    const d = decideCompletionGate({
      requirement: "work_product",
      expected: expectedFile,
      declared: [declared({ healthStatus: "missing" })],
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("unverified_work_product");
    expect(d.message).toContain("ki-datenschutz-dsgvo.md");
  });

  it("blocks a verified artifact that sits at the wrong location", () => {
    const d = decideCompletionGate({
      requirement: "work_product",
      expected: expectedFile,
      declared: [declared({ type: "document", provider: "paperclip", externalId: "doc-1" })],
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("expectation_mismatch");
    expect(d.message).toMatch(/expected/i);
  });

  it("allows when a verified work product matches the expectation", () => {
    const d = decideCompletionGate({
      requirement: "work_product",
      expected: expectedFile,
      declared: [declared()],
    });
    expect(d.allowed).toBe(true);
  });

  it("allows any verified work product when no expectation was pinned", () => {
    const d = decideCompletionGate({
      requirement: "work_product",
      expected: null,
      declared: [declared({ type: "document", provider: "paperclip" })],
    });
    expect(d.allowed).toBe(true);
  });

  it("ignores non-primary work products", () => {
    const d = decideCompletionGate({
      requirement: "work_product",
      expected: expectedFile,
      declared: [declared({ isPrimary: false })],
    });
    expect(d.allowed).toBe(false);
    expect(d.reason).toBe("no_work_product");
  });

  it("passes when at least one primary product matches, even if a sibling does not", () => {
    const d = decideCompletionGate({
      requirement: "work_product",
      expected: expectedFile,
      declared: [declared({ type: "document", provider: "paperclip" }), declared()],
    });
    expect(d.allowed).toBe(true);
  });

  it("exposes the requirement kinds it understands", () => {
    expect(COMPLETION_REQUIREMENT_KINDS).toEqual(["none", "work_product"]);
  });
});
