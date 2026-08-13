import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generateReadme } from "../services/company-export-readme.js";

// The Paperclip CLI is unsafe when an operator or agent runs it through
// `pnpm paperclipai <sub> <arg>` with a content-bearing argument. `pnpm` wraps
// the argument in a double-quoted `/bin/sh` string. The shell then runs command
// substitution (a backtick pair or `$( )`) and variable expansion (`$NAME`)
// before the CLI starts. `npx paperclipai` passes the argument as an inert argv
// value and does not run a shell.
//
// This guard has two parts. First, it asserts that the runtime surfaces which
// build a CLI instruction from a non-fixed value emit the safe `npx` form.
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

function scanForOffenders(): string[] {
  const offenders: string[] = [];
  for (const relPath of listGuidanceFiles()) {
    const lines = read(relPath).split("\n");
    lines.forEach((line, index) => {
      if (isContentBearing(line)) {
        offenders.push(`${relPath}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  return offenders;
}

describe("paperclipai CLI invocation safety", () => {
  it("keeps content-bearing pnpm paperclipai examples out of every guidance surface", () => {
    const offenders = scanForOffenders();
    expect(
      offenders,
      `Use \`npx paperclipai\` for content-bearing arguments:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });

  // ── Direct assertions on the runtime-generated instruction surfaces ──────

  it("emits the safe form from the private-hostname guard messages", () => {
    const source = read("server/src/middleware/private-hostname-guard.ts");
    // The blocked-host message interpolates the request Host header, so a
    // requester controls the value.
    expect(source).toContain("npx paperclipai allowed-hostname ${hostname}");
    expect(source).toContain("run npx paperclipai allowed-hostname <host>");
    expect(source).not.toContain("pnpm paperclipai allowed-hostname");
  });

  it("emits the safe form from the onboarding access diagnostics", () => {
    const source = read("server/src/routes/access.ts");
    expect(source).not.toMatch(/pnpm paperclipai allowed-hostname/);
    expect(source).toContain("npx paperclipai allowed-hostname");
  });

  it("emits the safe form from the agent onboarding prompt", () => {
    const source = read("ui/src/lib/agent-onboarding-prompt.ts");
    expect(source).not.toContain("pnpm paperclipai allowed-hostname");
    expect(source).toContain("npx paperclipai allowed-hostname <host>");
  });

  it("emits the safe form in the generated company-export README", () => {
    const readme = generateReadme(
      { agents: [], projects: [], skills: [], issues: [] } as never,
      { companyName: "Acme", companyDescription: null },
    );
    expect(readme).toContain("npx paperclipai company import this-github-url-or-folder");
    expect(readme).not.toContain("pnpm paperclipai company import");
  });

  it("emits the safe form in the company-export preview builder", () => {
    const source = read("ui/src/pages/CompanyExport.tsx");
    expect(source).not.toContain("pnpm paperclipai company import");
    expect(source).toContain("npx paperclipai company import");
  });

  // ── The safe-invocation note ─────────────────────────────────────────────

  it("documents the safe form in doc/CLI.md", () => {
    const cli = read("doc/CLI.md");
    expect(cli).toContain("Security: safe invocation for content-bearing arguments");
    expect(cli).toContain("npx paperclipai");
    expect(cli).toContain("inert `argv`");
  });

  it("documents the safe form in the agent-facing skill", () => {
    const skill = read("skills/paperclip/SKILL.md");
    expect(skill).toContain("CLI safety");
    expect(skill).toContain("npx paperclipai");
    expect(skill).toContain("Do not use `pnpm paperclipai`");
  });
});
