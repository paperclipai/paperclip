import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { writeContext } from "../client/context.js";
import { setStoredBoardCredential } from "../client/board-auth.js";
import { resolveApiBase, resolveCommandContext } from "../commands/client/common.js";

const ORIGINAL_ENV = { ...process.env };

function createTempPath(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-cli-common-"));
  return path.join(dir, name);
}

describe("resolveCommandContext", () => {
  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PAPERCLIP_API_URL;
    delete process.env.PAPERCLIP_API_KEY;
    delete process.env.PAPERCLIP_COMPANY_ID;
    delete process.env.PAPERCLIP_AUTH_STORE;
    delete process.env.PAPERCLIP_SERVER_PORT;
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses profile defaults when options/env are not provided", () => {
    const contextPath = createTempPath("context.json");

    writeContext(
      {
        version: 2,
        currentProfile: "ops",
        profiles: {
          ops: {
            apiBase: "http://127.0.0.1:9999",
            companyId: "company-profile",
            apiKeyEnvVarName: "AGENT_KEY",
          },
        },
      },
      contextPath,
    );
    process.env.AGENT_KEY = "key-from-env";

    const resolved = resolveCommandContext({ context: contextPath }, { requireCompany: true });
    expect(resolved.api.apiBase).toBe("http://127.0.0.1:9999");
    expect(resolved.companyId).toBe("company-profile");
    expect(resolved.api.apiKey).toBe("key-from-env");
  });

  it("prefers explicit options over profile values", () => {
    const contextPath = createTempPath("context.json");
    writeContext(
      {
        version: 2,
        currentProfile: "default",
        profiles: {
          default: {
            apiBase: "http://profile:3100",
            companyId: "company-profile",
          },
        },
      },
      contextPath,
    );

    const resolved = resolveCommandContext(
      {
        context: contextPath,
        apiBase: "http://override:3200",
        apiKey: "direct-token",
        companyId: "company-override",
      },
      { requireCompany: true },
    );

    expect(resolved.api.apiBase).toBe("http://override:3200");
    expect(resolved.companyId).toBe("company-override");
    expect(resolved.api.apiKey).toBe("direct-token");
  });

  it("throws when company is required but unresolved", () => {
    const contextPath = createTempPath("context.json");
    writeContext(
      {
        version: 2,
        currentProfile: "default",
        profiles: { default: {} },
      },
      contextPath,
    );

    expect(() =>
      resolveCommandContext({ context: contextPath, apiBase: "http://localhost:3100" }, { requireCompany: true }),
    ).toThrow(/Company ID is required/);
  });

  it("resolves api base by explicit, env, profile, then config/default precedence", () => {
    const configPath = createTempPath("config.json");
    fs.writeFileSync(configPath, JSON.stringify({
      $meta: { version: 1, updatedAt: "2026-05-23T00:00:00.000Z", source: "onboard" },
      database: { mode: "embedded-postgres" },
      logging: { mode: "file" },
      server: { deploymentMode: "local_trusted", exposure: "private", host: "127.0.0.1", port: 4111 },
    }));

    expect(resolveApiBase({ apiBase: "http://explicit:1", config: configPath }, { apiBase: "http://profile:2" }))
      .toBe("http://explicit:1");

    process.env.PAPERCLIP_API_URL = "http://env:3/";
    expect(resolveApiBase({ config: configPath }, { apiBase: "http://profile:2" })).toBe("http://env:3");

    delete process.env.PAPERCLIP_API_URL;
    expect(resolveApiBase({ config: configPath }, { apiBase: "http://profile:2/" })).toBe("http://profile:2");
    expect(resolveApiBase({ config: configPath }, {})).toBe("http://localhost:4111");
  });

  it("prefers explicit and env tokens over profile env and stored board auth", () => {
    const contextPath = createTempPath("context.json");
    const authStorePath = createTempPath("auth.json");
    process.env.PAPERCLIP_AUTH_STORE = authStorePath;
    process.env.PROFILE_KEY = "profile-token";
    setStoredBoardCredential({
      apiBase: "http://localhost:3100",
      token: "stored-board-token",
      userId: "user-1",
      storePath: authStorePath,
    });
    writeContext(
      {
        version: 2,
        currentProfile: "default",
        profiles: {
          default: {
            apiBase: "http://localhost:3100",
            apiKeyEnvVarName: "PROFILE_KEY",
          },
        },
      },
      contextPath,
    );

    const profileResolved = resolveCommandContext({ context: contextPath });
    expect(profileResolved.api.apiKey).toBe("profile-token");
    expect(profileResolved.authSource).toBe("profile_env");

    process.env.PAPERCLIP_API_KEY = "env-token";
    const envResolved = resolveCommandContext({ context: contextPath });
    expect(envResolved.api.apiKey).toBe("env-token");
    expect(envResolved.authSource).toBe("env");

    const explicitResolved = resolveCommandContext({ context: contextPath, apiKey: "explicit-token" });
    expect(explicitResolved.api.apiKey).toBe("explicit-token");
    expect(explicitResolved.authSource).toBe("explicit");
  });
});
