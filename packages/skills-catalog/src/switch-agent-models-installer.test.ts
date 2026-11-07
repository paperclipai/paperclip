import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../catalog/optional/paperclip-operations/switch-agent-models");
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "skill-installer-"));
  roots.push(root);
  const source = path.join(root, "source", "switch-agent-models");
  cpSync(skill, source, { recursive: true });
  const run = (args: string[], env: NodeJS.ProcessEnv = {}) => spawnSync("bash", [path.join(source, "install.sh"), ...args], { encoding: "utf8", env: { ...process.env, ...env } });
  return { root, source, run };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("switch-agent-models installer", () => {
  it("never deletes its source through a symlinked parent, even on uninstall", () => {
    const { root, source, run } = fixture();
    const alias = path.join(root, "alias");
    symlinkSync(path.dirname(source), alias);
    for (const args of [["--dir", alias, "--force"], ["--dir", alias, "--uninstall", "--force"]]) {
      expect(run(args).status).not.toBe(0);
      expect(existsSync(path.join(source, "SKILL.md"))).toBe(true);
    }
  });
  it("rejects source descendants and ancestors also in dry run", () => {
    const { source, run } = fixture();
    for (const home of [source]) {
      for (const flags of [["--force"], ["--uninstall", "--force"], ["--force", "--dry-run"]]) {
        expect(run(["--dir", home, ...flags]).status).not.toBe(0);
        expect(existsSync(path.join(source, "SKILL.md"))).toBe(true);
      }
    }
    const ancestorHome = path.join(path.dirname(source), "ancestor");
    const nestedSource = path.join(ancestorHome, "switch-agent-models", "nested", "switch-agent-models");
    cpSync(source, nestedSource, { recursive: true });
    const result = spawnSync("bash", [path.join(nestedSource, "install.sh"), "--dir", ancestorHome, "--force"], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(existsSync(path.join(nestedSource, "SKILL.md"))).toBe(true);
  });
  it("unlinks a destination symlink to the source without deleting the source", () => {
    const { root, source, run } = fixture();
    const home = path.join(root, "home"); mkdirSync(home);
    symlinkSync(source, path.join(home, "switch-agent-models"));
    expect(run(["--dir", home, "--uninstall", "--force"]).status).toBe(0);
    expect(existsSync(path.join(source, "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(home, "switch-agent-models"))).toBe(false);
  });
  it("rejects nested destinations before any changes", () => {
    const { root, run } = fixture();
    const home = path.join(root, "homes");
    const nested = path.join(home, "switch-agent-models", "nested");
    expect(run(["--dir", home, "--dir", nested, "--force"]).status).not.toBe(0);
    expect(existsSync(home)).toBe(false);
  });
  it("deduplicates canonical parent aliases without replacing the canonical copy", () => {
    const { root, run } = fixture();
    const home = path.join(root, "home"); mkdirSync(home);
    const alias = path.join(root, "alias"); symlinkSync(home, alias);
    expect(run(["--canonical", home, "--dir", alias, "--force"]).status).toBe(0);
    expect(readFileSync(path.join(home, "switch-agent-models", "SKILL.md"), "utf8")).toContain("switch-agent-models");
  });
  it("plans without creating homes and installs and uninstalls canonical links", () => {
    const { root, run } = fixture();
    const canonical = path.join(root, "canonical"); const home = path.join(root, "home");
    expect(run(["--canonical", canonical, "--dir", home, "--dry-run"]).status).toBe(0);
    expect(existsSync(canonical)).toBe(false); expect(existsSync(home)).toBe(false);
    expect(run(["--canonical", canonical, "--dir", home]).status).toBe(0);
    expect(existsSync(path.join(home, "switch-agent-models", "SKILL.md"))).toBe(true);
    expect(run(["--canonical", canonical, "--dir", home, "--uninstall", "--force"]).status).toBe(0);
    expect(existsSync(path.join(canonical, "switch-agent-models"))).toBe(false);
    expect(existsSync(path.join(home, "switch-agent-models"))).toBe(false);
  });
  it("uninstalls a canonical-only selection and dry run does not mutate", () => {
    const { root, run } = fixture(); const home = path.join(root, "home");
    expect(run(["--canonical", home]).status).toBe(0);
    const dest = path.join(home, "switch-agent-models");
    expect(run(["--canonical", home, "--uninstall", "--force", "--dry-run"]).status).toBe(0);
    expect(existsSync(dest)).toBe(true);
    expect(run(["--canonical", home, "--uninstall", "--force"]).status).toBe(0);
    expect(existsSync(dest)).toBe(false);
  });
  it("propagates failed removal and leaves other targets alone after canonical failure", () => {
    const { root, run } = fixture();
    const home = path.join(root, "home"); const dest = path.join(home, "switch-agent-models"); mkdirSync(dest, { recursive: true }); writeFileSync(path.join(dest, "old"), "safe");
    const other = path.join(root, "other"); const bin = path.join(root, "bin"); mkdirSync(bin);
    writeFileSync(path.join(bin, "rm"), "#!/bin/sh\ncase \"$*\" in *scripts/__pycache__) exec /bin/rm \"$@\";; *) exit 1;; esac\n", { mode: 0o755 });
    const result = run(["--canonical", home, "--dir", other, "--force"], { PATH: `${bin}:${process.env.PATH}` });
    expect(result.status).not.toBe(0); expect(readFileSync(path.join(dest, "old"), "utf8")).toBe("safe"); expect(existsSync(other)).toBe(false);
    expect(run(["--dir", home, "--uninstall", "--force"], { PATH: `${bin}:${process.env.PATH}` }).status).not.toBe(0);
  });
  it("does not destroy an existing copy when staging fails", () => {
    const { root, run } = fixture(); const home = path.join(root, "home"); const dest = path.join(home, "switch-agent-models"); mkdirSync(dest, { recursive: true }); writeFileSync(path.join(dest, "old"), "safe");
    const bin = path.join(root, "bin"); mkdirSync(bin); writeFileSync(path.join(bin, "cp"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
    expect(run(["--dir", home, "--force"], { PATH: `${bin}:${process.env.PATH}` }).status).not.toBe(0);
    expect(readFileSync(path.join(dest, "old"), "utf8")).toBe("safe");
  });
});
