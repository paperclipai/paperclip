import { describe, expect, it } from "vitest";
import {
  AGENT_DEFAULT_NODE_ENV,
  agentNodeEnvDefault,
  applyAgentNodeEnvDefault,
  buildPaperclipEnv,
  sanitizeInheritedPaperclipEnv,
} from "./server-utils.js";

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

describe("agentNodeEnvDefault", () => {
  // The server image ships NODE_ENV=production; inheriting it into an agent
  // makes npm derive omit=["dev"] (no tsc/vitest installed) and bundlers
  // resolve the production React build (act() throws in component tests).
  it("neutralizes an inherited production NODE_ENV", () => {
    expect(agentNodeEnvDefault("production")).toBe(AGENT_DEFAULT_NODE_ENV);
  });

  it("falls back to the agent default when the host value is missing or blank", () => {
    expect(agentNodeEnvDefault(undefined)).toBe(AGENT_DEFAULT_NODE_ENV);
    expect(agentNodeEnvDefault("")).toBe(AGENT_DEFAULT_NODE_ENV);
    expect(agentNodeEnvDefault("   ")).toBe(AGENT_DEFAULT_NODE_ENV);
  });

  it("preserves a deliberate non-production host value", () => {
    expect(agentNodeEnvDefault("development")).toBe("development");
    expect(agentNodeEnvDefault("test")).toBe("test");
    expect(agentNodeEnvDefault("staging")).toBe("staging");
  });

  it("never resolves to production", () => {
    for (const host of ["production", " production ", undefined, ""]) {
      expect(agentNodeEnvDefault(host)).not.toBe("production");
    }
  });
});

describe("applyAgentNodeEnvDefault", () => {
  it("rewrites production in place and leaves the rest of the env untouched", () => {
    const env = { NODE_ENV: "production", PATH: "/usr/bin", HOME: "/paperclip" };
    const result = applyAgentNodeEnvDefault(env);
    expect(result).toBe(env);
    expect(env).toEqual({ NODE_ENV: AGENT_DEFAULT_NODE_ENV, PATH: "/usr/bin", HOME: "/paperclip" });
  });

  it("sets the default when the clone carries no NODE_ENV", () => {
    expect(applyAgentNodeEnvDefault({ PATH: "/usr/bin" }).NODE_ENV).toBe(AGENT_DEFAULT_NODE_ENV);
  });

  it("resolves from the record, not from the host, when the record has no NODE_ENV", () => {
    // Regression guard: a default parameter of process.env.NODE_ENV would make
    // this leak the host value into a record that deliberately carries none.
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "host-sentinel";
    try {
      expect(applyAgentNodeEnvDefault({ PATH: "/usr/bin" }).NODE_ENV).toBe(AGENT_DEFAULT_NODE_ENV);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});

describe("buildPaperclipEnv NODE_ENV default", () => {
  const agent = { id: "agent-1", companyId: "company-1" };

  it("ships a non-production NODE_ENV to every adapter lane", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      expect(buildPaperclipEnv(agent).NODE_ENV).toBe(AGENT_DEFAULT_NODE_ENV);
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });

  it("does not claim the reserved PAPERCLIP_ namespace, so config env can still override it", () => {
    // Regression guard: NODE_ENV must stay overridable by adapter/project
    // config env, which is applied after the Paperclip base env and only
    // refuses to clobber PAPERCLIP_*-namespaced runtime vars.
    expect("NODE_ENV".startsWith("PAPERCLIP_")).toBe(false);
  });
});
