import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateReadme } from "../services/company-export-readme.js";

// The Paperclip CLI is unsafe when an operator or agent runs it through
// `pnpm paperclipai <sub> <arg>` with a content-bearing argument. `pnpm` treats
// `paperclipai` as a `package.json` script and wraps the argument in a
// double-quoted `/bin/sh` string. The shell then runs command substitution (a
// backtick pair or `$( )`) and variable expansion (`$NAME`) before the CLI
// starts. `pnpm exec paperclipai` runs the installed binary directly. It passes
// the argument as an inert argv value and does not run a shell. The safe form
// and the unsafe form differ only by the `exec` keyword.
//
// This guard has two parts. First, it asserts that the runtime surfaces which
// build a CLI instruction from a non-fixed value emit the safe `pnpm exec` form.
// Second, it scans the guidance surfaces across the repository for any
// content-bearing `pnpm paperclipai` example that returned to the docs.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

function read(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

// ── Content-bearing detection ─────────────────────────────────────────────
//
// A `pnpm paperclipai` line is content-bearing when it carries an argument that
// an agent or operator can fill from untrusted or semi-trusted content: an
// issue body, a comment, Markdown, a pasted snippet, model output, a hostname
// from a request header, an import URL, an identifier, or a secret reference.

// Flags that carry free text, an identifier, a payload, a file, or a secret.
const CONTENT_FLAGS = [
  "--body",
  "--body-file",
  "--title",
  "--comment",
  "--message",
  "--description",
  "--reason",
  "--goal",
  "--alt",
  "--color",
  "--content",
  "--content-file",
  "--summary",
  "--note",
  "--text",
  "--name",
  "--slug",
  "--payload",
  "--payload-json",
  "--env-json",
  "--company-id",
  "--agent-id",
  "--claim-secret",
  "--api-key-env-var-name",
  "--out",
  "--file",
];

// Subcommands whose value is a hostname or an import source. A request header or
// an external URL can supply that value, so it is never fixed.
const CONTENT_SUBCOMMANDS = ["allowed-hostname", "company import"];

// Placeholders that name an untrusted value type. A bare local placeholder such
// as `<name>` or `<plugin-id>` on a local lifecycle command is not listed here.
const UNTRUSTED_PLACEHOLDERS = [
  "<token>",
  "<secret>",
  "<request-id>",
  "this-github-url-or-folder",
];

// A note or warning line names the unsafe form on purpose. Skip it so the
// security note itself does not trip the scan.
function isNoteLine(line: string): boolean {
  const lower = line.toLowerCase();
  return (
    line.includes("pnpm exec paperclipai") ||
    line.includes("npx paperclipai") ||
    lower.includes("do not use") ||
    lower.includes("acceptable only")
  );
}

function isContentBearing(line: string): boolean {
  const commandStart = line.indexOf("pnpm paperclipai");
  if (commandStart < 0) return false;
  if (isNoteLine(line)) return false;
  // Inspect only the command tail. Wrapping code before the command, such as a
  // `${pc.dim(...)}` template call in TypeScript, is not part of the argument.
  const command = line.slice(commandStart);
  if (command.includes("${")) return true;
  if (command.includes("url-or-folder>") || command.toLowerCase().includes("<url")) return true;
  if (UNTRUSTED_PLACEHOLDERS.some((token) => command.includes(token))) return true;
  if (CONTENT_SUBCOMMANDS.some((sub) => command.includes(sub))) return true;
  return CONTENT_FLAGS.some(
    (flag) => command.includes(`${flag} `) || command.includes(`${flag}=`),
  );
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
    if (isContentBearing(text)) {
      offenders.push(`${relPath}:${lineNumber}: ${text.trim()}`);
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

describe("paperclipai CLI invocation safety", () => {
  it("keeps content-bearing pnpm paperclipai examples out of every guidance surface", () => {
    const offenders = scanForOffenders();
    expect(
      offenders,
      `Use \`pnpm exec paperclipai\` for content-bearing arguments:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // ── Direct assertions on the runtime-generated instruction surfaces ──────

  it("emits a static, non-interpolated safe form from the private-hostname guard messages", () => {
    const source = read("server/src/middleware/private-hostname-guard.ts");
    // The blocked-host and missing-host messages must never interpolate the
    // request Host header into the guidance command. An operator or an agent
    // can paste the guidance into a shell, and that outer shell evaluates a
    // metacharacter span in the host before any CLI receives argv. `pnpm exec`
    // does not stop the outer shell. Emit a static `<host>` placeholder only.
    expect(source).toContain("run pnpm exec paperclipai allowed-hostname <host>");
    expect(source).not.toContain("allowed-hostname ${hostname}");
    expect(source).not.toContain("pnpm paperclipai allowed-hostname");
  });

  it("emits a static, non-interpolated safe form from the onboarding access diagnostics", () => {
    const source = read("server/src/routes/access.ts");
    expect(source).not.toMatch(/pnpm paperclipai allowed-hostname/);
    expect(source).toContain("pnpm exec paperclipai allowed-hostname <host>");
    // The onboarding host comes from the request base URL, so a requester
    // controls it. The emitted command must carry a static `<host>` placeholder
    // and never interpolate that value.
    expect(source).not.toMatch(/allowed-hostname \$\{/);
  });

  it("emits the safe form from the agent onboarding prompt", () => {
    const source = read("ui/src/lib/agent-onboarding-prompt.ts");
    expect(source).not.toContain("pnpm paperclipai allowed-hostname");
    expect(source).toContain("pnpm exec paperclipai allowed-hostname <host>");
  });

  it("emits the safe form in the generated company-export README", () => {
    const readme = generateReadme(
      { agents: [], projects: [], skills: [], issues: [] } as never,
      { companyName: "Acme", companyDescription: null },
    );
    expect(readme).toContain("pnpm exec paperclipai company import this-github-url-or-folder");
    expect(readme).not.toContain("pnpm paperclipai company import");
  });

  it("emits the safe form in the company-export preview builder", () => {
    const source = read("ui/src/pages/CompanyExport.tsx");
    expect(source).not.toContain("pnpm paperclipai company import");
    expect(source).toContain("pnpm exec paperclipai company import");
  });

  // ── The safe-invocation note ─────────────────────────────────────────────

  it("documents the safe form in doc/CLI.md", () => {
    const cli = read("doc/CLI.md");
    expect(cli).toContain("Security: safe invocation for content-bearing arguments");
    expect(cli).toContain("pnpm exec paperclipai");
    expect(cli).toContain("inert `argv`");
  });

  it("documents the safe form in the agent-facing skill", () => {
    const skill = read("skills/paperclip/SKILL.md");
    expect(skill).toContain("CLI safety");
    expect(skill).toContain("pnpm exec paperclipai");
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
    expect(offenders[0]).toContain("--title");
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

  it("does not flag a continued pnpm paperclipai command without content-bearing arguments", () => {
    const source = [
      "pnpm paperclipai worktree reseed \\",
      "  --from current \\",
      "  --seed-mode full",
    ].join("\n");
    expect(scanText("doc/EXAMPLE.md", source)).toEqual([]);
  });
});
