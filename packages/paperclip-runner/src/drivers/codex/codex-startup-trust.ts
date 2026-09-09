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
import { parse, type TomlTable } from "smol-toml";
import { isDeepStrictEqual } from "node:util";

/** Keep managed-region comments and all unrelated bytes. The parser validates
 * every candidate against the exact intended semantic change; text inside a
 * comment or multiline string can never qualify as the target assignment. */
function editTrust(source: string, root: string, expected: TomlTable): string {
  const matches = (candidate: string) => {
    try { return isDeepStrictEqual(parse(candidate), expected); }
    catch { return false; }
  };
  if (matches(source)) return source;
  const appended = `${source}\n[projects.${JSON.stringify(root)}]\ntrust_level = "trusted"\n`;
  if (matches(appended)) return appended;
  const values = /(?:"trust_level"|'trust_level'|\btrust_level)\s*=\s*("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\])*"|'[^']*')/g;
  for (const match of source.matchAll(values)) {
    const end = match.index! + match[0].length;
    const start = end - match[1]!.length;
    const candidate = source.slice(0, start) + '"trusted"' + source.slice(end);
    if (matches(candidate)) return candidate;
  }
  // An existing project table may not yet have a trust field.
  for (const match of source.matchAll(/^[ \t]*\[(?!\[)[^\r\n]*\][^\r\n]*(?:\r?\n|$)/gm)) {
    const end = match.index! + match[0].length;
    const candidate = source.slice(0, end) + '\ntrust_level = "trusted"\n' + source.slice(end);
    if (matches(candidate)) return candidate;
  }
  // Inline project tables are closed to appended table headers. Insert only
  // when reparsing proves this is the intended object, not a brace in text.
  const fields = ['trust_level = "trusted"', `${JSON.stringify(root)} = { trust_level = "trusted" }`];
  for (const match of source.matchAll(/\{/g)) {
    const end = match.index! + 1;
    for (const field of fields) {
      for (const separator of [', ', '']) {
        const candidate = source.slice(0, end) + field + separator + source.slice(end);
        if (matches(candidate)) return candidate;
      }
    }
  }
  throw new Error("codex_startup_trust_cannot_preserve_configuration");
}

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
  const source = existsSync(path) ? readFileSync(path, "utf8") : "";
  const config = parse(source);
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
  const updated = editTrust(source, root, config);
  if (updated === source) return;
  const temporary = resolve(codexHome, `config.toml.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, updated, { mode: 0o600, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
