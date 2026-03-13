import { describe, expect, it } from "vitest";
import { applyCreateDefaultsByAdapterType } from "../routes/agents.js";

describe("applyCreateDefaultsByAdapterType", () => {
  it("enables unattended Claude permissions bypass by default for programmatic agent creation", () => {
    expect(applyCreateDefaultsByAdapterType("claude_local", {})).toMatchObject({
      dangerouslySkipPermissions: true,
    });
  });

  it("preserves an explicit Claude permission choice", () => {
    expect(
      applyCreateDefaultsByAdapterType("claude_local", { dangerouslySkipPermissions: false }),
    ).toMatchObject({
      dangerouslySkipPermissions: false,
    });
  });

  it("keeps existing Codex unattended defaults", () => {
    expect(applyCreateDefaultsByAdapterType("codex_local", {})).toMatchObject({
      model: expect.any(String),
      dangerouslyBypassApprovalsAndSandbox: expect.any(Boolean),
    });
  });
});