import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  realpathSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parse, stringify } from "smol-toml";

/** Run on the execution host, before the provider process loads project config. */
export function trustCodexStartupRoot(codexHome: string, cwd: string): void {
  if (!isAbsolute(codexHome) || !isAbsolute(cwd))
    throw new Error("codex_startup_trust_requires_absolute_paths");
  const startup = realpathSync(cwd);
  let root = startup;
  try {
    const top = execFileSync(
      "git",
      ["-C", startup, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    const common = execFileSync(
      "git",
      [
        "-C",
        startup,
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ],
      { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    // Linked worktrees share Codex's trust key with the main checkout.
    root = realpathSync(common.endsWith("/.git") ? dirname(common) : top);
  } catch (error) {
    // Non-Git folders have their own exact startup trust boundary. Failures
    // inside a repository must not guess a different trust key.
    for (let ancestor = startup; ; ancestor = dirname(ancestor)) {
      if (existsSync(join(ancestor, ".git")))
        throw new Error("codex_startup_trust_git_resolution_failed", {
          cause: error,
        });
      if (dirname(ancestor) === ancestor) break;
    }
  }
  mkdirSync(codexHome, { recursive: true, mode: 0o700 });
  const path = join(codexHome, "config.toml");
  const config = existsSync(path) ? parse(readFileSync(path, "utf8")) : {};
  const projects = config.projects ?? {};
  if (
    typeof projects !== "object" ||
    Array.isArray(projects) ||
    projects instanceof Date
  )
    throw new Error("codex_startup_trust_invalid_projects");
  const project = projects[root] ?? {};
  if (
    typeof project !== "object" ||
    Array.isArray(project) ||
    project instanceof Date
  )
    throw new Error("codex_startup_trust_invalid_project");
  config.projects = {
    ...projects,
    [root]: { ...project, trust_level: "trusted" },
  };
  const temporary = resolve(codexHome, `config.toml.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, stringify(config), { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
