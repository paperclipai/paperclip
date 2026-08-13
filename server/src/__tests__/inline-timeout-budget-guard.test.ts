import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * RBR-949 guard: an inline numeric last argument to `it`/`test`/`beforeAll`/
 * `beforeEach`/`afterAll`/`afterEach` (and their `.only`/`.skip`/`.each`/etc.
 * variants) SILENTLY OVERRIDES both the config-level `testTimeout`/
 * `hookTimeout` (`server/vitest.config.ts`) and the `--testTimeout`/
 * `--hookTimeout` CLI flags. That is the RBR-912 trap: a too-tight inline
 * budget can hide real tests as "skipped"/timed-out without ever showing up
 * as a config problem, because nothing about the config or the CLI
 * invocation changes.
 *
 * RBR-949 swept ~267 pre-existing inline budgets at or below the config
 * default; this test is the guard that stops the count from creeping back:
 *
 *   1. Any NEW inline budget at or below the config default fails outright —
 *      it can only ever tighten the effective timeout, never loosen it, so
 *      there is no legitimate reason to add one.
 *   2. Any inline budget ABOVE the config default (legitimate for a
 *      genuinely slow suite — real npm installs, real HTTP gateways, real
 *      filesystem work, multi-run heartbeat scheduling scenarios) must carry
 *      an "RBR-949" justification comment within a few lines of the call, so
 *      a drive-by bump can't silently reintroduce the trap without a human
 *      explaining why the suite needs it.
 *
 * Detection mirrors the sweep's own scanner: tokenize each file lightly (mask
 * strings/comments so their contents cannot corrupt bracket counting), find
 * each call to a tracked identifier, bracket-match its argument list, and
 * check whether the last top-level argument is a bare numeric literal.
 */

const TESTS_DIR = dirname(fileURLToPath(import.meta.url));
const VITEST_CONFIG_PATH = join(TESTS_DIR, "..", "..", "vitest.config.ts");
const SELF_PATH = fileURLToPath(import.meta.url);

const HOOK_IDENTS = new Set(["beforeAll", "beforeEach", "afterAll", "afterEach"]);
const TEST_IDENTS = new Set(["it", "test"]);

const TOKEN_RE =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g;

// Matches the identifier plus any `.only`/`.skip`/etc. modifiers and an
// optional trailing `.each`. The `.each(...)` argument list itself is NOT
// captured here — it can contain arbitrarily nested parens (e.g.
// `it.each([...new Set(...)])`), so a bounded `[^)]*` fragment would stop at
// the first nested `)` and silently fail to recognize the real call's open
// paren. Bracket-matching for `.each(...)` (when present) is done in code via
// findMatchingClose, then this regex's own trailing `(` is re-located after
// that point.
const IDENT_CALL_RE =
  /(?<![.\w$])(it|test|beforeAll|beforeEach|afterAll|afterEach)((?:\s*\.\s*(?:only|skip|concurrent|sequential|todo|failing|runIf|skipIf))*)(\s*\.\s*each\s*)?/g;

const NUMERIC_ARG_RE = /^\s*(\d[\d_]*)\s*$/;

// Lines of preceding context checked for a "RBR-949" justification comment
// above a kept (above-config) inline budget. Every site the sweep kept has
// its comment 1-2 lines above the closing `}, N);`, so this has generous
// headroom without being so wide it accepts an unrelated comment.
const JUSTIFICATION_LOOKBACK_LINES = 6;

function readConfigTimeouts(): { testTimeout: number; hookTimeout: number } {
  const src = readFileSync(VITEST_CONFIG_PATH, "utf8");
  const testTimeoutMatch = src.match(/testTimeout:\s*(\d[\d_]*)/);
  const hookTimeoutMatch = src.match(/hookTimeout:\s*(\d[\d_]*)/);
  if (!testTimeoutMatch || !hookTimeoutMatch) {
    throw new Error(
      `Could not read testTimeout/hookTimeout out of ${VITEST_CONFIG_PATH}. ` +
        "This guard reads the config directly so its thresholds can never drift from it.",
    );
  }
  return {
    testTimeout: Number(testTimeoutMatch[1]!.replace(/_/g, "")),
    hookTimeout: Number(hookTimeoutMatch[1]!.replace(/_/g, "")),
  };
}

function maskStringsAndComments(src: string): string {
  return src.replace(TOKEN_RE, (match) => match.replace(/[^\n]/g, " "));
}

