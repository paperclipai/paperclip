import { describe, expect, it } from "vitest";
import { REDACTED_EVENT_VALUE, sanitizeRecord } from "../redaction.js";

/**
 * Defense-in-depth: adapterConfig.mcpServers flows through sanitizeRecord in
 * config-revision snapshots, activity-log details, and API GET responses.
 * Plain sensitive values must be redacted; secret_refs must pass through so
 * the UI can keep rendering the binding.
 */
describe("sanitizeRecord — mcpServers", () => {
  it("redacts plain Authorization headers and bearer tokens but keeps secret_refs", () => {
    const sanitized = sanitizeRecord({
      mcpServers: {
        linear: {
          transport: "http",
          url: "https://mcp.linear.app/mcp",
          headers: {
            Authorization: "Bearer lin_api_super_secret",
            "X-Env": "prod",
          },
          auth: {
            type: "bearer",
            token: { type: "plain", value: "raw-token" },
          },
        },
        bound: {
          transport: "http",
          url: "https://x.example/mcp",
          headers: {
            Authorization: { type: "secret_ref", secretId: "11111111-1111-1111-1111-111111111111" },
          },
        },
      },
    });

    const servers = sanitized.mcpServers as Record<string, Record<string, unknown>>;
    const linearHeaders = servers.linear.headers as Record<string, unknown>;
    expect(linearHeaders.Authorization).toBe(REDACTED_EVENT_VALUE);
    expect(linearHeaders["X-Env"]).toBe("prod");

    // The whole "auth" key matches the sensitive-key pattern, so generic
    // sanitization flattens it to the redaction sentinel — nothing inside a
    // bearer/oauth auth object can leak through snapshots or logs.
    expect(servers.linear.auth).toBe(REDACTED_EVENT_VALUE);

    const boundHeaders = servers.bound.headers as Record<string, unknown>;
    expect(boundHeaders.Authorization).toEqual({
      type: "secret_ref",
      secretId: "11111111-1111-1111-1111-111111111111",
    });
  });

  it("redacts sensitive stdio env values by key while keeping benign keys", () => {
    const sanitized = sanitizeRecord({
      mcpServers: {
        files: {
          transport: "stdio",
          command: "npx",
          env: {
            FILES_API_KEY: "sk-secret",
            ROOT_DIR: "/srv/files",
          },
        },
      },
    });
    const env = (sanitized.mcpServers as Record<string, Record<string, unknown>>).files
      .env as Record<string, unknown>;
    expect(env.FILES_API_KEY).toBe(REDACTED_EVENT_VALUE);
    expect(env.ROOT_DIR).toBe("/srv/files");
  });
});
