#!/usr/bin/env node
/**
 * check-literal-var-write-paths.mjs
 *
 * Pre-commit guard (TSMC-19768). Reject staged paths that indicate either:
 *
 *   1. an UNEXPANDED shell/Windows variable was used as a LITERAL write path
 *      (e.g. `$PAPERCLIP_WORK_PRODUCTS_DIR/...`, `${VAR}/...`, `%VAR%\...`), or
 *   2. a candidate/PII deliverable (tailored CV, cover letter, application pack,
 *      candidate-* folder) is being committed into the served tree.
 *
 * ## Root cause
 * An agent passed `$PAPERCLIP_WORK_PRODUCTS_DIR/...` to a file-WRITE TOOL call
 * (not a shell command). Tool arguments are NOT shell-expanded, so a real directory
 * literally named `$PAPERCLIP_WORK_PRODUCTS_DIR` was created relative to the server
 * cwd -- inside this repo -- and a TSR candidate CV became committable.
 *
 * ## Why this lives at the git layer
 * The platform cannot reject the write at the tool call: ACP agents (Claude/Codex)
 * write directly to their own filesystem and the acpx engine has no client-side `fs`
 * seam to intercept. The enforceable fence is therefore the commit boundary. This
 * guard hard-rejects the COMMIT; it pairs with the `.gitignore` containment
 * (a glob for `$`-prefixed paths plus candidate patterns) which stops such files
 * being tracked in the first place. Defense in depth: gitignore stops the accident,
 * this guard stops a deliberate force-add from leaking the same class.
 *
 * Exported pure helpers are unit-tested in check-literal-var-write-paths.test.mjs.
 */

import { execSync } from "node:child_process";

// A path SEGMENT that begins with an unexpanded shell var (`$FOO`, `${FOO}`) or a
// Windows var (`%FOO%`). We anchor on `$`/`%` followed by a var-name start so we do
// not flag incidental `$` characters mid-token.
const SHELL_VAR_RE = /\$\{?[A-Za-z_]/;
const WINDOWS_VAR_RE = /%[A-Za-z_][A-Za-z0-9_]*%/;

// Candidate/PII deliverable filename tokens that must never enter the served tree
// (this repo has a public upstream; a leaked CV is unrecoverable). Kept deliberately
// HIGH-PRECISION: recruitment-specific tokens with zero legitimate tracked hits. A
// generic `candidate-*/` rule is intentionally NOT used here — "candidate" collides
// with benchmark `candidate-skills/` and video `candidate-NN` takes; the `.gitignore`
// already untracks the recruitment `work-products/**/candidate-*/` case.
const CANDIDATE_FILE_RE = /(tailored-cv|cover-letter|application-pack)/i;

/** Extract the unexpanded variable token from a path for an actionable message. */
export function extractVarToken(p) {
  const shell = p.match(/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/);
  if (shell) return shell[0];
  const win = p.match(WINDOWS_VAR_RE);
  if (win) return win[0];
  return null;
}

/**
 * Classify a single path. Returns a violation object or null.
 * @param {string} rawPath repo-relative path
 */
export function classifyPath(rawPath) {
  const p = String(rawPath || "").trim();
  if (!p) return null;

  if (SHELL_VAR_RE.test(p) || WINDOWS_VAR_RE.test(p)) {
    const token = extractVarToken(p) ?? "$<var>";
    return {
      path: p,
      kind: "unexpanded-variable",
      message:
        `contains an UNEXPANDED variable segment "${token}". Shell variables are ` +
        `NOT expanded in file-write TOOL arguments -- this created a literal ` +
        `directory named "${token}". Resolve the variable yourself and write to the ` +
        `real location (for work products: $PAPERCLIP_WORK_PRODUCTS_DIR resolves to ` +
        `~/.paperclip/instances/<inst>/companies/<id>/work-products).`,
    };
  }

  if (CANDIDATE_FILE_RE.test(p)) {
    return {
      path: p,
      kind: "candidate-pii-in-repo",
      message:
        `looks like a candidate/PII deliverable. These belong ONLY in the per-company ` +
        `instance work-products dir (~/.paperclip/instances/<inst>/companies/<id>/` +
        `work-products), never in this repo -- it has a public upstream and a leaked ` +
        `CV is unrecoverable.`,
    };
  }

  return null;
}

/** Classify a list of paths, returning all violations. */
export function collectWritePathViolations(paths) {
  const out = [];
  for (const p of paths) {
    const v = classifyPath(p);
    if (v) out.push(v);
  }
  return out;
}

function stagedPaths(exec = execSync) {
  const raw = exec("git diff --cached --name-only --diff-filter=ACMR -z", {
    encoding: "utf8",
  });
  return raw.split("\0").map((s) => s.trim()).filter(Boolean);
}

export function runCheck({ paths, log = console.log, error = console.error } = {}) {
  const violations = collectWritePathViolations(paths);
  if (violations.length === 0) {
    log("[literal-var-guard] OK — no unexpanded-variable or candidate-PII paths staged.");
    return 0;
  }
  error("");
  error("[literal-var-guard] REJECTED: unsafe write path(s) staged for commit.");
  for (const v of violations) {
    error(`  ✗ ${v.path}`);
    error(`      ${v.message}`);
  }
  error("");
  error("[literal-var-guard] Fix: move the file to its real resolved location, remove");
  error("[literal-var-guard] the literal-variable directory, and re-stage. See TSMC-19768.");
  return 1;
}

// CLI entry: `node check-literal-var-write-paths.mjs [path...]`. With no args, reads
// the staged file list from git.
const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const cliPaths = process.argv.slice(2);
  const paths = cliPaths.length > 0 ? cliPaths : stagedPaths();
  process.exit(runCheck({ paths }));
}
