import { describe, expect, it } from "vitest";
import {
  connectionTokenRequestSchema,
  connectToolAppSchema,
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

  it("keeps app method configuration separate from secrets", () => {
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      connectionMethodKey: "mcp-api-key",
      configValues: { projectId: "12345", readOnly: true, features: "insights" },
    }).success).toBe(true);
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      configValues: { projectId: "12345", apiKey: "phx_raw" },
    }).success).toBe(false);
  });

  // PAP-17087: the guided generic flow and paste-config both reach the connect
  // endpoint, so unsafe header names/values are rejected once at this boundary.
  it("accepts generic advanced-authentication input for a pasted URL", () => {
    const parsed = connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      authMode: "custom_headers",
      credentialValues: {
        "headers.X-Api-Key": "phx_abc123",
        "headers.X-PostHog-Project-Id": "12345",
      },
    });
    expect(parsed.success).toBe(true);

    const manualClient = connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      authMode: "oauth",
      oauthClient: { clientId: "client-abc", clientSecret: "shhh" },
    });
    expect(manualClient.success).toBe(true);
  });

  it("rejects header credentials Paperclip refuses to send", () => {
    for (const configPath of ["headers.Host", "headers.Cookie", "headers.Transfer-Encoding", "headers.Sec-Fetch-Mode"]) {
      const parsed = connectToolAppSchema.safeParse({
        link: "https://mcp.example.test/mcp",
        credentialValues: { [configPath]: "value" },
      });
      expect(parsed.success, configPath).toBe(false);
    }
  });

  it("rejects header names and values that could split the outbound request", () => {
    const badName = connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      credentialValues: { "headers.X-Bad\r\nX-Injected": "value" },
    });
    expect(badName.success).toBe(false);

    const badValue = connectToolAppSchema.safeParse({
      link: "https://mcp.example.test/mcp",
      credentialValues: { "headers.X-Api-Key": "abc\r\nX-Injected: 1" },
    });
    expect(badValue.success).toBe(false);
    if (!badValue.success) {
      // The message names the header but must never echo the rejected value.
      const message = badValue.error.issues[0]?.message ?? "";
      expect(message).toContain("X-Api-Key");
      expect(message).not.toContain("X-Injected");
    }
  });

  it("keeps generic advanced authentication off the curated gallery path", () => {
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      authMode: "bearer",
    }).success).toBe(false);
    expect(connectToolAppSchema.safeParse({
      galleryKey: "posthog",
      oauthClient: { clientId: "client-abc" },
    }).success).toBe(false);
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
