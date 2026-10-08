import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());

import { ACPX_CREDENTIAL_BINDING_ENV, createAcpxCredentialBinding, createAcpxSidecarHostEnvironment, createSanitizedAcpxSpawnInput } from "./environment.js";

describe("ACPX launch environment", () => {
  it("keeps gateway and Bedrock settings confined to the selected harness", () => {
    const source = {
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_AUTH_TOKEN: "selected-key",
      CLAUDE_CODE_USE_BEDROCK: "1", AWS_REGION: "us-east-1",
      AWS_BEARER_TOKEN_BEDROCK: "bedrock-key",
      AWS_ACCESS_KEY_ID: "general-aws-key", AWS_SECRET_ACCESS_KEY: "general-aws-secret", AWS_SESSION_TOKEN: "general-aws-session",
      PAPERCLIP_AI_PROVIDER_KEY: "codex-key", UNRELATED_SECRET: "private",
    };
    expect(createSanitizedAcpxSpawnInput(source, "claude").env).toEqual({
      ANTHROPIC_BASE_URL: source.ANTHROPIC_BASE_URL,
      ANTHROPIC_AUTH_TOKEN: "selected-key", CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1", AWS_BEARER_TOKEN_BEDROCK: "bedrock-key",
    });
    expect(createSanitizedAcpxSpawnInput(source, "codex").env).toEqual({ PAPERCLIP_AI_PROVIDER_KEY: "codex-key" });
    expect(createSanitizedAcpxSpawnInput(source, "cursor").env).toEqual({});
  });

  it("projects only the selected agent's credentials and runtime allowlist", () => {
    const source = {
      PATH: "/bin",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "https://proxy.example",
      OPENAI_API_KEY: "openai-secret",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENROUTER_API_KEY: "openrouter-secret",
      PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET:
        '{"tokens":{"access_token":"managed-secret"}}',
      PAPERCLIP_RUNNER_BOOTSTRAP_TICKET: "transport-secret",
      PAPERCLIP_NATIVE_MCP_TOKEN: "bridge-secret",
      UNRELATED_SECRET: "not-visible",
    };

    const codex = createSanitizedAcpxSpawnInput(source, "codex");
    expect(codex.env).toEqual({
      PATH: "/bin",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "https://proxy.example",
      OPENAI_API_KEY: "openai-secret",
    });
    expect(createSanitizedAcpxSpawnInput(source, "claude").env).toEqual({
      PATH: "/bin",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "https://proxy.example",
      ANTHROPIC_API_KEY: "anthropic-secret",
    });
    expect(createSanitizedAcpxSpawnInput(source, "pi").env).toEqual({
      PATH: "/bin",
      LC_ALL: "C.UTF-8",
      HTTPS_PROXY: "https://proxy.example",
      OPENROUTER_API_KEY: "openrouter-secret",
    });
    expect(codex.env).not.toHaveProperty("PAPERCLIP_NATIVE_MCP_TOKEN");
    expect(codex.env).not.toHaveProperty(
      "PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET",
    );
    expect(Object.isFrozen(codex)).toBe(true);
    expect(Object.isFrozen(codex.env)).toBe(true);
  });

  it.each([
    ["pi", "OPENROUTER_API_KEY"], ["cursor", "CURSOR_API_KEY"],
    ["cursor", "CURSOR_AUTH_TOKEN"], ["copilot", "COPILOT_GITHUB_TOKEN"],
  ] as const)("requires an explicit %s credential binding for %s", (agent, name) => {
    vi.stubEnv(name, "ambient-secret");
    expect(createSanitizedAcpxSpawnInput(undefined, agent).env[name]).toBeUndefined();
    expect(createSanitizedAcpxSpawnInput({ [name]: "bound-secret" }, agent).env[name]).toBe("bound-secret");
  });

  it("drops alternate credentials, provider injection and configuration overrides", () => {
    const source = {
      CURSOR_API_KEY: "cursor-key", CURSOR_AUTH_TOKEN: "cursor-token", COPILOT_GITHUB_TOKEN: "copilot-key",
      GH_TOKEN: "gh-key", GITHUB_TOKEN: "github-key", COPILOT_PROVIDER_BASE_URL: "https://unapproved.invalid",
      COPILOT_MODEL: "ambient-model", CURSOR_CONFIG_DIR: "/ambient/cursor", PI_CODING_AGENT_DIR: "/ambient/pi",
      PAPERCLIP_PI_ENTRYPOINT: "/unverified/pi.js", NODE_OPTIONS: "--import=/unverified/hook.js",
      COPILOT_PKG_CACHE_HOME: "/unverified/cache", COPILOT_ALLOW_ALL: "true",
    };
    expect(createSanitizedAcpxSpawnInput(source, "cursor").env).toEqual({ CURSOR_API_KEY: "cursor-key", CURSOR_AUTH_TOKEN: "cursor-token" });
    expect(createSanitizedAcpxSpawnInput(source, "copilot").env).toEqual({ COPILOT_GITHUB_TOKEN: "copilot-key" });
    expect(createSanitizedAcpxSpawnInput(source, "pi").env).toEqual({});
  });

  it.each([
    ["pi", "OPENROUTER_API_KEY"], ["cursor", "CURSOR_API_KEY"],
    ["cursor", "CURSOR_AUTH_TOKEN"], ["copilot", "COPILOT_GITHUB_TOKEN"],
  ] as const)("admits only session-bound %s sidecar credentials for %s", (agent, name) => {
    const source = { [name]: "task-secret" };
    const binding = createAcpxCredentialBinding(source, agent, "session-1");
    expect(binding).not.toContain("task-secret");
    const explicit = createAcpxSidecarHostEnvironment({ ...source, [ACPX_CREDENTIAL_BINDING_ENV]: binding }, agent, "session-1");
    expect(createSanitizedAcpxSpawnInput(explicit, agent).env).toEqual(source);
    expect(explicit[ACPX_CREDENTIAL_BINDING_ENV]).toBeUndefined();
    expect(() => createAcpxSidecarHostEnvironment(source, agent, "session-1")).toThrow("explicit matching session binding");
    expect(() => createAcpxSidecarHostEnvironment({ ...source, [ACPX_CREDENTIAL_BINDING_ENV]: binding }, agent, "stale-session")).toThrow("explicit matching session binding");
  });

  it("rejects malformed, wrong-provider, duplicate and missing sidecar credential bindings", () => {
    const source = { CURSOR_API_KEY: "do-not-include-in-errors" };
    const valid = JSON.parse(createAcpxCredentialBinding(source, "cursor", "session-1")!);
    for (const binding of ["invalid-json", JSON.stringify({ ...valid, agent: "copilot" }),
      JSON.stringify({ ...valid, names: ["COPILOT_GITHUB_TOKEN"] }),
      JSON.stringify({ ...valid, names: ["CURSOR_API_KEY", "CURSOR_API_KEY"] }),
      JSON.stringify({ ...valid, names: [] }), JSON.stringify({ ...valid, extra: true })]) {
      expect(() => createAcpxSidecarHostEnvironment({ ...source, [ACPX_CREDENTIAL_BINDING_ENV]: binding }, "cursor", "session-1"))
        .toThrow(/^Candidate ACPX credentials require an explicit matching session binding$/);
    }
    expect(() => createAcpxSidecarHostEnvironment({ [ACPX_CREDENTIAL_BINDING_ENV]: JSON.stringify(valid) }, "cursor", "session-1")).toThrow("explicit matching session binding");
    expect(() => createAcpxSidecarHostEnvironment({ ...source, CURSOR_AUTH_TOKEN: "unbound", [ACPX_CREDENTIAL_BINDING_ENV]: JSON.stringify(valid) }, "cursor", "session-1")).toThrow("explicit matching session binding");
  });

  it("does not reinterpret legacy profile credential environments", () => {
    const source = { ANTHROPIC_API_KEY: "legacy", OPENAI_API_KEY: "legacy", [ACPX_CREDENTIAL_BINDING_ENV]: "irrelevant" };
    for (const agent of ["claude", "codex"] as const) {
      expect(createAcpxCredentialBinding(source, agent, "session-1")).toBeUndefined();
      expect(createAcpxSidecarHostEnvironment(source, agent, "session-1")).toBe(source);
    }
  });

  it("rejects unsafe or unbounded retained values", () => {
    expect(() =>
      createSanitizedAcpxSpawnInput({ PATH: "bad\0path" }, "codex"),
    ).toThrow("null byte");
    expect(() =>
      createSanitizedAcpxSpawnInput(
        {
          OPENAI_API_KEY: "x".repeat(64 * 1024),
        },
        "codex",
      ),
    ).toThrow("bounded launch size");
  });
});
