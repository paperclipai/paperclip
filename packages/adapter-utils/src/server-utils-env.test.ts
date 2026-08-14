import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildInheritedAgentEnv,
  isInheritableAgentEnvKey,
  resetDroppedAgentEnvKeysWarningForTests,
  resolveAgentEnvInheritMode,
  sanitizeInheritedPaperclipEnv,
} from "./server-utils.js";

// A server environment shaped like docker/docker-compose.quickstart.yml, where
// the server secrets and the LLM provider key are in the same env block.
const QUICKSTART_SERVER_ENV: NodeJS.ProcessEnv = {
  PATH: "/usr/bin",
  HOME: "/home/node",
  LC_ALL: "C.UTF-8",
  https_proxy: "http://proxy.internal:3128",
  ANTHROPIC_API_KEY: "sk-ant-test",
  BETTER_AUTH_SECRET: "server-only-signing-secret",
  BETTER_AUTH_BASE_URL: "http://127.0.0.1:3100",
  POSTGRES_PASSWORD: "server-only-db-password",
  DATABASE_URL: "postgres://paperclip:server-only-db-password@db:5432/paperclip",
  PAPERCLIP_RUNTIME_API_URL: "http://127.0.0.1:3100",
  PAPERCLIP_HOME: "/data/paperclip",
};

describe("buildInheritedAgentEnv", () => {
  afterEach(() => {
    resetDroppedAgentEnvKeysWarningForTests();
    vi.restoreAllMocks();
  });

  it("defaults to the current inherit-everything behaviour", () => {
    expect(resolveAgentEnvInheritMode(QUICKSTART_SERVER_ENV)).toBe("all");
    expect(buildInheritedAgentEnv(QUICKSTART_SERVER_ENV)).toEqual(
      sanitizeInheritedPaperclipEnv(QUICKSTART_SERVER_ENV),
    );
  });

  it("keeps server secrets out of the agent env in allowlist mode", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = buildInheritedAgentEnv({
      ...QUICKSTART_SERVER_ENV,
      PAPERCLIP_AGENT_ENV_INHERIT: "allowlist",
    });

    expect(env).not.toHaveProperty("BETTER_AUTH_SECRET");
    expect(env).not.toHaveProperty("BETTER_AUTH_BASE_URL");
    expect(env).not.toHaveProperty("POSTGRES_PASSWORD");
    expect(env).not.toHaveProperty("DATABASE_URL");
    // No inherited value survives under a different name either.
    expect(Object.values(env)).not.toContain("server-only-signing-secret");
    expect(Object.values(env).join("\n")).not.toContain("server-only-db-password");
  });

  it("keeps the toolchain keys an agent process needs", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = buildInheritedAgentEnv({
      ...QUICKSTART_SERVER_ENV,
      PAPERCLIP_AGENT_ENV_INHERIT: "allowlist",
    });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/node");
    expect(env.LC_ALL).toBe("C.UTF-8");
    expect(env.https_proxy).toBe("http://proxy.internal:3128");
    // sanitizeInheritedPaperclipEnv rules still decide the PAPERCLIP_* keys.
    expect(env.PAPERCLIP_RUNTIME_API_URL).toBe("http://127.0.0.1:3100");
    expect(env).not.toHaveProperty("PAPERCLIP_HOME");
  });

  it("inherits deployment keys named in PAPERCLIP_AGENT_ENV_ALLOW", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = buildInheritedAgentEnv({
      ...QUICKSTART_SERVER_ENV,
      AWS_REGION: "eu-west-1",
      PAPERCLIP_AGENT_ENV_INHERIT: "allowlist",
      PAPERCLIP_AGENT_ENV_ALLOW: "ANTHROPIC_API_KEY, AWS_*",
    });

    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-test");
    expect(env.AWS_REGION).toBe("eu-west-1");
    // The allow list does not widen to the server secrets.
    expect(env).not.toHaveProperty("BETTER_AUTH_SECRET");
  });

  it("reports the removed variable names once, without their values", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const serverEnv = { ...QUICKSTART_SERVER_ENV, PAPERCLIP_AGENT_ENV_INHERIT: "allowlist" };

    buildInheritedAgentEnv(serverEnv);
    buildInheritedAgentEnv(serverEnv);

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0]?.[0] ?? "");
    expect(message).toContain("BETTER_AUTH_SECRET");
    expect(message).not.toContain("server-only-signing-secret");
  });

  it("matches allow patterns and proxy keys case-insensitively", () => {
    expect(isInheritableAgentEnvKey("HTTPS_PROXY", {})).toBe(true);
    expect(isInheritableAgentEnvKey("no_proxy", {})).toBe(true);
    expect(isInheritableAgentEnvKey("BETTER_AUTH_SECRET", {})).toBe(false);
    expect(isInheritableAgentEnvKey("aws_region", { PAPERCLIP_AGENT_ENV_ALLOW: "aws_*" })).toBe(true);
    expect(isInheritableAgentEnvKey("BETTER_AUTH_SECRET", { PAPERCLIP_AGENT_ENV_ALLOW: "" })).toBe(false);
  });
});

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
