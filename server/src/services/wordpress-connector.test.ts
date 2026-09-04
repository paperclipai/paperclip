import { describe, expect, it, vi } from "vitest";
import {
  WORDPRESS_APPLICATION_PASSWORD_ALLOWLIST_KEY,
  WORDPRESS_AUTH_CHECK_TOOL,
  WORDPRESS_MAX_RESPONSE_BYTES,
  assertWordPressConnectionConfigUnchanged,
  assertWordPressCredentialRefs,
  assertWordPressConnectionScope,
  executeWordPressAuthenticationCheck,
  validateWordPressBaseUrl,
  wordPressCredentialProjection,
} from "./wordpress-connector.js";
import { redactSensitiveText, sanitizeRecord } from "../redaction.js";

const SENTINEL = "wp-app-password-SYNTHETIC-DO-NOT-LEAK";

describe("read-only WordPress connector", () => {
  it("has one exact read-only tool and class-3 allowlist identity", () => {
    expect(WORDPRESS_AUTH_CHECK_TOOL).toEqual({
      name: "wordpress_authentication_check",
      title: "Check WordPress authentication",
      description: "Verify the configured WordPress identity without exposing credentials or profile details.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    });
    expect(WORDPRESS_APPLICATION_PASSWORD_ALLOWLIST_KEY).toBe("wordpress.application_password");
    expect(WORDPRESS_AUTH_CHECK_TOOL.name).not.toMatch(/create|update|delete|publish|write/i);
    expect(wordPressCredentialProjection("credentials.application_password")).toEqual({
      projectionClass: "class_3_static_lease",
      projectionAllowlistKey: "wordpress.application_password",
    });
    expect(wordPressCredentialProjection("credentials.username")).toEqual({});
  });

  it.each([
    "http://example.test",
    "https://user:pass@example.test",
    "https://example.test?next=/evil",
    "https://example.test/#fragment",
    "https://example.test/wp-json/wp/v2/posts",
  ])("rejects unsafe or ambiguous base URL %s", (url) => {
    expect(() => validateWordPressBaseUrl(url)).toThrow();
  });

  it("normalizes only an HTTPS origin with an optional WordPress subdirectory", () => {
    expect(validateWordPressBaseUrl("https://example.test/blog/")).toBe("https://example.test/blog");
  });

  it("requires the intended project and an explicitly allowed agent", () => {
    const binding = { companyId: "company-a", projectId: "project-a", allowedAgentIds: ["agent-a"] };
    expect(() => assertWordPressConnectionScope(binding, {
      companyId: "company-a", projectId: "project-b", agentId: "agent-a",
    })).toThrow(/scope/i);
    expect(() => assertWordPressConnectionScope(binding, {
      companyId: "company-a", projectId: "project-a", agentId: "agent-b",
    })).toThrow(/scope/i);
  });

  it("keeps the credential recipient, scope, and class-3 binding immutable", () => {
    const config = {
      sourceTemplateKey: "wordpress",
      connectionMethodKey: "application-password-readonly",
      methodConfig: { baseUrl: "https://example.test/blog", projectId: "project-a", allowedAgentIds: "agent-a,agent-b" },
    };
    expect(() => assertWordPressConnectionConfigUnchanged(config, {
      ...config,
      methodConfig: { ...config.methodConfig, baseUrl: "https://evil.test" },
    })).toThrow(/cannot be changed/i);
    expect(() => assertWordPressConnectionConfigUnchanged(config, {
      ...config,
      methodConfig: { ...config.methodConfig, allowedAgentIds: "agent-a,agent-c" },
    })).toThrow(/cannot be changed/i);
    expect(() => assertWordPressCredentialRefs([
      { configPath: "credentials.username" },
      {
        configPath: "credentials.application_password",
        projectionClass: "class_3_static_lease",
        projectionAllowlistKey: "wordpress.application_password",
      },
    ])).not.toThrow();
    expect(() => assertWordPressCredentialRefs([
      { configPath: "credentials.username" },
      { configPath: "credentials.application_password" },
    ])).toThrow(/class-3/i);
  });

  it("calls only users/me, rejects cross-origin redirects, and returns a masked result", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({
      id: 42,
      name: "Secret Admin Name",
      slug: "secret-admin",
      email: "admin@example.test",
    }), { status: 200, headers: { "content-type": "application/json" } }));

    const result = await executeWordPressAuthenticationCheck({
      baseUrl: "https://example.test/blog",
      username: "synthetic-user",
      applicationPassword: SENTINEL,
      request,
    });

    expect(request).toHaveBeenCalledWith(
      "https://example.test/blog/wp-json/wp/v2/users/me?context=edit",
      expect.objectContaining({ method: "GET", redirect: "manual" }),
    );
    expect(result).toEqual({ authenticated: true, userId: 42 });
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
    expect(JSON.stringify(result)).not.toContain("Secret Admin Name");

    const redirect = vi.fn(async () => new Response(null, {
      status: 302,
      headers: { location: "https://evil.test/wp-json/wp/v2/users/me?context=edit" },
    }));
    await expect(executeWordPressAuthenticationCheck({
      baseUrl: "https://example.test",
      username: "synthetic-user",
      applicationPassword: SENTINEL,
      request: redirect,
    })).rejects.toThrow(/redirect/i);
    await expect(executeWordPressAuthenticationCheck({
      baseUrl: "https://example.test",
      username: "synthetic-user",
      applicationPassword: SENTINEL,
      request: vi.fn(async () => new Response(SENTINEL, { status: 401 })),
    })).rejects.not.toThrow(SENTINEL);
    await expect(executeWordPressAuthenticationCheck({
      baseUrl: "https://example.test",
      username: "synthetic-user",
      applicationPassword: SENTINEL,
      request: vi.fn(async () => new Response("x".repeat(WORDPRESS_MAX_RESPONSE_BYTES + 1))),
    })).rejects.toThrow(/invalid response/i);
  });

  it("keeps the synthetic credential out of API, config, prompt, audit, log, and error projections", () => {
    const projected = sanitizeRecord({
      apiResponse: { applicationPassword: SENTINEL },
      connectionConfig: { credentials: { application_password: SENTINEL } },
      activity: { password: SENTINEL },
      runLog: { authorization: SENTINEL },
      prompt: { credential: SENTINEL },
      toolError: { secret: SENTINEL },
    });
    expect(JSON.stringify(projected)).not.toContain(SENTINEL);
    expect(redactSensitiveText(`Authorization: Basic ${SENTINEL}`)).not.toContain(SENTINEL);
  });
});
