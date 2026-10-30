import { describe, expect, it } from "vitest";
import {
  createFeedbackRedactionState,
  finalizeFeedbackRedactionSummary,
  sanitizeFeedbackText,
  sanitizeFeedbackValue,
} from "../services/feedback-redaction.js";

describe("feedback redaction", () => {
  it.each([
    "https://agents.staging.example.com/team/chats/assistant",
    "api.openai.com and deployment.credentials.example.md",
    "paperclip.native-model-envelope.v3 and executor.coreTools.integrations.list",
    "Use bearer tokens for authentication and bearer authentication for requests.",
    "Document bearer authorization, bearer credentials, bearer schemes, and bearer flows.",
    "Use (bearer tokens). Preserve [bearer authentication] and {bearer credentials}.",
  ])("preserves non-secret chat context: %s", (input) => {
    const state = createFeedbackRedactionState();

    expect(sanitizeFeedbackText(input, state, "body", 10_000)).toBe(input);
    expect(finalizeFeedbackRedactionSummary(state).redactedFields).toEqual([]);
    expect(finalizeFeedbackRedactionSummary(state).counts).toEqual({});
  });

  it("redacts JWTs without counting neighboring hostnames as credentials", () => {
    const header = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString("base64url");
    const jwt = `${header}.abcdefghijk.abcdefghijkl`;
    const state = createFeedbackRedactionState();

    expect(sanitizeFeedbackText(`Visit api.openai.com; token ${jwt}`, state, "body", 10_000))
      .toBe("Visit api.openai.com; token [REDACTED_JWT]");
    expect(finalizeFeedbackRedactionSummary(state).counts).toEqual({ jwt: 1 });
    expect(finalizeFeedbackRedactionSummary(state).redactedFields).toEqual(["body"]);
  });

  it("still redacts a JWT with a short payload and signature", () => {
    const header = Buffer.from('{"alg":"HS256"}').toString("base64url");
    const state = createFeedbackRedactionState();
    const jwt = `${header}.e30.c2ln`;

    expect(sanitizeFeedbackText(jwt, state, "body", 10_000)).toBe("[REDACTED_JWT]");
    expect(finalizeFeedbackRedactionSummary(state).counts).toEqual({ jwt: 1 });
  });

  it("redacts encrypted JWTs", () => {
    const header = Buffer.from('{"alg":"RSA-OAEP","enc":"A256GCM"}').toString("base64url");
    const jwt = `${header}.abcdefghijk.abcdefghijkl.abcdefghijk.abcdefghijkl`;
    const state = createFeedbackRedactionState();

    expect(sanitizeFeedbackText(jwt, state, "body", 10_000)).toBe("[REDACTED_JWT]");
    expect(finalizeFeedbackRedactionSummary(state).counts).toEqual({ jwt: 1 });
  });

  it("redacts direct-encryption JWTs with an empty encrypted-key segment", () => {
    const header = Buffer.from('{"alg":"dir","enc":"A256GCM"}').toString("base64url");
    const jwt = `${header}..abcdefghijk.abcdefghijkl.abcdefghijk`;
    const state = createFeedbackRedactionState();

    expect(sanitizeFeedbackText(`Token ${jwt}; visit api.openai.com.`, state, "body", 10_000))
      .toBe("Token [REDACTED_JWT]; visit api.openai.com.");
    expect(finalizeFeedbackRedactionSummary(state).counts).toEqual({ jwt: 1 });
    expect(finalizeFeedbackRedactionSummary(state).redactedFields).toEqual(["body"]);
  });

  it("still redacts explicit credentials and personal information", () => {
    const state = createFeedbackRedactionState();
    const input = [
      "api_key=opaque-value",
      "Bearer abcdefghijklmnop",
      "ghp_abcdefghijklmnopqrstuv",
      "sk-abcdefghijklmnopqrstuv",
      "postgresql://admin:password@example.com/db",
      "person@example.com",
      "+1 (415) 555-1234",
    ].join("\n");
    const output = sanitizeFeedbackText(input, state, "body", 10_000);

    for (const value of input.split("\n")) expect(output).not.toContain(value);
    expect(output).toContain("Bearer [REDACTED_TOKEN]");
    expect(output).toContain("[REDACTED_EMAIL]");
    expect(output).toContain("[REDACTED_PHONE]");
  });

  it("preserves nested metadata while masking structured secrets", () => {
    const state = createFeedbackRedactionState();
    const input = {
      body: "Visit api.openai.com and use bearer tokens.",
      tokenPolicy: "least privilege",
      nested: [{ apiKey: "opaque-value", path: "deployment.credentials.example.md" }],
    };

    expect(sanitizeFeedbackValue(input, state, "bundle", 10_000)).toEqual({
      ...input,
      nested: [{ apiKey: "***REDACTED***", path: "deployment.credentials.example.md" }],
    });
  });
});
