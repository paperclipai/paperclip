import { describe, expect, it } from "vitest";
import { MANAGED_AI_NEUTRALIZED_ENV_KEYS } from "@paperclipai/shared";
import { finalizeLaunchEnvironment } from "./execute.js";

const NEUTRALIZED_MANAGED_AI_ENV = Object.fromEntries(
  MANAGED_AI_NEUTRALIZED_ENV_KEYS.map((key) => [key, ""]),
) as Record<string, string>;

describe("managed AI neutralization in the ACPX launch environment", () => {
  it("launches a host-side child with no empty provider routing value", () => {
    const launched = finalizeLaunchEnvironment(
      { ...NEUTRALIZED_MANAGED_AI_ENV },
      [],
      {
        acpxAgent: "claude",
        inheritHostEnvironment: true,
        materializesChildEnvironment: true,
        inheritedEnv: { PATH: "/usr/bin" },
      },
    );
    const empty = MANAGED_AI_NEUTRALIZED_ENV_KEYS.filter(
      (key) => launched.env[key] === "",
    );
    expect(empty).toEqual([]);
  });

  it("keeps the host's own routing value out of a host-side child", () => {
    const launched = finalizeLaunchEnvironment(
      { ANTHROPIC_BASE_URL: "", ANTHROPIC_API_KEY: "" },
      [],
      {
        acpxAgent: "claude",
        inheritHostEnvironment: true,
        materializesChildEnvironment: true,
        inheritedEnv: {
          ANTHROPIC_BASE_URL: "https://host-proxy.example",
          ANTHROPIC_API_KEY: "host-key",
          PATH: "/usr/bin",
        },
      },
    );
    expect("ANTHROPIC_BASE_URL" in launched.env).toBe(false);
    expect("ANTHROPIC_API_KEY" in launched.env).toBe(false);
  });

  it("keeps the empty assignment for a remote sandbox launch", () => {
    const launched = finalizeLaunchEnvironment(
      { ANTHROPIC_BASE_URL: "", OPENAI_BASE_URL: "" },
      [],
      { acpxAgent: "claude", inheritHostEnvironment: false, inheritedEnv: {} },
    );
    expect(launched.env.ANTHROPIC_BASE_URL).toBe("");
    expect(launched.env.OPENAI_BASE_URL).toBe("");
  });

  it("keeps the empty assignment for a launch that ships this env elsewhere", () => {
    const launched = finalizeLaunchEnvironment(
      { ANTHROPIC_BASE_URL: "" },
      [],
      {
        acpxAgent: "claude",
        inheritHostEnvironment: true,
        inheritedEnv: { PATH: "/usr/bin" },
      },
    );
    expect(launched.env.ANTHROPIC_BASE_URL).toBe("");
  });

  it("keeps the values a managed runtime actually selected", () => {
    const launched = finalizeLaunchEnvironment(
      {
        ...NEUTRALIZED_MANAGED_AI_ENV,
        CLAUDE_CONFIG_DIR: "/tmp/managed/provider",
        ANTHROPIC_AUTH_TOKEN: "selected-token",
      },
      [],
      {
        acpxAgent: "claude",
        inheritHostEnvironment: true,
        materializesChildEnvironment: true,
        inheritedEnv: { PATH: "/usr/bin" },
      },
    );
    expect(launched.env.CLAUDE_CONFIG_DIR).toBe("/tmp/managed/provider");
    expect(launched.env.ANTHROPIC_AUTH_TOKEN).toBe("selected-token");
    expect(launched.env.PATH).toBe("/usr/bin");
  });

  it("leaves an unrelated empty value in place", () => {
    const launched = finalizeLaunchEnvironment(
      { SOME_PROJECT_FLAG: "" },
      [],
      {
        acpxAgent: "claude",
        inheritHostEnvironment: true,
        materializesChildEnvironment: true,
        inheritedEnv: { PATH: "/usr/bin" },
      },
    );
    expect(launched.env.SOME_PROJECT_FLAG).toBe("");
  });
});
