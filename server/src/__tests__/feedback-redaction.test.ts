import { describe, it, expect } from "vitest";
import {
  createFeedbackRedactionState,
  sanitizeFeedbackText,
  sanitizeFeedbackValue,
  finalizeFeedbackRedactionSummary,
  stableStringify,
  sha256Digest,
} from "../services/feedback-redaction.js";

// ---------------------------------------------------------------------------
// createFeedbackRedactionState
// ---------------------------------------------------------------------------

describe("createFeedbackRedactionState", () => {
  it("returns empty sets and map", () => {
    const state = createFeedbackRedactionState();
    expect(state.redactedFields.size).toBe(0);
    expect(state.truncatedFields.size).toBe(0);
    expect(state.omittedFields.size).toBe(0);
    expect(state.notes.size).toBe(0);
    expect(state.counts.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sanitizeFeedbackText — pattern redaction
// ---------------------------------------------------------------------------

describe("sanitizeFeedbackText", () => {
  function redact(input: string, maxLength = 10_000) {
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackText(input, state, "field", maxLength);
    return { output, state };
  }

  it("passes through text with no sensitive content unchanged", () => {
    const { output } = redact("Hello, world!");
    expect(output).toBe("Hello, world!");
  });

  it("redacts PEM block", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAK==\n-----END RSA PRIVATE KEY-----";
    const { output, state } = redact(pem);
    expect(output).toContain("[REDACTED_PEM_BLOCK]");
    expect(output).not.toContain("MIIEowIBAAK");
    expect(state.counts.get("pem_block")).toBe(1);
  });

  it("redacts secret key assignments", () => {
    const { output, state } = redact("api_key=super-secret-value and password=hunter2");
    expect(output).toContain("api_key=[REDACTED]");
    expect(output).toContain("password=[REDACTED]");
    expect(output).not.toContain("super-secret-value");
    expect(state.counts.get("secret_assignment")).toBeGreaterThanOrEqual(2);
  });

  it("redacts bearer tokens", () => {
    // Avoid "Authorization:" prefix — that triggers secret_assignment first
    const { output, state } = redact("header value: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig");
    expect(output).toContain("Bearer [REDACTED_TOKEN]");
    expect(state.counts.get("bearer_token")).toBeGreaterThanOrEqual(1);
  });

  it("redacts GitHub tokens (ghp_ prefix)", () => {
    const { output, state } = redact("token: ghp_A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6");
    expect(output).toContain("[REDACTED_GITHUB_TOKEN]");
    expect(state.counts.get("github_token")).toBe(1);
  });

  it("redacts GitHub OAuth tokens (gho_ prefix)", () => {
    // Use a prefix that won't trigger the secret_assignment pattern first
    const { output } = redact("found gho_A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6 in logs");
    expect(output).toContain("[REDACTED_GITHUB_TOKEN]");
  });

  it("redacts Anthropic/OpenAI API keys (sk- prefix)", () => {
    const { output, state } = redact("key=sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ");
    expect(output).toContain("[REDACTED_API_KEY]");
    expect(state.counts.get("provider_api_key")).toBe(1);
  });

  it("redacts JWT tokens (three-part dot structure)", () => {
    const { output, state } = redact("token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0In0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c");
    expect(output).toContain("[REDACTED_JWT]");
    expect(state.counts.get("jwt")).toBeGreaterThanOrEqual(1);
  });

  it("redacts database connection strings", () => {
    const { output, state } = redact("postgres://user:pass@host:5432/mydb");
    expect(output).toContain("[REDACTED_CONNECTION_STRING]");
    expect(state.counts.get("dsn")).toBe(1);
  });

  it("redacts mongodb+srv connection strings", () => {
    const { output } = redact("mongodb+srv://user:pass@cluster.mongodb.net/db");
    expect(output).toContain("[REDACTED_CONNECTION_STRING]");
  });

  it("redacts email addresses", () => {
    const { output, state } = redact("Contact: alice@example.com for help");
    expect(output).toContain("[REDACTED_EMAIL]");
    expect(output).not.toContain("alice@example.com");
    expect(state.counts.get("email")).toBe(1);
  });

  it("redacts phone numbers", () => {
    const { output, state } = redact("Call +1 (555) 867-5309 for support");
    expect(output).toContain("[REDACTED_PHONE]");
    expect(state.counts.get("phone")).toBe(1);
  });

  it("records the field path when redaction occurs", () => {
    const state = createFeedbackRedactionState();
    sanitizeFeedbackText("api_key=secret", state, "config.apiKey", 10_000);
    expect(state.redactedFields.has("config.apiKey")).toBe(true);
  });

  it("does not record field path when nothing is redacted", () => {
    const { state } = redact("plain text with no secrets");
    expect(state.redactedFields.size).toBe(0);
  });

  it("truncates text exceeding maxLength and records the field", () => {
    const state = createFeedbackRedactionState();
    const long = "a".repeat(100);
    const output = sanitizeFeedbackText(long, state, "body", 10);
    // Implementation: slice(0, maxLength-1) + "..." = (maxLength-1) + 3 chars
    expect(output).toMatch(/\.\.\.$/);
    expect(output.length).toBeLessThan(100);
    expect(state.truncatedFields.has("body")).toBe(true);
  });

  it("does not truncate text shorter than maxLength", () => {
    const state = createFeedbackRedactionState();
    const text = "short";
    const output = sanitizeFeedbackText(text, state, "body", 1000);
    expect(output).toBe(text);
    expect(state.truncatedFields.size).toBe(0);
  });

  it("handles multiple patterns on a single input", () => {
    const { output, state } = redact(
      "api_key=abc123 and email user@test.com with postgres://x:y@host/db"
    );
    expect(output).not.toContain("abc123");
    expect(output).not.toContain("user@test.com");
    expect(output).not.toContain("postgres://");
    expect(state.counts.size).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// sanitizeFeedbackValue
// ---------------------------------------------------------------------------

describe("sanitizeFeedbackValue", () => {
  function redactValue(value: unknown, maxLength = 10_000) {
    const state = createFeedbackRedactionState();
    const output = sanitizeFeedbackValue(value, state, "root", maxLength);
    return { output, state };
  }

  it("sanitizes string values", () => {
    const { output } = redactValue("api_key=secret");
    expect(output).toContain("[REDACTED]");
  });

  it("passes through non-string primitives unchanged", () => {
    expect(redactValue(42).output).toBe(42);
    expect(redactValue(true).output).toBe(true);
    expect(redactValue(null).output).toBeNull();
  });

  it("sanitizes strings inside arrays", () => {
    const { output } = redactValue(["api_key=secret", "safe text"]);
    const arr = output as string[];
    expect(arr[0]).toContain("[REDACTED]");
    expect(arr[1]).toBe("safe text");
  });

  it("recursively sanitizes nested plain objects", () => {
    const { output } = redactValue({ nested: { token: "ghp_A1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6" } });
    const obj = output as Record<string, unknown>;
    expect(JSON.stringify(obj)).not.toContain("ghp_");
  });

  it("redacts object keys matching secret patterns via sanitizeRecord", () => {
    const { output, state } = redactValue({ api_key: "my-secret" });
    const obj = output as Record<string, unknown>;
    expect(obj["api_key"]).not.toBe("my-secret");
    expect(state.counts.get("structured_secret")).toBe(1);
  });

  it("handles nested arrays with mixed content", () => {
    const { output } = redactValue([42, "api_key=sec", { safe: "value" }]);
    const arr = output as unknown[];
    expect(arr[0]).toBe(42);
    expect(arr[1]).toContain("[REDACTED]");
  });
});

// ---------------------------------------------------------------------------
// finalizeFeedbackRedactionSummary
// ---------------------------------------------------------------------------

describe("finalizeFeedbackRedactionSummary", () => {
  it("returns sorted, serializable summary", () => {
    const state = createFeedbackRedactionState();
    state.redactedFields.add("b.field");
    state.redactedFields.add("a.field");
    state.truncatedFields.add("c.field");
    state.counts.set("email", 2);
    state.counts.set("bearer_token", 1);

    const summary = finalizeFeedbackRedactionSummary(state);
    expect(summary.strategy).toBe("deterministic_feedback_v2");
    expect(summary.redactedFields).toEqual(["a.field", "b.field"]);
    expect(summary.truncatedFields).toEqual(["c.field"]);
    expect(summary.counts).toEqual({ bearer_token: 1, email: 2 });
  });

  it("returns empty arrays and object when state is empty", () => {
    const summary = finalizeFeedbackRedactionSummary(createFeedbackRedactionState());
    expect(summary.redactedFields).toEqual([]);
    expect(summary.truncatedFields).toEqual([]);
    expect(summary.omittedFields).toEqual([]);
    expect(summary.notes).toEqual([]);
    expect(summary.counts).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// stableStringify
// ---------------------------------------------------------------------------

describe("stableStringify", () => {
  it("serializes primitives the same as JSON.stringify", () => {
    expect(stableStringify(null)).toBe("null");
    expect(stableStringify(42)).toBe("42");
    expect(stableStringify("hello")).toBe('"hello"');
    expect(stableStringify(true)).toBe("true");
  });

  it("serializes arrays in order", () => {
    expect(stableStringify([1, 2, 3])).toBe("[1,2,3]");
    expect(stableStringify(["b", "a"])).toBe('["b","a"]');
  });

  it("sorts object keys alphabetically", () => {
    const result = stableStringify({ z: 1, a: 2, m: 3 });
    expect(result).toBe('{"a":2,"m":3,"z":1}');
  });

  it("produces identical output for objects with same content in different key order", () => {
    const a = stableStringify({ b: 2, a: 1 });
    const b = stableStringify({ a: 1, b: 2 });
    expect(a).toBe(b);
  });

  it("handles nested objects and arrays", () => {
    const result = stableStringify({ arr: [3, 1, 2], obj: { z: "last", a: "first" } });
    expect(result).toBe('{"arr":[3,1,2],"obj":{"a":"first","z":"last"}}');
  });
});

// ---------------------------------------------------------------------------
// sha256Digest
// ---------------------------------------------------------------------------

describe("sha256Digest", () => {
  it("returns a 64-character hex string", () => {
    const digest = sha256Digest("hello");
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic for the same input", () => {
    expect(sha256Digest({ a: 1, b: 2 })).toBe(sha256Digest({ b: 2, a: 1 }));
  });

  it("produces different digests for different inputs", () => {
    expect(sha256Digest("hello")).not.toBe(sha256Digest("world"));
  });

  it("works with null", () => {
    const digest = sha256Digest(null);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
