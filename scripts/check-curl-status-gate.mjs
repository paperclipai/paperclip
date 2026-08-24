#!/usr/bin/env node
/**
 * check-curl-status-gate.mjs
 *
 * Static check that rejects NEW bare (status-blind) `curl` mutations of the
 * Paperclip API in agent-facing directories.
 *
 * Why this exists (RBR-882 → RBR-919 → RBR-947)
 * ---------------------------------------------
 * `curl -sS -X POST ... | jq` exits 0 on an HTTP 4xx/5xx. The API's auth
 * denial envelope is success-SHAPED, so a dropped write looks identical to a
 * successful one: the agent reads a plausible JSON body, believes the write
 * landed, and moves on. RBR-919 made the safe path mandatory for generated
 * prompts and RBR-942 swept the docs, but neither stops the idiom coming back
 * the next time somebody copies an old snippet into a new skill. This gate
 * makes recurrence a CI failure rather than a silent regression.
 *
 * What fails
 * ----------
 * A `curl` invocation is an offense when ALL of these hold:
 *   1. it is MUTATING — `-X POST|PATCH|PUT|DELETE` (or `--request ...`);
 *   2. it targets a PAPERCLIP API path — `$PAPERCLIP_API_URL`, a literal
 *      `/api/...` path, or a `"$api/..."`-style resolved base (the idiom in
 *      the agent runtime prompt);
 *   3. it carries NO status gate — none of `--fail-with-body`, `--fail`/`-f`,
 *      `-w '%{http_code}'` / `--write-out '%{http_code}'`, or a delegation to
 *      the blessed `pc-api.sh` helper.
 *
 * Multi-line invocations are joined into one logical command before matching,
 * so a `-w '%{http_code}'` on a continuation line counts as a gate.
 *
 * Allowlist (explicit, with REQUIRED justification)
 * ------------------------------------------------
 * Some sites legitimately show the unsafe form — e.g. a doc example that
 * deliberately demonstrates the failure mode. Opt out with a marker plus a
 * reason, on any line of the invocation or within the 3 lines above it (so a
 * `<!-- ... -->` comment above a fenced markdown block works):
 *
 *   paperclip:allow-bare-curl: <why this site must stay status-blind>
 *
 * A marker with no reason is itself an offense: an unexplained opt-out is how
 * a gate rots into decoration.
 *
 * Scope
 * -----
 * Scan roots: `skills/`, `docs/`, `packages/adapters/*&#47;src/server/`.
 *
 * By default only CHANGED files are scanned (uncommitted + staged + untracked
 * vs HEAD), which is the pre-commit mirror semantics and keeps the gate green
 * against pre-existing sites that RBR-942 owns. CI passes the PR's changed
 * paths explicitly. `--all` audits every file under the scan roots and is the
 * intended default once the sweep has landed everywhere.
 *
 * Usage:
 *   node scripts/check-curl-status-gate.mjs                # changed files vs HEAD
 *   node scripts/check-curl-status-gate.mjs path/a path/b   # explicit paths
 *   node scripts/check-curl-status-gate.mjs --all           # full audit
 */

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

// ── Scope ────────────────────────────────────────────────────────────────
// `packages/adapters/*/src/server` is expressed as a prefix + suffix pair
// rather than a glob so the walker stays dependency-free.
export const SCAN_ROOTS = ["skills", "docs"];
export const ADAPTER_SERVER_GLOB = {
  prefix: "packages/adapters",
  suffix: "src/server",
};

const SCANNABLE_EXTENSIONS = new Set([
  ".md",
  ".mdx",
  ".sh",
  ".bash",
  ".ts",
  ".tsx",
  ".js",
  ".mjs",
  ".cjs",
]);

const SKIP_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  ".turbo",
  ".next",
  "coverage",
]);

export const ALLOW_MARKER = "paperclip:allow-bare-curl";
export const ALLOW_MARKER_LOOKBACK = 3;

