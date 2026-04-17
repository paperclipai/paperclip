import { describe, it, expect } from "vitest";
import {
  createFeedbackRedactionState,
  stableStringify,
  sha256Digest,
  sanitizeFeedbackText,
  sanitizeFeedbackValue,
  finalizeFeedbackRedactionSummary,
} from "./feedback-redaction.js";

// ---------------------------------------------------------------------------
// stableStringify
// ---------------------------------------------------------------------------

describe("stableStringify", () => {
  it("serializes null", () => {
    expect(stableStringify(null)).toBe("null");
  });

  it("serializes numbers", () => {
    expect(stableStringify(42)).toBe("42");
  });

  it("serializes strings with JSON encoding", () => {
    expect(stableStringify("hello")).toBe('"hello"');
  });

  it("serializes arrays in order", () => {
    expect(stableStringify([1, 2, 3])).toBe("[1,2,3]");
  });

  it("sorts object keys alphabetically", () => {
    expect(stableStringify({ z: 1, a: 2 })).toBe('{"a":2,"z":1}');
  });

  it("produces the same output regardless of key insertion order", () => {
    const obj1 = { b: 2, a: 1 };
    const obj2 = { a: 1, b: 2 };
    expect(stableStringify(obj1)).toBe(stableStringify(obj2));
  });

  it("sorts nested object keys", () => {
    const result = stableStringify({ z: { y: 1, x: 2 }, a: 0 });
    expect(result).toBe('{"a":0,"z":{"x":2,"y":1}}');
  });

  it("handles arrays of objects with sorted keys", () => {
    const result = stableStringify([{ z: 2, a: 1 }]);
    expect(result).toBe('[{"a":1,"z":2}]');
  });
});

// ---------------------------------------------------------------------------
// sha256Digest
// ---------------------------------------------------------------------------

describe("sha256Digest", () => {
  it("returns a 64-character hex string", () => {
    const digest = sha256Digest("test");
    expect(digest).toHaveLength(64);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    expect(sha256Digest({ key: "value" })).toBe(sha256Digest({ key: "value" }));
  });

  it("differs for different inputs", () => {
    expect(sha256Digest("a")).not.toBe(sha256Digest("b"));
  });

  it("is stable regardless of object key insertion order", () => {
    const digest1 = sha256Digest({ b: 2, a: 1 });
    const digest2 = sha256Digest({ a: 1, b: 2 });
    expect(digest1).toBe(digest2);
  });
});

// ---------------------------------------------------------------------------
// createFeedbackRedactionState
// ---------------------------------------------------------------------------

