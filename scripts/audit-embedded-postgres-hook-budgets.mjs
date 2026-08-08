#!/usr/bin/env node
/**
 * RBR-918 audit: find every Vitest hook that starts embedded Postgres with an
 * inline timeout budget below the real embedded-Postgres import cost.
 *
 * A hook that times out makes every test in the file report `skipped` while the
 * run still exits 0, so an under-budgeted hook is a permanently-green suite.
 *
 * Usage: node scripts/audit-embedded-postgres-hook-budgets.mjs [--min 120000] [--json]
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { EMBEDDED_POSTGRES_MIN_HOOK_BUDGET_MS } from "./embedded-postgres-test-budget.mjs";

const args = process.argv.slice(2);
const minIndex = args.indexOf("--min");
const MIN_BUDGET_MS =
  minIndex === -1 ? EMBEDDED_POSTGRES_MIN_HOOK_BUDGET_MS : Number(args[minIndex + 1]);
const asJson = args.includes("--json");

const repoRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], {
  encoding: "utf8",
}).trim();

const files = execFileSync(
  "git",
  ["grep", "-l", "--", "startEmbeddedPostgresTestDatabase", "*.ts"],
  { encoding: "utf8", cwd: repoRoot },
)
  .split("\n")
  .filter((line) => line.trim().length > 0);

const HOOK_RE = /\b(beforeAll|beforeEach)\s*\(/g;

/** Walk forward from the opening paren of a hook call and return its full text. */
function readCallText(source, openParenIndex) {
  let depth = 0;
  for (let i = openParenIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openParenIndex, i + 1);
    }
  }
  return null;
}

/**
 * Extract the trailing timeout argument of a hook call, if present.
 *
 * Returns:
 *  - { kind: "none" }             — no third argument; the hook truly inherits
 *                                    the CLI/config `hookTimeout`.
 *  - { kind: "literal", ms }      — a plain numeric literal (e.g. `20_000`).
 *  - { kind: "expression", text } — a third argument present but not a plain
 *                                    numeric literal (e.g. `HOOK_TIMEOUT` or
 *                                    `30 * 1000`). This still overrides the
 *                                    centralized budget at runtime, so it must
 *                                    not be treated the same as "none".
 */
function extractTimeout(callText) {
  // callText looks like "( async () => { ... }, 20_000 )"
  const inner = callText.slice(1, -1);
  let depth = 0;
  let lastComma = -1;
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i];
    if (ch === "(" || ch === "{" || ch === "[") depth += 1;
    else if (ch === ")" || ch === "}" || ch === "]") depth -= 1;
    else if (ch === "," && depth === 0) lastComma = i;
  }
  if (lastComma === -1) return { kind: "none" };
  const tail = inner.slice(lastComma + 1).trim();
  if (!/^[0-9][0-9_]*$/.test(tail)) return { kind: "expression", text: tail };
  return { kind: "literal", ms: Number(tail.replace(/_/g, "")) };
}

const findings = [];

for (const relPath of files) {
  const abs = path.join(repoRoot, relPath);
  const source = readFileSync(abs, "utf8");
  HOOK_RE.lastIndex = 0;
  let match;
  while ((match = HOOK_RE.exec(source)) !== null) {
    const openParen = match.index + match[0].length - 1;
    const callText = readCallText(source, openParen);
    if (!callText) continue;
    if (!callText.includes("startEmbeddedPostgresTestDatabase")) continue;
    const timeout = extractTimeout(callText);
    const line = source.slice(0, match.index).split("\n").length;
    findings.push({
      file: relPath,
      line,
      hook: match[1],
      timeoutMs: timeout.kind === "literal" ? timeout.ms : null,
      timeoutExpr: timeout.kind === "expression" ? timeout.text : null,
      status:
        timeout.kind === "none"
          ? "inherits-cli-budget"
          : timeout.kind === "expression"
            ? "non-literal-budget"
            : timeout.ms < MIN_BUDGET_MS
              ? "under-budget"
              : "ok",
    });
    HOOK_RE.lastIndex = openParen + callText.length;
  }
}

const underBudget = findings.filter((f) => f.status === "under-budget");
const nonLiteral = findings.filter((f) => f.status === "non-literal-budget");
const inherits = findings.filter((f) => f.status === "inherits-cli-budget");
const ok = findings.filter((f) => f.status === "ok");

if (asJson) {
  console.log(JSON.stringify({ minBudgetMs: MIN_BUDGET_MS, findings }, null, 2));
} else {
  console.log(`embedded-Postgres hook budget audit (min ${MIN_BUDGET_MS}ms)`);
  console.log(`  files scanned:          ${files.length}`);
  console.log(`  db-starting hooks:      ${findings.length}`);
  console.log(`  inline budget OK:       ${ok.length}`);
  console.log(`  inherits CLI budget:    ${inherits.length}`);
  console.log(`  UNDER BUDGET:           ${underBudget.length}`);
  console.log(`  NON-LITERAL BUDGET:     ${nonLiteral.length}`);
  for (const finding of underBudget) {
    console.log(
      `    ${finding.file}:${finding.line} ${finding.hook} => ${finding.timeoutMs}ms`,
    );
  }
  for (const finding of nonLiteral) {
    console.log(
      `    ${finding.file}:${finding.line} ${finding.hook} => non-literal timeout expression: ${finding.timeoutExpr}`,
    );
  }
}

process.exitCode = underBudget.length > 0 || nonLiteral.length > 0 ? 1 : 0;
