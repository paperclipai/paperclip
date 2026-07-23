import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { detectCopilotToken, shouldRetryCopilotProbe, testEnvironment } from "./test.js";

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

  it("skips the default CLI probe when a custom ACP command is configured", async () => {
    const copilotHome = await fs.mkdtemp(path.join(os.tmpdir(), "copilot-custom-acp-test-"));
    try {
      const result = await testEnvironment({
        adapterType: "copilot_local",
        companyId: "company-1",
        config: {
          cwd: process.cwd(),
          agentCommand: "custom-copilot-acp --stdio",
          command: "definitely-missing-copilot-command",
          env: { COPILOT_HOME: copilotHome },
        },
      } as never);

      expect(result.checks.map((check) => check.code)).toContain(
        "copilot_custom_acp_command_configured",
      );
      expect(result.checks.map((check) => check.code)).not.toContain("copilot_command_missing");
      expect(result.checks.some((check) => check.code.startsWith("copilot_live_probe_"))).toBe(false);
    } finally {
      await fs.rm(copilotHome, { recursive: true, force: true });
    }
  });
});
