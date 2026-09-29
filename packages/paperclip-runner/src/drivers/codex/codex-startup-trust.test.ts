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
  it.each(["missing", "table", "empty-table", "inline", "empty-inline", "inline-projects"])(
    "preserves managed comments and unrelated content with %s project configuration", (kind) => {
      const temp = realpathSync(mkdtempSync(join(tmpdir(), "codex-trust-comments-")));
      try {
        const cwd = join(temp, "project"); const home = join(temp, "home");
        mkdirSync(cwd); mkdirSync(home);
        const root = JSON.stringify(cwd);
        const project = {
          missing: "",
          table: `[projects.${root}]\ntrust_level = "untrusted" # retain trust comment\n`,
          "empty-table": `[projects.${root}] # retain table comment\n`,
          inline: `[projects]\n${root} = {trust_level = 'untrusted', label = "unchanged"}\n`,
          "empty-inline": `[projects]\n${root} = {} # retain inline comment\n`,
          "inline-projects": `projects = {${root} = {label = "unchanged"}}\n`,
        }[kind]!;
        const managed = '# BEGIN PAPERCLIP MANAGED MCP\n[mcp_servers.fixture]\nurl = "https://example.invalid/old"\n# END PAPERCLIP MANAGED MCP\n';
        const misleading = 'text = """\n[projects.fake]\ntrust_level = "untrusted"\n"""\n';
        const original = (kind === "inline-projects" ? project + misleading : misleading + project) + managed;
        writeFileSync(join(home, "config.toml"), original);
        const expected = parse(original);
        expected.projects ??= {};
        const projects = expected.projects as Record<string, Record<string, unknown>>;
        projects[cwd] = { ...projects[cwd], trust_level: "trusted" };
        trustCodexStartupRoot(home, cwd);
        const updated = readFileSync(join(home, "config.toml"), "utf8");
        expect(parse(updated)).toEqual(expected);
        expect(updated).toContain(managed);
        expect(updated).toContain(misleading);
        trustCodexStartupRoot(home, cwd);
        expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(updated);
        const refreshed = updated.replace(managed, managed.replace('/old', '/new'));
        expect((parse(refreshed).mcp_servers as Record<string, {url: string}>).fixture.url).toBe('https://example.invalid/new');
      } finally { rmSync(temp, { recursive: true, force: true }); }
    },
  );

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
