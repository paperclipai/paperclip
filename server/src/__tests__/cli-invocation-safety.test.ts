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
// The scan reads Markdown and source files. A `pnpm paperclipai` occurrence
// sits in one of two places, and only a real terminator ends the command:
//  - Inside a balanced string span whose opener is directly next to the marker.
//    A backtick opens a Markdown inline-code span or a JavaScript template
//    literal. A double quote opens a source string literal. The guard trusts the
//    span only when the opening delimiter is adjacent to the marker: the
//    delimiter, then optional whitespace or a `$ ` shell prompt, then `pnpm`.
//    The next matching delimiter closes the span. That close is a real, safely
//    parsed boundary. The command is the text from the marker to the close.
//  - Outside a trusted span. This holds for a fenced code block, plain text, and
//    any line where the nearest earlier delimiter is not adjacent to the marker.
//    The command runs to the end of the logical line, or to a ` #` comment. A
//    backtick, a quote, or a parenthesis here is a shell metacharacter, so it
//    stays in the extracted command. The command then fails the allowlist match
//    and the guard reports it. This is the key rule: a quote or a backtick that
//    follows the command is never a truncation boundary, so a line such as
//    `pnpm paperclipai run "$(cat secret)"` keeps its dangerous suffix and the
//    guard rejects it.
//
// The guard fails closed on an ambiguous quote context. It never infers a safe
// enclosing span from an arbitrary unmatched delimiter earlier on the line. An
// earlier `"` or backtick that is not adjacent to the marker is ambiguous
// context, so the guard extracts to the logical line end and keeps any dangerous
// suffix in the command. An escaped delimiter (`\"` or an escaped backtick) is
// literal text, so it never opens or closes a span.
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

function extractCommand(text: string, at: number): string {
  const before = text.slice(0, at);
  const tail = text.slice(at);
  const open = adjacentSpanOpener(before);
  if (open !== null) {
    // The marker sits inside a span whose opener is adjacent to the marker. The
    // matching close delimiter is the only real terminator here.
    const close = nextUnescapedDelimiter(tail, open);
    const raw = close < 0 ? tail : tail.slice(0, close);
    return normalizeCommand(raw);
  }
  // Outside a trusted span the command runs to a ` #` comment or the line end. A
  // quote, a backtick, or a parenthesis stays inside the extracted command, so
  // an ambiguous earlier delimiter never truncates the command.
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

function findOffenders(text: string): string[] {
  const offenders: string[] = [];
  const marker = "pnpm paperclipai";
  let from = 0;
  for (;;) {
    const at = text.indexOf(marker, from);
    if (at < 0) break;
    from = at + marker.length;
    const before = text.slice(0, at);
    const wrapped = /\$\(\s*$/.test(before);
    const command = extractCommand(text, at);
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
    for (const command of findOffenders(text)) {
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

  it("still trusts a span whose opener is adjacent to the marker", () => {
    // A Markdown inline-code span and a source string literal both place the
    // opener directly before the marker, so the guard reads the full command
    // inside the span and matches the allowlist. An optional `$ ` prompt inside
    // the span still counts as adjacent.
    expect(scanText("doc/E.md", "Run `pnpm paperclipai run` to start.")).toEqual([]);
    expect(scanText("doc/E.md", '  command: "pnpm paperclipai onboard --yes --run",')).toEqual([]);
    expect(scanText("doc/E.md", "Run `$ pnpm paperclipai doctor` to check.")).toEqual([]);
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
