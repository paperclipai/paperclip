import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Finds a change outside the task folder in a tool call the coordinator
 * reports. It reads file-tool locations and path arguments, and the write
 * targets of shell commands (redirects, tee, cp/mv/ln destinations, rm, mkdir,
 * touch, sed -i, dd of=). Paths are resolved like the OS would: relative to the
 * task folder, `..`, `~` and `$HOME`, and symlinks of existing parents.
 *
 * What it cannot see: helper tool calls never reach the ACP client, and a
 * shell command can hide its target (variables, subshells, scripts). Those
 * stay confined only by the CLI's own auto mode and sandbox.
 */
type Json = Record<string, unknown>;
const record = (value: unknown): Json =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Json : {};

const PATH_KEY = /path|file|target|dest|directory|dir$/i;
const COMMAND_KEY = /command|cmd|script/i;
const DEVICES = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);
const ALL_ARGUMENTS = new Set(["tee", "rm", "rmdir", "mkdir", "touch", "chmod", "chown", "truncate", "unlink", "shred"]);
const LAST_ARGUMENT = new Set(["cp", "mv", "ln", "install", "rsync"]);

function realResolved(path: string): string {
  // Resolve symlinks through the deepest existing ancestor.
  let current = path;
  const rest: string[] = [];
  for (let depth = 0; depth < 64; depth++) {
    try { return join(realpathSync(current), ...rest.reverse()); } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      rest.push(basename(current));
      current = parent;
    }
  }
  return path;
}

function expand(path: string, workspace: string, home: string): string | null {
  let value = path.trim().replace(/^['"]|['"]$/g, "");
  if (!value || DEVICES.has(value) || value.startsWith("/dev/fd/")) return null;
  value = value.replace(/^~(?=\/|$)/, home).replace(/^\$\{?HOME\}?(?=\/|$)/, home);
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value) || value.includes("$")) return null;
  return realResolved(isAbsolute(value) ? resolve(value) : resolve(workspace, value));
}

function outside(path: string, workspace: string): boolean {
  const inside = relative(workspace, path);
  return inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
}

function tokens(segment: string): string[] {
  return (segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? []).map(token => token.replace(/^['"]|['"]$/g, ""));
}

/** Paths a shell command writes, as far as its text shows them. */
export function shellWriteTargets(command: string): string[] {
  const targets: string[] = [];
  for (const segment of command.split(/;|&&|\|\||\|(?!\|)|\n/)) {
    const words = tokens(segment);
    for (let index = 0; index < words.length; index++) {
      const redirect = /^(?:\d|&)?>>?(.*)$/.exec(words[index]!);
      if (redirect) {
        const target = redirect[1] || words[index + 1];
        if (target) targets.push(target);
      }
    }
    const plain = words.filter(word => !/^(?:\d|&)?>>?/.test(word));
    let start = 0;
    while (start < plain.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(plain[start]!) || ["sudo", "env", "command", "exec"].includes(plain[start]!))) start++;
    const name = plain[start] ? basename(plain[start]!) : "";
    const args = plain.slice(start + 1).filter(word => !word.startsWith("-"));
    // Drop the source side of a redirect pair already counted above.
    const redirectTargets = new Set(words.flatMap((word, index) => /^(?:\d|&)?>>?$/.test(word) ? [words[index + 1]] : []));
    const operands = args.filter(word => !redirectTargets.has(word));
    if (ALL_ARGUMENTS.has(name)) targets.push(...operands);
    else if (LAST_ARGUMENT.has(name) && operands.length > 1) targets.push(operands.at(-1)!);
    else if (name === "sed" && plain.some(word => /^-i/.test(word)) && operands.length) targets.push(operands.at(-1)!);
    else if (name === "dd") targets.push(...args.flatMap(word => word.startsWith("of=") ? [word.slice(3)] : []));
  }
  return targets;
}

/** The first path outside the task folder that a visible tool call would change, or null. */
export function antigravityOutsideChange(update: unknown, workspace: string, home: string): string | null {
  const value = record(update);
  if (value.sessionUpdate !== "tool_call" && value.sessionUpdate !== "tool_call_update") return null;
  const kind = String(value.kind ?? "");
  const args = { ...record(value.rawInput), ...record(value.args) };
  const candidates: string[] = [];
  if (["edit", "delete", "move"].includes(kind)) {
    const locations = Array.isArray(value.locations) ? value.locations.map(record) : [];
    candidates.push(...locations.flatMap(location => typeof location.path === "string" ? [location.path] : []));
    candidates.push(...Object.entries(args).flatMap(([key, entry]) => PATH_KEY.test(key) && typeof entry === "string" ? [entry] : []));
  }
  if (kind === "execute" || /command|shell|terminal/i.test(String(value.name ?? ""))) {
    for (const [key, entry] of Object.entries(args)) {
      if (COMMAND_KEY.test(key) && typeof entry === "string") candidates.push(...shellWriteTargets(entry));
    }
  }
  let root = workspace;
  try { root = realpathSync(workspace); } catch { /* keep the given path */ }
  for (const candidate of candidates) {
    const resolved = expand(candidate, workspace, home);
    if (resolved && outside(resolved, root)) return candidate;
  }
  return null;
}
