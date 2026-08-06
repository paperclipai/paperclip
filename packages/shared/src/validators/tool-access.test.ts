import { describe, expect, it } from "vitest";
import {
  connectionTokenRequestSchema,
  createToolConnectionSchema,
  startConnectionAuthorizationSchema,
  toolCredentialSecretRefSchema,
  toolRedactedValueSummarySchema,
  toolTransportConfigSchema,
} from "./tool-access.js";

describe("tool access validators", () => {
  it("defaults connection token subjects to app", () => {
    expect(connectionTokenRequestSchema.parse({})).toEqual({ subject: { type: "app" } });
  });

  it("accepts user subjects, grant selection, and authorization input", () => {
    const request = connectionTokenRequestSchema.parse({
      subject: { type: "user", userId: "user-123" },
      grantId: "11111111-1111-4111-8111-111111111111",
    });
    expect(request.subject).toEqual({ type: "user", userId: "user-123" });
    expect(startConnectionAuthorizationSchema.parse({ subjectUserId: "user-123", scopes: ["read"] })).toEqual({
      subjectUserId: "user-123",
      scopes: ["read"],
    });
  });

  it("accepts multi-key credential annotations", () => {
    const parsed = toolCredentialSecretRefSchema.parse({
      secretId: "11111111-1111-4111-8111-111111111111",
      configPath: "credentials.apiKey",
      keyScope: "production",
      expiresAt: "2027-01-01T00:00:00Z",
    });
    expect(parsed.keyScope).toBe("production");
  });
  it("rejects raw credential-looking fields in transport config", () => {
    const parsed = toolTransportConfigSchema.safeParse({
      url: "https://example.test/mcp",
      headers: {
        Authorization: "Bearer raw-token",
      },
    });

    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues[0]?.message).toContain("credentialSecretRefs");
    }
  });

  it("accepts secret references for connection credentials", () => {
    const parsed = createToolConnectionSchema.safeParse({
      applicationId: "11111111-1111-4111-8111-111111111111",
      name: "GitHub fixture",
      connectionKind: "managed",
      transportConfig: { url: "https://example.test/mcp" },
      credentialSecretRefs: [
        {
          secretId: "22222222-2222-4222-8222-222222222222",
          configPath: "headers.Authorization",
          versionSelector: "latest",
        },
      ],
    });

    expect(parsed.success).toBe(true);
  });

  it("keeps invocation payload summaries redacted and bounded", () => {
    const parsed = toolRedactedValueSummarySchema.parse({
      summary: "Redacted arguments: 2 fields omitted.",
      sha256: "a".repeat(64),
      redactedFields: ["headers.Authorization", "body.token"],
    });

    expect(parsed.redactedFields).toEqual(["headers.Authorization", "body.token"]);
  });
});
