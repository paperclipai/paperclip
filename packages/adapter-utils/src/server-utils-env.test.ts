import { describe, expect, it } from "vitest";
import { sanitizeInheritedPaperclipEnv, stripServerOnlySecretEnv } from "./server-utils.js";

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
});

describe("stripServerOnlySecretEnv", () => {
  it("drops server signing and encryption secrets and keeps agent and provider keys", () => {
    expect(stripServerOnlySecretEnv({
      PAPERCLIP_AGENT_JWT_SECRET: "x",
      BETTER_AUTH_SECRET: "x",
      PAPERCLIP_SECRETS_MASTER_KEY: "x",
      PAPERCLIP_SECRETS_MASTER_KEY_FILE: "/path",
      PAPERCLIP_TOOL_ACTION_SIGNING_SECRET: "x",
      PAPERCLIP_TOOL_OAUTH_CLIENT_SECRET: "x",
      PAPERCLIP_TOOL_OAUTH_GOOGLE_CLIENT_SECRET: "x",
      PAPERCLIP_TOOL_OAUTH_GOOGLE_WORKSPACE_CLIENT_SECRET: "x",
      PAPERCLIP_TOOL_OAUTH_GOOGLE_CLIENT_ID: "client-id",
      PAPERCLIP_SECRETS_AWS_KMS_KEY_ID: "x",
      paperclip_agent_jwt_secret: "x",
      PAPERCLIP_API_KEY: "run-token",
      PAPERCLIP_AGENT_PRIVATE_KEY: "agent-key",
      DEEPSEEK_API_KEY: "provider",
      PATH: "/usr/bin",
    })).toEqual({
      PAPERCLIP_TOOL_OAUTH_GOOGLE_CLIENT_ID: "client-id",
      PAPERCLIP_API_KEY: "run-token",
      PAPERCLIP_AGENT_PRIVATE_KEY: "agent-key",
      DEEPSEEK_API_KEY: "provider",
      PATH: "/usr/bin",
    });
  });
});
