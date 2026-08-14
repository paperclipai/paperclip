import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

  it("inherits a proxy address but not credentials embedded in it", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = buildInheritedAgentEnv({
      ...QUICKSTART_SERVER_ENV,
      PAPERCLIP_AGENT_ENV_INHERIT: "allowlist",
      https_proxy: "http://proxy-user:proxy-password@proxy.internal:3128",
      no_proxy: "localhost,127.0.0.1",
    });
    expect(env.https_proxy).toBeUndefined();
    expect(env.no_proxy).toBe("localhost,127.0.0.1");
  });

  it("inherits a credentialed proxy only when it is named explicitly", () => {
    const credentialed = "http://proxy-user:proxy-password@proxy.internal:3128";
    expect(isInheritableAgentEnvKey("HTTPS_PROXY", {}, credentialed)).toBe(false);
    expect(
      isInheritableAgentEnvKey("HTTPS_PROXY", { PAPERCLIP_AGENT_ENV_ALLOW: "HTTPS_PROXY" }, credentialed),
    ).toBe(true);
    expect(isInheritableAgentEnvKey("HTTPS_PROXY", {}, "http://proxy.internal:3128")).toBe(true);
    // A bare host:port has no authority delimiter and carries no credentials.
    expect(isInheritableAgentEnvKey("HTTPS_PROXY", {}, "proxy.internal:3128")).toBe(true);
  });
});

describe("adapter runtime env construction", () => {
  afterEach(() => {
    resetDroppedAgentEnvKeysWarningForTests();
    vi.restoreAllMocks();
  });

  // Local adapters build a runtime env by spreading the server environment and
  // then the explicitly configured agent env on top. Spreading process.env
  // directly would put every filtered secret back, so the adapters spread the
  // filtered environment instead. This test binds that contract.
  it("does not restore filtered server secrets when adapter config is merged on top", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const serverEnv: NodeJS.ProcessEnv = {
      ...QUICKSTART_SERVER_ENV,
      PAPERCLIP_AGENT_ENV_INHERIT: "allowlist",
    };
    const adapterConfigEnv: NodeJS.ProcessEnv = { ANTHROPIC_API_KEY: "sk-ant-from-agent-config" };

    const runtimeEnv: NodeJS.ProcessEnv = { ...buildInheritedAgentEnv(serverEnv), ...adapterConfigEnv };

    expect(runtimeEnv.BETTER_AUTH_SECRET).toBeUndefined();
    expect(runtimeEnv.POSTGRES_PASSWORD).toBeUndefined();
    expect(runtimeEnv.DATABASE_URL).toBeUndefined();
    // Explicit configuration still wins, which is the documented behaviour.
    expect(runtimeEnv.ANTHROPIC_API_KEY).toBe("sk-ant-from-agent-config");
    expect(runtimeEnv.PATH).toBe("/usr/bin");
  });
});

// The filter only holds if every adapter that materialises the server
// environment for a child process goes through buildInheritedAgentEnv. A raw
// `...process.env` spread reintroduces the secrets one merge later, which is
// invisible in a unit test of the helper itself. This guard fails on the
// source instead.
describe("adapter sources do not spread process.env directly", () => {
  const adaptersDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "adapters");

  function collectServerSources(dir: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules" || entry.name === "dist") continue;
        found.push(...collectServerSources(full));
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
      found.push(full);
    }
    return found;
  }

  it("routes inherited server env through buildInheritedAgentEnv", () => {
    const offenders = collectServerSources(adaptersDir).filter((file) =>
      readFileSync(file, "utf8").includes("...process.env"),
    );
    expect(offenders).toEqual([]);
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