// ── Matchers ─────────────────────────────────────────────────────────────
// A mutating method, in either `-X POST` or `--request=POST` shape, quoted or
// not. HEAD/GET/OPTIONS are read-only and out of scope.
const MUTATING_METHOD_RE =
  /(?:^|\s)(?:-X|--request)(?:[=\s]+)["']?(POST|PATCH|PUT|DELETE)\b/i;

// A Paperclip API target. `\$\{?api...` covers the `api="${PAPERCLIP_API_URL%/}"`
// idiom from the agent runtime prompt where the base is resolved into a local var.
const PAPERCLIP_TARGET_RE =
  /PAPERCLIP_API_URL|PAPERCLIP_API_BASE|\/api\/[a-z]|\$\{?api(?:_?base)?\}?\//i;

// Explicitly-not-Paperclip hosts that would otherwise trip `/api/`. Anything
// else external needs the inline allow marker (with a reason), which is the
// point: a reviewer should see it.
const EXTERNAL_HOST_RE =
  /api\.github\.com|api\.openai\.com|api\.anthropic\.com|hooks\.slack\.com|slack\.com\/api|api\.telegram\.org|discord\.com\/api/i;

// A status gate: any of the blessed ways to make a non-2xx observable.
const STATUS_GATE_PATTERNS = [
  /--fail-with-body\b/,
  /--fail\b/,
  /%\{http_code\}/,
  /\bpc-api\.sh\b/,
  /\bpaperclip-api\.sh\b/,
  // Short-flag cluster containing a lowercase `f` (`-f`, `-sSf`, `-fsSL`).
  // `--fail` is curl's only lowercase-`f` short option, so a lowercase `f`
  // inside a short cluster is unambiguously the fail flag. Uppercase `-F`
  // (form data) must NOT count, hence the case-sensitive class.
  /(?:^|\s)-[A-Za-z]*f[A-Za-z]*(?=\s|$)/,
];

const CURL_RE = /(?:^|[\s;&|(`$])curl(?=\s|$)/;

function hasStatusGate(text) {
  return STATUS_GATE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Extract the justification that follows an allow marker on a line.
 * Returns null when the line has no marker, and "" when the marker is present
 * but unjustified.
 */
export function extractAllowReason(line) {
  const index = line.indexOf(ALLOW_MARKER);
  if (index === -1) return null;
  const tail = line.slice(index + ALLOW_MARKER.length);
  // Strip the separator and any trailing comment syntax (`-->`, `*/`, `#`).
  const reason = tail
    .replace(/^\s*[:—-]\s*/, "")
    .replace(/(?:-->|\*\/)\s*$/, "")
    .trim();
  return reason;
}

/**
 * Join physical lines into logical shell commands, and return one block per
 * `curl` invocation found.
 *
 * A block continues while the current line signals continuation (`\`, `|`,
 * `&&`, `||`) or the next line begins a pipe (`| jq ...`). That is exactly the
 * shape the unsafe idiom takes, and it means a gate flag placed on any
 * continuation line is credited to the invocation.
 */
export function extractCurlBlocks(text) {
  const lines = text.split("\n");
  const blocks = [];
  let index = 0;

  while (index < lines.length) {
    if (!CURL_RE.test(lines[index])) {
      index += 1;
      continue;
    }

    const startLine = index;
    const blockLines = [lines[index]];
    let cursor = index;

    while (cursor < lines.length - 1) {
      const current = blockLines[blockLines.length - 1].trimEnd();
      const next = lines[cursor + 1];
      const nextTrimmed = next.trim();
      const currentContinues = /(?:\\|\||&&|\|\|)$/.test(current);
      const nextIsPipe = nextTrimmed.startsWith("|") && !nextTrimmed.startsWith("||");
      if (!currentContinues && !nextIsPipe) break;
      // A fence/blank line terminates the block even after a trailing pipe:
      // that shape is prose, not a continued command.
      if (nextTrimmed === "" || nextTrimmed.startsWith("```")) break;
      blockLines.push(next);
      cursor += 1;
    }

    blocks.push({
      startLine: startLine + 1,
      text: blockLines.join("\n"),
      lines: blockLines,
      contextBefore: lines.slice(Math.max(0, startLine - ALLOW_MARKER_LOOKBACK), startLine),
    });

    index = cursor + 1;
  }

  return blocks;
}

/**
 * @returns {Array<{lineNumber: number, kind: "bare_curl"|"unjustified_allow", line: string}>}
 */
export function findBareCurlOffenses(text) {
  const offenses = [];

  for (const block of extractCurlBlocks(text)) {
    const markerLines = [...block.contextBefore, ...block.lines];
    let allowReason = null;
    for (const line of markerLines) {
      const reason = extractAllowReason(line);
      if (reason !== null) {
        allowReason = reason;
        break;
      }
    }

    if (!MUTATING_METHOD_RE.test(block.text)) continue;
    if (!PAPERCLIP_TARGET_RE.test(block.text)) continue;
    if (EXTERNAL_HOST_RE.test(block.text)) continue;
    if (hasStatusGate(block.text)) continue;

    if (allowReason !== null) {
      if (allowReason.length === 0) {
        offenses.push({
          lineNumber: block.startLine,
          kind: "unjustified_allow",
          line: block.lines[0].trim(),
        });
      }
      continue;
    }

    offenses.push({
      lineNumber: block.startLine,
      kind: "bare_curl",
      line: block.lines[0].trim(),
    });
  }

  return offenses;
}

// ── File discovery ───────────────────────────────────────────────────────
function normalizePath(filePath) {
  return filePath.split(path.sep).join("/");
}

export function isInScanScope(relativePath) {
  const normalized = normalizePath(relativePath);
  if (!SCANNABLE_EXTENSIONS.has(path.extname(normalized))) return false;
  if (normalized.split("/").some((segment) => SKIP_DIRECTORY_NAMES.has(segment))) return false;
  if (SCAN_ROOTS.some((root) => normalized === root || normalized.startsWith(`${root}/`))) {
    return true;
  }
  // packages/adapters/<name>/src/server/**
  const { prefix, suffix } = ADAPTER_SERVER_GLOB;
  if (!normalized.startsWith(`${prefix}/`)) return false;
  const rest = normalized.slice(prefix.length + 1);
  const slash = rest.indexOf("/");
  if (slash === -1) return false;
  return rest.slice(slash + 1).startsWith(`${suffix}/`);
}

export function collectScannableFiles(repoRoot) {
  const results = [];
  const roots = [...SCAN_ROOTS, ADAPTER_SERVER_GLOB.prefix];

  for (const root of roots) {
    const absoluteRoot = path.resolve(repoRoot, root);
    let stats;
    try {
      stats = statSync(absoluteRoot);
    } catch {
      continue;
    }
    if (!stats.isDirectory()) continue;

    const stack = [absoluteRoot];
    while (stack.length > 0) {
      const current = stack.pop();
      let entries;
      try {
        entries = readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const absolute = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
          stack.push(absolute);
          continue;
        }
        const relative = normalizePath(path.relative(repoRoot, absolute));
        if (isInScanScope(relative)) results.push(relative);
      }
    }
  }

  results.sort();
  return results;
}

function gitLines(repoRoot, args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function resolveChangedPaths(repoRoot) {
  return Array.from(
    new Set([
      ...gitLines(repoRoot, ["diff", "--name-only", "HEAD"]),
      ...gitLines(repoRoot, ["diff", "--name-only", "--cached"]),
      ...gitLines(repoRoot, ["ls-files", "--others", "--exclude-standard"]),
    ]),
  );
}

// ── Runner ───────────────────────────────────────────────────────────────
const REMEDIATION = [
  "",
  "A status-blind `curl` mutation reports success on HTTP 4xx/5xx: the Paperclip auth",
  "denial envelope is success-shaped, so a dropped write is indistinguishable from a",
  "landed one (RBR-882). Use one of:",
  "",
  "  1. the blessed helper:  pc-api.sh PATCH \"/issues/$id\" --data-binary @-",
  "  2. curl --fail-with-body -sS -X POST ...",
  "  3. curl -sS -o body.json -w '%{http_code}' -X POST ...   # then assert the code",
  "",
  `If a site must stay status-blind (e.g. a doc example demonstrating the failure mode),`,
  `add \`${ALLOW_MARKER}: <reason>\` on the invocation or within ${ALLOW_MARKER_LOOKBACK} lines above it.`,
  "The reason is required — an unexplained opt-out is also a failure.",
].join("\n");

export function runCheck({
  repoRoot,
  files,
  log = console.log,
  error = console.error,
  readFile = (absolute) => readFileSync(absolute, "utf8"),
} = {}) {
  const offenses = [];

  for (const relative of files) {
    let text;
    try {
      text = readFile(path.resolve(repoRoot, relative));
    } catch {
      // Deleted in the working tree (common for a changed-paths list) — nothing
      // to gate.
      continue;
    }
    for (const offense of findBareCurlOffenses(text)) {
      offenses.push({ relative, ...offense });
    }
  }

  if (offenses.length > 0) {
    error("ERROR: status-blind `curl` mutation(s) of the Paperclip API found:\n");
    for (const offense of offenses) {
      const label =
        offense.kind === "unjustified_allow"
          ? `${ALLOW_MARKER} with no justification`
          : "no status gate";
      error(`  ${offense.relative}:${offense.lineNumber}: [${label}] ${offense.line}`);
    }
    error(REMEDIATION);
    return 1;
  }

  log(
    `  ✓  No status-blind Paperclip \`curl\` mutations found (${files.length} file(s) scanned).`,
  );
  return 0;
}

function main(argv) {
  const repoRoot = process.cwd();
  const scanAll = argv.includes("--all");
  const explicitPaths = argv.filter((arg) => !arg.startsWith("--"));

  let files;
  if (scanAll) {
    files = collectScannableFiles(repoRoot);
  } else {
    const candidates = explicitPaths.length > 0 ? explicitPaths : resolveChangedPaths(repoRoot);
    files = candidates.map(normalizePath).filter(isInScanScope);
  }

  if (files.length === 0) {
    console.log("  ℹ  No in-scope files to check for status-blind curl mutations.");
    return 0;
  }

  return runCheck({ repoRoot, files });
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.exit(main(process.argv.slice(2)));
}
