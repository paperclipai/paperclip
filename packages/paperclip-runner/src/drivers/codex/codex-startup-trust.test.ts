import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, it, expect } from "vitest";
import { parse } from "smol-toml";
import { trustCodexStartupRoot } from "./codex-startup-trust.js";

describe("isolated Codex startup trust", () => {
  it("trusts the exact non-Git root and preserves unrelated config", () => {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "codex-trust-")));
    try {
      const cwd = join(temp, "project");
      const home = join(temp, "home");
      mkdirSync(cwd);
      mkdirSync(home);
      writeFileSync(
        join(home, "config.toml"),
        'model = "test"\n[mcp_servers.fixture]\nurl = "http://localhost/example"\n',
      );
      trustCodexStartupRoot(home, cwd);
      trustCodexStartupRoot(home, cwd);
      expect(parse(readFileSync(join(home, "config.toml"), "utf8"))).toEqual({
        model: "test",
        mcp_servers: { fixture: { url: "http://localhost/example" } },
        projects: { [cwd]: { trust_level: "trusted" } },
      });
      expect(readFileSync(join(home, "config.toml"), "utf8")).not.toContain(
        `[projects."${temp}"]`,
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
  it("uses the canonical main repository key for worktrees and symlinks", () => {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "codex-trust-")));
    try {
      const main = join(temp, "main");
      const worktree = join(temp, "branch");
      const home = join(temp, "home");
      mkdirSync(main);
      execFileSync("git", ["init", main], { stdio: "ignore" });
      execFileSync(
        "git",
        [
          "-C",
          main,
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "commit",
          "--allow-empty",
          "-m",
          "init",
        ],
        { stdio: "ignore" },
      );
      execFileSync(
        "git",
        ["-C", main, "worktree", "add", "-b", "test", worktree],
        { stdio: "ignore" },
      );
      symlinkSync(worktree, join(temp, "alias"));
      trustCodexStartupRoot(home, join(temp, "alias"));
      expect(
        parse(readFileSync(join(home, "config.toml"), "utf8")).projects,
      ).toEqual({ [main]: { trust_level: "trusted" } });
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
  it("fails without replacing malformed configuration", () => {
    const temp = realpathSync(mkdtempSync(join(tmpdir(), "codex-trust-")));
    try {
      writeFileSync(join(temp, "config.toml"), "invalid = [");
      expect(() => trustCodexStartupRoot(temp, temp)).toThrow();
      expect(readFileSync(join(temp, "config.toml"), "utf8")).toBe(
        "invalid = [",
      );
    } finally {
      rmSync(temp, { recursive: true, force: true });
    }
  });
});
