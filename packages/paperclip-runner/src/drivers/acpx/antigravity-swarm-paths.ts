import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Finds a change outside the task folder in a tool call the coordinator
 * reports. It reads file-tool locations and path arguments, and the write
 * targets of shell commands (redirects, tee, cp/mv/ln destinations, rm, mkdir,
 * touch, sed -i, dd of=). Paths are resolved like the OS would: relative to the
 * task folder, `..`, `~` and `$HOME`, and symlinks of existing parents.
 *
 * Role: a best-effort detector that turns visible, unambiguous outside writes
 * into a clear failure. It is not a confinement boundary and does not prove
 * one: helper tool calls never reach the ACP client, and a shell command can
 * hide its target (variables, subshells, scripts, interpreters). Ambiguous
 * constructs yield no finding, so a correct swarm is never stopped by a guess.
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

type Lexeme = { kind: "word"; text: string } | { kind: "op"; text: string };

/** Quote-aware shell lexer. Returns null for constructs whose writes cannot be read from the text. */
function lex(command: string): Lexeme[] | null {
  const out: Lexeme[] = [];
  let word = "";
  let inWord = false;
  const flush = () => { if (inWord) out.push({ kind: "word", text: word }); word = ""; inWord = false; };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (char === "'") {
      const close = command.indexOf("'", index + 1);
      if (close < 0) return null;
      word += command.slice(index + 1, close); inWord = true; index = close; continue;
    }
    if (char === '"') {
      let close = index + 1;
      while (close < command.length && command[close] !== '"') { if (command[close] === "\\") close++; close++; }
      if (close >= command.length) return null;
      const inner = command.slice(index + 1, close);
      if (/\$\(|`/.test(inner)) return null;
      word += inner; inWord = true; index = close; continue;
    }
    if (char === "`" || (char === "$" && command[index + 1] === "(")) return null;
    if (char === "\\") { word += command[index + 1] ?? ""; inWord = true; index++; continue; }
    if (/\s/.test(char) && char !== "\n") { flush(); continue; }
    const operator = /^(?:\n|;|&&|\|\||\||<<<|<<|<|&>>?|\d*>>?&\d+|\d*>>?)/.exec(command.slice(index))?.[0];
    // A digit only opens a redirect at the start of a word.
    if (operator && !(/^\d/.test(operator) && inWord)) {
      flush(); out.push({ kind: "op", text: operator }); index += operator.length - 1; continue;
    }
    word += char; inWord = true;
  }
  flush();
  return out;
}

const AMBIGUOUS_COMMANDS = new Set(["eval", "cd", "pushd", "popd", "source", ".", "exec", "xargs", "find"]);
const INTERPRETERS = new Set(["sh", "bash", "zsh", "dash", "python", "python3", "node", "perl", "ruby"]);

/**
 * Write targets a shell command shows plainly. A best-effort detector, not a
 * boundary: anything ambiguous (command substitution, heredocs, eval, cd,
 * interpreters, unknown variables) yields no finding, never a stop.
 */
export function shellWriteTargets(command: string): string[] {
  const lexemes = lex(command);
  if (!lexemes || lexemes.some(item => item.kind === "op" && item.text === "<<")) return [];
  const targets: string[] = [];
  const segments: Lexeme[][] = [[]];
  for (const item of lexemes) {
    if (item.kind === "op" && ["\n", ";", "&&", "||", "|"].includes(item.text)) segments.push([]);
    else segments.at(-1)!.push(item);
  }
  for (const segment of segments) {
    const words: string[] = [];
    for (let index = 0; index < segment.length; index++) {
      const item = segment[index]!;
      if (item.kind === "word") { words.push(item.text); continue; }
      const next = segment[index + 1];
      if (/^\d*>>?&\d+$/.test(item.text)) continue;
      if (item.text.includes(">")) { if (next?.kind === "word") { targets.push(next.text); index++; } continue; }
      if (next?.kind === "word") index++;
    }
    let start = 0;
    while (start < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[start]!) || ["sudo", "env", "command", "nohup", "time"].includes(words[start]!))) start++;
    const name = words[start] ? basename(words[start]!) : "";
    if (AMBIGUOUS_COMMANDS.has(name) || INTERPRETERS.has(name)) return [];
    const operands = words.slice(start + 1).filter(word => !word.startsWith("-"));
    if (ALL_ARGUMENTS.has(name)) targets.push(...operands);
    else if (LAST_ARGUMENT.has(name) && operands.length > 1) targets.push(operands.at(-1)!);
    else if (name === "sed" && words.some(word => /^-i/.test(word)) && operands.length) targets.push(operands.at(-1)!);
    else if (name === "dd") targets.push(...operands.flatMap(word => word.startsWith("of=") ? [word.slice(3)] : []));
  }
  // An unknown variable makes the target unreadable: no finding.
  return targets.filter(target => !/\$(?!\{?HOME\}?(?:\/|$))/.test(target));
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
