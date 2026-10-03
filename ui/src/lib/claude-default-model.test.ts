import { describe, expect, it } from "vitest";
import { claudeDefaultModelName } from "./claude-default-model";

describe("claudeDefaultModelName", () => {
  it("uses the built-in default without overrides", () => {
    expect(claudeDefaultModelName({ runsOnHost: true })).toBe("claude-opus-5");
  });

  it("uses the host model for runs on the host", () => {
    expect(claudeDefaultModelName({ hostModel: "claude-opus-5-5", runsOnHost: true })).toBe("claude-opus-5-5");
  });

  it("ignores the host model for remote runs", () => {
    expect(claudeDefaultModelName({ hostModel: "claude-opus-5-5", runsOnHost: false })).toBe("claude-opus-5");
  });

  it("prefers the agent's plain ANTHROPIC_MODEL", () => {
    expect(
      claudeDefaultModelName({
        agentEnv: { ANTHROPIC_MODEL: { type: "plain", value: " claude-sonnet-5 " } },
        hostModel: "claude-opus-5-5",
        runsOnHost: true,
      }),
    ).toBe("claude-sonnet-5");
    expect(
      claudeDefaultModelName({ agentEnv: { ANTHROPIC_MODEL: "claude-fable-5-1" }, runsOnHost: false }),
    ).toBe("claude-fable-5-1");
  });

  it("treats a blank agent value as clearing the host model", () => {
    expect(
      claudeDefaultModelName({
        agentEnv: { ANTHROPIC_MODEL: { type: "plain", value: "" } },
        hostModel: "claude-opus-5-5",
        runsOnHost: true,
      }),
    ).toBe("claude-opus-5");
  });

  it("returns null when a secret supplies the agent's ANTHROPIC_MODEL", () => {
    expect(
      claudeDefaultModelName({
        agentEnv: { ANTHROPIC_MODEL: { type: "secret_ref", secretId: "secret-1" } },
        hostModel: "claude-opus-5-5",
        runsOnHost: true,
      }),
    ).toBeNull();
  });
});
