import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The Paperclip CLI is unsafe when an operator or agent runs it through
// `pnpm paperclipai <sub> <arg>` with a content-bearing argument. `pnpm` wraps
// the argument in a double-quoted `/bin/sh` string. The shell then runs command
// substitution (a backtick pair or `$( )`) and variable expansion (`$NAME`)
// before the CLI starts. `npx paperclipai` passes the argument as an inert argv
// value and does not run a shell. This guard keeps the agent-facing guidance on
// the safe form. It fails if a content-bearing `pnpm paperclipai` example
// returns, or if the security note disappears.

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");

// Files that document CLI usage for agents and operators.
const GUIDANCE_FILES = [
  "doc/CLI.md",
  "docs/cli/control-plane-commands.md",
  "docs/cli/overview.md",
  "doc/DEVELOPING.md",
  "skills/paperclip/SKILL.md",
  ".agents/skills/paperclip-page/README.md",
];

// A `pnpm paperclipai` example is content-bearing when it carries a free-text
// argument that an agent can fill from untrusted content (issue text, comment
// bodies, Markdown, pasted snippets, model output).
const CONTENT_FLAGS = [
  "--body",
  "--body-file",
  "--title",
  "--comment",
  "--message",
  "--description",
  "--reason",
  "--payload",
  "--payload-json",
  "--env-json",
  "--name",
  "--alt",
  "--color",
  "--goal",
  "--content",
  "--content-file",
  "--summary",
  "--note",
  "--text",
  "--slug",
];

function readGuidance(relPath: string): string {
  return readFileSync(path.join(repoRoot, relPath), "utf8");
}

function isSecurityNoteLine(line: string): boolean {
  // The security note itself names the unsafe form to warn against it. Skip a
  // line that also states the safe rule, so the note does not trip the guard.
  return line.includes("npx paperclipai") || line.includes("Do not use `pnpm paperclipai`");
}

describe("paperclipai CLI invocation safety", () => {
  it("keeps content-bearing pnpm paperclipai examples out of the guidance", () => {
    const offenders: string[] = [];

    for (const relPath of GUIDANCE_FILES) {
      const lines = readGuidance(relPath).split("\n");
      lines.forEach((line, index) => {
        if (!line.includes("pnpm paperclipai")) {
          return;
        }
        if (isSecurityNoteLine(line)) {
          return;
        }
        const flag = CONTENT_FLAGS.find((candidate) => line.includes(`${candidate} `) || line.includes(`${candidate}=`));
        if (flag) {
          offenders.push(`${relPath}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(offenders, `Use \`npx paperclipai\` for content-bearing arguments:\n${offenders.join("\n")}`).toEqual([]);
  });

  it("documents the safe form in doc/CLI.md", () => {
    const cli = readGuidance("doc/CLI.md");
    expect(cli).toContain("Security: safe invocation for content-bearing arguments");
    expect(cli).toContain("npx paperclipai");
    expect(cli).toContain("inert `argv`");
  });

  it("documents the safe form in the agent-facing skill", () => {
    const skill = readGuidance("skills/paperclip/SKILL.md");
    expect(skill).toContain("CLI safety");
    expect(skill).toContain("npx paperclipai");
    expect(skill).toContain("Do not use `pnpm paperclipai`");
  });
});
