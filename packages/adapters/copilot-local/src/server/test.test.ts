import { describe, expect, it } from "vitest";
import { detectCopilotToken, shouldRetryCopilotProbe } from "./test.js";

describe("Copilot token detection", () => {
  it("uses the documented environment precedence", () => {
    expect(
      detectCopilotToken({
        COPILOT_GITHUB_TOKEN: "gho_primary",
        GH_TOKEN: "github_pat_secondary",
        GITHUB_TOKEN: "ghu_tertiary",
      }),
    ).toEqual({
      key: "COPILOT_GITHUB_TOKEN",
      supported: true,
      classicPat: false,
    });
  });

  describe("Copilot live probe retry", () => {
    it("retries only diagnostic-free process exits", () => {
      expect(
        shouldRetryCopilotProbe({
          exitCode: 1,
          timedOut: false,
          stdout: "",
          stderr: "",
        }),
      ).toBe(true);
      expect(
        shouldRetryCopilotProbe({
          exitCode: 1,
          timedOut: false,
          stdout: "",
          stderr: "authentication failed",
        }),
      ).toBe(false);
      expect(
        shouldRetryCopilotProbe({
          exitCode: null,
          timedOut: true,
          stdout: "",
          stderr: "",
        }),
      ).toBe(false);
    });
  });

  it("rejects classic PATs and accepts GitHub CLI OAuth tokens", () => {
    expect(detectCopilotToken({ GITHUB_TOKEN: "ghp_legacy" })).toMatchObject({
      supported: false,
      classicPat: true,
    });
    expect(detectCopilotToken({ GITHUB_TOKEN: "gho_oauth" })).toMatchObject({
      supported: true,
      classicPat: false,
    });
  });
});
