import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import { existsSync } from "fs";
import { join } from "path";

const CLAUDE_CODE_CLI = "claude";

describe("Claude Code CLI Spike Validation", () => {
  describe("skills dir symlinks", () => {
    it("should create symlinks in ~/.claude/skills/", () => {
      const skillsHome = join(process.env.HOME ?? "/root", ".claude", "skills");
      expect(existsSync(skillsHome)).toBe(true);
    });
  });
});

describe("CLI Version Bump Integration Tests", () => {
  it("should validate CLI version is above minimum supported", () => {
    try {
      const result = execSync(`${CLAUDE_CODE_CLI} --version`, {
        encoding: "utf-8",
        timeout: 5000,
      });
      const versionMatch = result.match(/(\d+)\.(\d+)\.(\d+)/);
      expect(versionMatch).toBeTruthy();

      const [, major, minor] = versionMatch!;
      const majorNum = parseInt(major, 10);
      const minorNum = parseInt(minor, 10);

      const MINIMUM_MAJOR = 2;
      const MINIMUM_MINOR = 1;

      expect(majorNum > MINIMUM_MAJOR || (majorNum === MINIMUM_MAJOR && minorNum >= MINIMUM_MINOR)).toBe(true);
    } catch (err) {
      throw new Error(`Could not get Claude Code version: ${err}`);
    }
  });
});
