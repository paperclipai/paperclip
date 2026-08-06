#!/usr/bin/env node
/**
 * RBR-804 AC2: audit every narrowed drizzle projection over the `issues` table.
 *
 * ## Why this exists
 *
 * `f9f42ae0b5` added `issues.assignee_fallback_reason` to the schema and to the consumers
 * that require it, but never added it to `issueListSelect` -- the narrowed projection the
 * list query uses. The row shape flowing out of `listIssues` was one column short of what
 * downstream required, and `tsc` failed the whole build:
 *
 *   server/src/services/issues.ts(5566,52): error TS2345
 *     Property 'assigneeFallbackReason' is missing in type '{...42 more...}'
 *
 * Local test-green and compile-green are different signals: `vitest` transpiles per file
 * and never runs the project-wide `tsc` that CI's `Build` job runs. The fix for the
 * *instance* is one line. The fix for the *class* is two things:
 *
 *   1. `pnpm --filter @paperclipai/server build` before every push. That is the mechanical
 *      detector -- tsc catches every type-level projection gap in seconds, exhaustively,
 *      and it is the check CI actually runs.
 *   2. This script, for the gaps tsc *cannot* see: a projection whose consumer never reads
 *      the column will compile fine while silently omitting it, so a board view or a sweep
 *      that later starts reading it gets `undefined` rather than a compile error.
 *
 * ## What it reports
 *
 * Every projection that is *assignment-aware* (selects `assigneeAgentId` or
 * `assigneeUserId`) but does not carry `assigneeFallbackReason`. Being listed is NOT
 * automatically a bug -- most of these are deliberately narrow, purpose-built reads (an
 * authorization check does not need the degraded-roster marker). The list is a review
 * surface: when a new assignment-adjacent column lands, walk it and decide per row.
 *
 *   node scripts/audit-issue-projections.mjs
 *   node scripts/audit-issue-projections.mjs --column someOtherColumn
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const columnIndex = process.argv.indexOf("--column");
const COLUMN = columnIndex > -1 ? process.argv[columnIndex + 1] : "assigneeFallbackReason";
/** A projection is worth auditing for this column only if it already reads one of these. */
const TRIGGER_COLUMNS = ["assigneeAgentId", "assigneeUserId"];

const files = execSync(
  "grep -rl 'issues\\.' server/src packages/*/src --include=*.ts | grep -v __tests__",
  { encoding: "utf8" },
).trim().split("\n").filter(Boolean);

/** Brace-match forward from `start` and return the balanced `{...}` block. */
function matchBraces(src, start) {
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return "";
}

const findings = [];
for (const file of files) {
  const src = readFileSync(file, "utf8");
  const starts = [
    ...src.matchAll(/(?:\.select\(\{|(?:const|let)\s+(\w*[Ss]elect\w*)\s*=\s*\{)/g),
  ];
  for (const match of starts) {
    const body = matchBraces(src, src.indexOf("{", match.index));
    const cols = [...body.matchAll(/issues\.(\w+)/g)].map((c) => c[1]);
    if (cols.length === 0) continue;
    if (!TRIGGER_COLUMNS.some((c) => cols.includes(c))) continue;
    findings.push({
      file,
      line: src.slice(0, match.index).split("\n").length,
      name: match[1] ?? "(inline .select)",
      cols: cols.length,
      has: cols.includes(COLUMN),
    });
  }
}

findings.sort((a, b) => b.cols - a.cols);
const gaps = findings.filter((f) => !f.has);
console.log(`Projections over \`issues\` that read an assignee column: ${findings.length}`);
console.log(`  carrying ${COLUMN}: ${findings.length - gaps.length}`);
console.log(`  not carrying it:   ${gaps.length}\n`);
for (const f of findings) {
  console.log(
    `${f.has ? "HAS" : "GAP"} ${String(f.cols).padStart(3)} cols  ${f.file}:${f.line}  ${f.name}`,
  );
}
console.log(
  `\nGAP is a review surface, not a failure: narrow purpose-built reads legitimately omit`
  + `\nthe column. tsc is the authority on which omissions actually break a consumer --`
  + `\nrun \`pnpm --filter @paperclipai/server build\` before pushing.`,
);