function findMatchingClose(masked: string, openIdx: number): number {
  let depth = 0;
  for (let i = openIdx; i < masked.length; i++) {
    const c = masked[i];
    if (c === "(") depth += 1;
    else if (c === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function splitTopLevelArgs(masked: string, openIdx: number, closeIdx: number): Array<[number, number]> {
  let depth = 0;
  const args: Array<[number, number]> = [];
  let curStart = openIdx + 1;
  for (let i = curStart; i < closeIdx; i++) {
    const c = masked[i];
    if (c === "(" || c === "[" || c === "{") depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) {
      args.push([curStart, i]);
      curStart = i + 1;
    }
  }
  if (curStart <= closeIdx) args.push([curStart, closeIdx]);
  return args;
}

type BudgetSite = {
  file: string;
  callLine: number;
  valueLine: number;
  ident: string;
  value: number;
};

function findInlineBudgetSites(src: string, file: string): BudgetSite[] {
  const masked = maskStringsAndComments(src);
  const sites: BudgetSite[] = [];
  for (const match of masked.matchAll(IDENT_CALL_RE)) {
    const ident = match[1]!;
    let cursor = match.index! + match[0].length;
    if (match[3]) {
      // A `.each` was matched; its own `(...)` argument list can nest
      // arbitrarily deep (e.g. `it.each([...new Set(...)])`), so skip past
      // it with proper bracket matching before looking for the real call's
      // open paren, rather than a bounded character-class fragment.
      while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor += 1;
      if (masked[cursor] !== "(") continue;
      const eachClose = findMatchingClose(masked, cursor);
      if (eachClose === -1) continue;
      cursor = eachClose + 1;
    }
    while (cursor < masked.length && /\s/.test(masked[cursor]!)) cursor += 1;
    if (masked[cursor] !== "(") continue;
    const openIdx = cursor;
    const closeIdx = findMatchingClose(masked, openIdx);
    if (closeIdx === -1) continue;
    const args = splitTopLevelArgs(masked, openIdx, closeIdx);
    if (args.length < 2) continue;
    const [lastStart, lastEnd] = args[args.length - 1]!;
    const lastArgSrc = src.slice(lastStart, lastEnd);
    const numMatch = NUMERIC_ARG_RE.exec(lastArgSrc);
    if (!numMatch) continue;
    const value = Number(numMatch[1]!.replace(/_/g, ""));
    const callLine = src.slice(0, match.index!).split("\n").length;
    const valueLine = src.slice(0, lastStart).split("\n").length;
    sites.push({ file, callLine, valueLine, ident, value });
  }
  return sites;
}

function listTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      listTestFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith(".test.ts")) {
      out.push(full);
    }
  }
  return out;
}

function hasJustificationComment(src: string, valueLine: number): boolean {
  const lines = src.split("\n");
  const start = Math.max(0, valueLine - 1 - JUSTIFICATION_LOOKBACK_LINES);
  const window = lines.slice(start, valueLine).join("\n");
  return /RBR-949/.test(window);
}

function scanAll() {
  const files = listTestFiles(TESTS_DIR).filter((f) => f !== SELF_PATH);
  const { testTimeout, hookTimeout } = readConfigTimeouts();
  const belowConfig: string[] = [];
  const unjustifiedAboveConfig: string[] = [];

  for (const file of files) {
    const src = readFileSync(file, "utf8");
    const sites = findInlineBudgetSites(src, file);
    for (const site of sites) {
      const threshold = HOOK_IDENTS.has(site.ident)
        ? hookTimeout
        : TEST_IDENTS.has(site.ident)
          ? testTimeout
          : null;
      if (threshold === null) continue; // unrecognized ident; tracked set above already limits this
      const relFile = site.file.slice(TESTS_DIR.length + 1);
      const label = `${relFile}:${site.callLine} (${site.ident}, ${site.value}ms)`;
      if (site.value <= threshold) {
        belowConfig.push(label);
      } else if (!hasJustificationComment(src, site.valueLine)) {
        unjustifiedAboveConfig.push(label);
      }
    }
  }

  return { belowConfig, unjustifiedAboveConfig };
}

describe("inline timeout-budget guard (RBR-949)", () => {
  it("rejects a new inline budget at or below the vitest config default", () => {
    const { belowConfig } = scanAll();
    expect(
      belowConfig,
      "An inline it/test/beforeAll/beforeEach/afterAll/afterEach numeric budget at or " +
        "below the config-level testTimeout/hookTimeout (server/vitest.config.ts) silently " +
        "overrides it and the --testTimeout/--hookTimeout CLI flags — the exact RBR-912 trap " +
        "RBR-949 swept ~267 of. Delete the inline argument so the suite inherits the config " +
        "default. Offending sites: " + belowConfig.join(", "),
    ).toEqual([]);
  });

  it("requires an RBR-949 justification comment on every inline budget above the config default", () => {
    const { unjustifiedAboveConfig } = scanAll();
    expect(
      unjustifiedAboveConfig,
      "An inline budget above the config default needs a one-line comment mentioning " +
        "RBR-949 within a few lines of the call, explaining why that suite genuinely needs a " +
        "different budget (e.g. real npm installs, real HTTP gateways, real filesystem work, " +
        "multi-run heartbeat scheduling). Without it there is no record of intent and the next " +
        "sweep cannot tell a deliberate override from a forgotten one. Offending sites: " +
        unjustifiedAboveConfig.join(", "),
    ).toEqual([]);
  });
});
