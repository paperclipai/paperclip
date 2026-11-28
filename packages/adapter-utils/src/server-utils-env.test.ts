import { describe, expect, it } from "vitest";
import {
  buildLocalAgentProcessEnv,
  sanitizeInheritedPaperclipEnv,
} from "./agent-environment.js";

describe("sanitizeInheritedPaperclipEnv", () => {
  it("drops the host-only Paperclip CLI command pointer", () => {
    expect(sanitizeInheritedPaperclipEnv({
      PAPERCLIPAI_CMD: "node /missing/paperclipai/dist/index.js",
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
      PATH: "/usr/bin",
    });
  });

  it("removes server-only credentials while retaining ordinary agent environment", () => {
    expect(
      sanitizeInheritedPaperclipEnv({
        DATABASE_URL: "postgres://control-plane",
        DATABASE_MIGRATION_URL: "postgres://migration-role",
        PGPASSWORD: "database-password",
        PGPASSFILE: "/run/secrets/pgpass",
        POSTGRES_PASSWORD: "postgres-password",
        BETTER_AUTH_SECRET: "auth-secret",
        PAPERCLIP_AGENT_JWT_SECRET: "agent-jwt-secret",
        PAPERCLIP_DECISION_SIGNING_SECRET: "decision-secret",
        PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "tool-action-secret",
        PLUNK_REPORT_TOKEN: "report-token",
        PATH: "/usr/bin",
        LANG: "en_US.UTF-8",
        OPENAI_API_KEY: "agent-provider-key",
        SERVICE_ENDPOINT: "https://service.example.test",
      }),
    ).toEqual({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      OPENAI_API_KEY: "agent-provider-key",
      SERVICE_ENDPOINT: "https://service.example.test",
    });
  });

  it("allows an explicit agent binding to supply an otherwise server-only key", () => {
    expect(
      buildLocalAgentProcessEnv(
        {
          DATABASE_URL: "postgres://control-plane",
          PLUNK_REPORT_TOKEN: "host-report-token",
          PATH: "/usr/bin",
          LANG: "en_US.UTF-8",
        },
        {
          DATABASE_URL: "postgres://agent-binding",
          PLUNK_REPORT_TOKEN: "agent-report-token",
        },
      ),
    ).toEqual({
      PATH: "/usr/bin",
      LANG: "en_US.UTF-8",
      DATABASE_URL: "postgres://agent-binding",
      PLUNK_REPORT_TOKEN: "agent-report-token",
    });
  });
});