describe("createFeedbackRedactionState", () => {
  it("returns a state with empty sets and an empty counts map", () => {
    const state = createFeedbackRedactionState();
    expect(state.redactedFields.size).toBe(0);
    expect(state.truncatedFields.size).toBe(0);
    expect(state.omittedFields.size).toBe(0);
    expect(state.notes.size).toBe(0);
    expect(state.counts.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sanitizeFeedbackText
// ---------------------------------------------------------------------------

describe("sanitizeFeedbackText", () => {
  it("returns the input unchanged when there is nothing to redact", () => {
    const state = createFeedbackRedactionState();
    const result = sanitizeFeedbackText("hello world", state, "msg", 1000);
    expect(result).toBe("hello world");
    expect(state.redactedFields.size).toBe(0);
  });

  it("redacts a bearer token (standalone form)", () => {
    const state = createFeedbackRedactionState();
    // Use the standalone bearer form so the bearer_token regex (not secret_assignment) handles it
    const result = sanitizeFeedbackText("Bearer abc123xyz456789", state, "header", 1000);
    expect(result).not.toContain("abc123xyz456789");
    expect(result).toContain("[REDACTED_TOKEN]");
  });

  it("redacts a GitHub token", () => {
    const state = createFeedbackRedactionState();
    const result = sanitizeFeedbackText("token ghp_abcdefghij1234567890", state, "env", 1000);
    expect(result).not.toContain("ghp_abcdefghij1234567890");
    expect(result).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("redacts an API key matching sk- pattern", () => {
    const state = createFeedbackRedactionState();
    const result = sanitizeFeedbackText("key=sk-ant-abcdefghijklmnop", state, "config", 1000);
    expect(result).not.toContain("sk-ant-abcdefghijklmnop");
  });

  it("redacts an email address", () => {
    const state = createFeedbackRedactionState();
    const result = sanitizeFeedbackText("Contact: user@example.com", state, "body", 1000);
    expect(result).not.toContain("user@example.com");
    expect(result).toContain("[REDACTED_EMAIL]");
  });

  it("truncates text exceeding maxLength with an ellipsis", () => {
    const state = createFeedbackRedactionState();
    // truncation formula: slice(0, maxLength - 1) + "..." = maxLength - 1 + 3 chars
    const maxLength = 10;
    const result = sanitizeFeedbackText("a".repeat(20), state, "field", maxLength);
    expect(result.endsWith("...")).toBe(true);
    expect(result.length).toBe(maxLength + 2); // (maxLength - 1) chars + "..."
    expect(state.truncatedFields.has("field")).toBe(true);
  });

  it("records the field path when redaction occurs", () => {
    const state = createFeedbackRedactionState();
    sanitizeFeedbackText("Bearer abc123xyz", state, "auth.header", 1000);
    expect(state.redactedFields.has("auth.header")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// sanitizeFeedbackValue
// ---------------------------------------------------------------------------

describe("sanitizeFeedbackValue", () => {
  it("returns non-string, non-object, non-array values as-is", () => {
    const state = createFeedbackRedactionState();
    expect(sanitizeFeedbackValue(42, state, "num", 1000)).toBe(42);
    expect(sanitizeFeedbackValue(true, state, "bool", 1000)).toBe(true);
    expect(sanitizeFeedbackValue(null, state, "nul", 1000)).toBeNull();
  });

  it("redacts strings recursively", () => {
    const state = createFeedbackRedactionState();
    const result = sanitizeFeedbackValue("user@test.com", state, "email", 1000);
    expect(result).toContain("[REDACTED_EMAIL]");
  });

  it("processes arrays element by element", () => {
    const state = createFeedbackRedactionState();
    const result = sanitizeFeedbackValue(["hello", "user@test.com"], state, "list", 1000) as string[];
    expect(result[0]).toBe("hello");
    expect(result[1]).toContain("[REDACTED_EMAIL]");
  });

  it("processes object values recursively", () => {
    const state = createFeedbackRedactionState();
    const result = sanitizeFeedbackValue(
      { greeting: "hello", contact: "admin@corp.io" },
      state,
      "obj",
      1000,
    ) as Record<string, string>;
    expect(result.greeting).toBe("hello");
    expect(result.contact).toContain("[REDACTED_EMAIL]");
  });
});

// ---------------------------------------------------------------------------
// finalizeFeedbackRedactionSummary
// ---------------------------------------------------------------------------

describe("finalizeFeedbackRedactionSummary", () => {
  it("returns a summary with sorted arrays and the deterministic strategy tag", () => {
    const state = createFeedbackRedactionState();
    state.redactedFields.add("b.field");
    state.redactedFields.add("a.field");
    state.truncatedFields.add("z.field");
    state.counts.set("email", 2);
    state.counts.set("bearer_token", 1);

    const summary = finalizeFeedbackRedactionSummary(state);

    expect(summary.strategy).toBe("deterministic_feedback_v2");
    expect(summary.redactedFields).toEqual(["a.field", "b.field"]);
    expect(summary.truncatedFields).toEqual(["z.field"]);
    expect(summary.counts).toEqual({ bearer_token: 1, email: 2 });
  });

  it("returns empty arrays and counts when state is clean", () => {
    const state = createFeedbackRedactionState();
    const summary = finalizeFeedbackRedactionSummary(state);
    expect(summary.redactedFields).toEqual([]);
    expect(summary.truncatedFields).toEqual([]);
    expect(summary.omittedFields).toEqual([]);
    expect(summary.counts).toEqual({});
  });
});
