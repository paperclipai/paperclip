import { describe, expect, it } from "vitest";

import { createSanitizedAcpxSpawnInput } from "./environment.js";

describe("ACPX launch environment", () => {
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
