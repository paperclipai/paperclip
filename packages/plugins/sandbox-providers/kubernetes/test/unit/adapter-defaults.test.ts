import { describe, it, expect } from "vitest";
import {
  getAdapterDefaults,
  buildAdapterEnv,
  resolveRunAdapterType,
  KNOWN_ADAPTER_TYPES,
  type AdapterDefaults,
} from "../../src/adapter-defaults.js";
import type { AdapterRegistryEntry } from "../../src/adapter-registry.js";

describe("adapter-defaults (built-in)", () => {
  it("returns defaults for claude_local", () => {
    const d = getAdapterDefaults("claude_local");
    expect(d.runtimeImage).toBe("ghcr.io/paperclipai/runtime-claude:v1");
    expect(d.envKeys).toContain("ANTHROPIC_API_KEY");
    expect(d.allowFqdns).toContain("api.anthropic.com");
    expect(d.probeCommand).toEqual(["claude", "--version"]);
  });

  it("returns defaults for codex_local", () => {
    const d = getAdapterDefaults("codex_local");
    expect(d.runtimeImage).toBe("ghcr.io/paperclipai/runtime-codex:v1");
    expect(d.envKeys).toContain("OPENAI_API_KEY");
    expect(d.probeCommand).toEqual(["codex", "--version"]);
  });

  it("throws on unknown adapter type", () => {
    expect(() => getAdapterDefaults("nonexistent_local")).toThrow(/unknown adapter type/i);
  });

  it("KNOWN_ADAPTER_TYPES contains all 7 supported adapters", () => {
    expect(KNOWN_ADAPTER_TYPES).toEqual(
      new Set([
        "claude_local",
        "codex_local",
        "gemini_local",
        "cursor_local",
        "opencode_local",
        "acpx_local",
        "pi_local",
      ]),
    );
  });
});

describe("getAdapterDefaults", () => {
  it("returns built-in defaults when no registry is supplied", () => {
    const d = getAdapterDefaults("claude_local");
    expect(d.runtimeImage).toContain("runtime-claude");
    expect(d.envKeys).toEqual(["ANTHROPIC_API_KEY"]);
    expect(d.defaultEnv).toBeUndefined();
  });

  it("throws on an unknown built-in type when no registry is supplied", () => {
    expect(() => getAdapterDefaults("nope")).toThrow(/Unknown adapter type/);
  });

  it("resolves from the supplied registry (replace semantics, not merge)", () => {
    const registry: AdapterRegistryEntry[] = [
      {
        adapterType: "opencode_local",
        enabled: true,
        runtimeImage: "registry.example/opencode:eu",
        envKeys: ["ANTHROPIC_API_KEY"],
        allowFqdns: [],
        probeCommand: ["opencode", "--version"],
        defaultEnv: { ANTHROPIC_BASE_URL: "http://bifrost:8080" },
      },
    ];
    const d = getAdapterDefaults("opencode_local", registry);
    expect(d.runtimeImage).toBe("registry.example/opencode:eu");
    expect(d.defaultEnv).toEqual({ ANTHROPIC_BASE_URL: "http://bifrost:8080" });
  });

  it("throws when the type is absent from a supplied registry", () => {
    const registry: AdapterRegistryEntry[] = [
      {
        adapterType: "opencode_local",
        runtimeImage: "x",
        envKeys: [],
        allowFqdns: [],
        probeCommand: ["x"],
      },
    ];
    expect(() => getAdapterDefaults("claude_local", registry)).toThrow(
      /not in the configured adapter registry/,
    );
  });

  it("throws when a supplied registry entry is missing runtimeImage", () => {
    const registry: AdapterRegistryEntry[] = [
      { adapterType: "opencode_local", envKeys: [], allowFqdns: [], probeCommand: ["x"] },
    ];
    expect(() => getAdapterDefaults("opencode_local", registry)).toThrow(
      /missing required runtime field: runtimeImage/,
    );
  });

  it("defaults the optional array fields to [] when the registry omits them", () => {
    const registry: AdapterRegistryEntry[] = [
      { adapterType: "opencode_local", runtimeImage: "img" },
    ];
    const d = getAdapterDefaults("opencode_local", registry);
    expect(d.envKeys).toEqual([]);
    expect(d.allowFqdns).toEqual([]);
    expect(d.probeCommand).toEqual([]);
  });
});

describe("buildAdapterEnv", () => {
  it("layers process-env (secret) over defaultEnv (non-secret base)", () => {
    const defaults: AdapterDefaults = {
      runtimeImage: "x",
      envKeys: ["ANTHROPIC_API_KEY"],
      allowFqdns: [],
      probeCommand: ["x"],
      defaultEnv: { ANTHROPIC_BASE_URL: "http://bifrost:8080", ANTHROPIC_API_KEY: "should-be-overridden" },
    };
    const env = buildAdapterEnv(defaults, { ANTHROPIC_API_KEY: "sk-real" });
    expect(env).toEqual({
      ANTHROPIC_BASE_URL: "http://bifrost:8080",
      ANTHROPIC_API_KEY: "sk-real",
    });
  });

  it("omits process-env keys that are absent", () => {
    const defaults: AdapterDefaults = {
      runtimeImage: "x",
      envKeys: ["ANTHROPIC_API_KEY"],
      allowFqdns: [],
      probeCommand: ["x"],
    };
    expect(buildAdapterEnv(defaults, {})).toEqual({});
  });
});

describe("resolveRunAdapterType", () => {
  it("prefers the run/agent adapter when provided (mixed-harness env)", () => {
    expect(resolveRunAdapterType("pi_local", "opencode_local")).toBe("pi_local");
  });
  it("falls back to the environment default when the run adapter is missing/blank", () => {
    expect(resolveRunAdapterType(undefined, "opencode_local")).toBe("opencode_local");
    expect(resolveRunAdapterType(null, "opencode_local")).toBe("opencode_local");
    expect(resolveRunAdapterType("   ", "opencode_local")).toBe("opencode_local");
  });
  it("trims the run adapter", () => {
    expect(resolveRunAdapterType("  pi_local  ", "opencode_local")).toBe("pi_local");
  });
});
