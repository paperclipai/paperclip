#!/usr/bin/env node
// verify-content.mjs — content-based release verification gate (NEO-527, subtask 522b of NEO-522).
//
// WHY content, never SHA ancestry: on cortex-beta, branches re-land the same work under fresh
// SHAs (renumbered migrations, ported commits). Commit lineage therefore proves nothing about
// what is actually running. This gate asserts *behaviour* against the running instance instead:
// the marker is in the served bundle, the route is mounted, the table exists.
//
// It loads a probe set (release-probes/<ISSUE>.yaml — see release-probes/README.md for the
// schema) and runs every probe against a target base URL. Each probe is one of three types:
//
//   bundle — fetch a served JS asset (auto-discovered from the SPA's index.html, or a fixed
//            path) and assert a required marker string/regex is present.
//   route  — fetch an API route and assert the HTTP status (and optionally a body marker). A
//            404 where 200/401 was expected means the feature never deployed.
//   db     — run a CLI/runtime command and assert a marker in its output. Raw `psql` is refused
//            (Hard Rule #1): DB assertions go through the runtime, never a direct client.
//
// Exit codes: 0 = all probes green; 1 = one or more probes red; 2 = usage / config error (no
// probe files, unreadable/invalid probe file). A non-zero exit is what drives auto-rollback when
// this runs as the post-deploy gate wired in scripts/cortex-deploy.sh (CORTEX_DEPLOY_VERIFY_CMD).
//
// Usage:
//   node scripts/verify-content.mjs --base http://127.0.0.1:3200 release-probes/NEO-521.yaml
//   node scripts/verify-content.mjs --base http://127.0.0.1:3200 --dir release-probes
//   node scripts/verify-content.mjs --base http://127.0.0.1:3200            # defaults to --dir release-probes
//
// Options:
//   --base <url>        base URL of the running instance (required), e.g. http://127.0.0.1:3200
//   --probes <file>     a probe file to run (repeatable); positional file args work too
//   --dir <dir>         run every *.yaml / *.json probe file in a directory (default: release-probes)
//   --timeout <ms>      per-request timeout (default 8000)
//   --json              emit a machine-readable JSON summary instead of the human report
//   -h | --help         this help

import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const EXIT_OK = 0;
const EXIT_RED = 1;
const EXIT_CONFIG = 2;
const DEFAULT_DIR = "release-probes";

class ConfigError extends Error {}

// ---------------------------------------------------------------------------------------------
// Minimal YAML parser — scoped to the probe schema (no runtime dependency, so this gate runs
// under a bare `node` at deploy time). Supports: comments, `key: scalar`, a top-level `probes:`
// block sequence of mappings, inline flow sequences (`[200, 401]`), and quoted/bare scalars.
// Anything outside that subset throws, so a malformed probe file fails loud (exit 2), never
// silently green. `.json` probe files are parsed with JSON.parse instead.
// ---------------------------------------------------------------------------------------------
function parseScalar(raw) {
  const s = raw.trim();
  if (s === "") return "";
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  if (s === "true") return true;
  if (s === "false") return false;
  if (s === "null" || s === "~") return null;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

function parseFlowSequence(raw) {
  // `[a, b, c]` — scalars only (sufficient for expectStatus).
  const inner = raw.trim().slice(1, -1).trim();
  if (inner === "") return [];
  return inner.split(",").map((part) => parseScalar(part));
}

function parseValue(raw) {
  const s = raw.trim();
  if (s.startsWith("[") && s.endsWith("]")) return parseFlowSequence(s);
  return parseScalar(s);
}

function splitKeyValue(line) {
  const idx = line.indexOf(":");
  if (idx === -1) throw new ConfigError(`expected 'key: value', got: ${line.trim()}`);
  return { key: line.slice(0, idx).trim(), rest: line.slice(idx + 1) };
}

function stripComment(line) {
  // Drop a trailing ` # comment`. Naive but safe for this schema (no `#` inside bare scalars we
  // use); quoted strings containing `#` are preserved by only cutting on ` #` outside quotes.
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble && (i === 0 || line[i - 1] === " ")) {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseYaml(text) {
  const rawLines = text.split(/\r?\n/);
  const lines = [];
  for (const raw of rawLines) {
    const stripped = stripComment(raw).replace(/\s+$/, "");
    if (stripped.trim() === "") continue;
    lines.push(stripped);
  }

  const doc = {};
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\S/.test(line) === false) {
      throw new ConfigError(`unexpected indentation at top level: ${line}`);
    }
    const { key, rest } = splitKeyValue(line);
    if (rest.trim() === "") {
      // Block value: either a sequence of mappings or a nested mapping. We only need sequences.
      const { items, next } = parseBlockSequence(lines, i + 1);
      doc[key] = items;
      i = next;
    } else {
      doc[key] = parseValue(rest);
      i += 1;
    }
  }
  return doc;
}

function indentOf(line) {
  const m = line.match(/^(\s*)/);
  return m ? m[1].length : 0;
}

function parseBlockSequence(lines, start) {
  const items = [];
  let i = start;
  if (i >= lines.length || !lines[i].trimStart().startsWith("- ")) {
    // Not a sequence (e.g. an empty block). Treat as empty list.
    return { items, next: i };
  }
  const seqIndent = indentOf(lines[i]);
  while (i < lines.length) {
    const line = lines[i];
    const ind = indentOf(line);
    if (ind < seqIndent) break;
    if (ind === seqIndent && line.trimStart().startsWith("- ")) {
      const map = {};
      // First key sits on the `- ` line itself.
      const firstContent = line.slice(ind + 2);
      const firstIndent = ind + 2;
      const { key, rest } = splitKeyValue(firstContent);
      map[key] = parseValue(rest);
      i += 1;
      // Remaining keys of this mapping are indented to firstIndent.
      while (i < lines.length) {
        const l2 = lines[i];
        const ind2 = indentOf(l2);
        if (ind2 !== firstIndent || l2.trimStart().startsWith("- ")) break;
        const kv = splitKeyValue(l2.slice(ind2));
        map[kv.key] = parseValue(kv.rest);
        i += 1;
      }
      items.push(map);
    } else {
      break;
    }
  }
  return { items, next: i };
}

// ---------------------------------------------------------------------------------------------
// Probe file loading
// ---------------------------------------------------------------------------------------------
async function loadProbeFile(file) {
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    throw new ConfigError(`cannot read probe file ${file}: ${err.message}`);
  }
  let parsed;
  try {
    parsed = file.endsWith(".json") ? JSON.parse(text) : parseYaml(text);
  } catch (err) {
    throw new ConfigError(`invalid probe file ${file}: ${err.message}`);
  }
  const probes = parsed.probes;
  if (!Array.isArray(probes) || probes.length === 0) {
    throw new ConfigError(`probe file ${file} has no 'probes' list`);
  }
  return {
    file,
    issue: parsed.issue ?? path.basename(file).replace(/\.(ya?ml|json)$/i, ""),
    description: parsed.description ?? "",
    probes,
  };
}

async function resolveProbeFiles(opts) {
  if (opts.files.length > 0) return opts.files;
  const dir = opts.dir ?? DEFAULT_DIR;
  if (!existsSync(dir)) {
    throw new ConfigError(
      `no probe files given and default probe dir '${dir}' does not exist`,
    );
  }
  const entries = await readdir(dir);
  const files = entries
    .filter((e) => /\.(ya?ml|json)$/i.test(e))
    .sort()
    .map((e) => path.join(dir, e));
  if (files.length === 0) {
    throw new ConfigError(`probe dir '${dir}' contains no *.yaml / *.json probe files`);
  }
  return files;
}

// ---------------------------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------------------------
async function fetchText(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow" });
    const body = await res.text();
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

function extractAssetPaths(html, assetMatch) {
  // Pull `src="/assets/index-*.js"` / `href=".../*.js"` refs from the SPA index.html.
  const paths = [];
  const re = /(?:src|href)\s*=\s*["']([^"']+\.js)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) paths.push(m[1]);
  const wanted = paths.filter((p) => p.includes(assetMatch));
  return wanted.length > 0 ? wanted : paths;
}

// ---------------------------------------------------------------------------------------------
// Probe runners — each returns { ok, detail }
// ---------------------------------------------------------------------------------------------
function toRegExp(marker, field) {
  try {
    return new RegExp(marker);
  } catch (err) {
    throw new ConfigError(`probe ${field} is not a valid regex (${marker}): ${err.message}`);
  }
}

async function runBundleProbe(probe, base, timeoutMs) {
  if (probe.match == null) return { ok: false, detail: "bundle probe missing 'match'" };
  const marker = toRegExp(String(probe.match), "match");
  let assetUrls;
  if (probe.asset) {
    assetUrls = [new URL(probe.asset, base).toString()];
  } else {
    const htmlPath = probe.path ?? "/";
    const htmlUrl = new URL(htmlPath, base).toString();
    let html;
    try {
      const res = await fetchText(htmlUrl, timeoutMs);
      if (res.status !== 200) {
        return { ok: false, detail: `index ${htmlPath} returned HTTP ${res.status}` };
      }
      html = res.body;
    } catch (err) {
      return { ok: false, detail: `fetch ${htmlUrl} failed: ${err.message}` };
    }
    const assetPaths = extractAssetPaths(html, probe.assetMatch ?? "index-");
    if (assetPaths.length === 0) {
      return { ok: false, detail: `no JS asset found in ${htmlPath}` };
    }
    assetUrls = assetPaths.map((p) => new URL(p, base).toString());
  }

  const checked = [];
  for (const url of assetUrls) {
    try {
      const res = await fetchText(url, timeoutMs);
      if (res.status !== 200) {
        checked.push(`${url} → HTTP ${res.status}`);
        continue;
      }
      if (marker.test(res.body)) {
        return { ok: true, detail: `marker /${marker.source}/ found in ${url}` };
      }
      checked.push(`${url} (marker absent)`);
    } catch (err) {
      checked.push(`${url} → ${err.message}`);
    }
  }
  return { ok: false, detail: `marker /${marker.source}/ not found; checked ${checked.join(", ")}` };
}

async function runRouteProbe(probe, base, timeoutMs) {
  if (!probe.path) return { ok: false, detail: "route probe missing 'path'" };
  const expect = normalizeStatusList(probe.expectStatus);
  const url = new URL(probe.path, base).toString();
  let res;
  try {
    res = await fetchText(url, timeoutMs);
  } catch (err) {
    return { ok: false, detail: `fetch ${url} failed: ${err.message}` };
  }
  if (!expect.includes(res.status)) {
    return {
      ok: false,
      detail: `${url} → HTTP ${res.status}, expected one of [${expect.join(", ")}]`,
    };
  }
  if (probe.match != null) {
    const marker = toRegExp(String(probe.match), "match");
    if (!marker.test(res.body)) {
      return { ok: false, detail: `${url} status ${res.status} ok but body marker /${marker.source}/ absent` };
    }
  }
  return { ok: true, detail: `${url} → HTTP ${res.status}` };
}

function normalizeStatusList(expectStatus) {
  if (expectStatus == null) return [200];
  const arr = Array.isArray(expectStatus) ? expectStatus : [expectStatus];
  return arr.map((n) => Number(n));
}

function execCommand(command, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err, timedOut });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: -1, out, err: err + e.message, timedOut });
    });
  });
}

async function runDbProbe(probe, timeoutMs) {
  if (!probe.command) return { ok: false, detail: "db probe missing 'command'" };
  // Hard Rule #1: DB assertions go through the runtime/CLI, never a raw psql client.
  if (/\bpsql\b/i.test(probe.command)) {
    return {
      ok: false,
      detail: "db probe command invokes raw psql — refused (Hard Rule #1: use the CLI/runtime)",
    };
  }
  if (probe.match == null) return { ok: false, detail: "db probe missing 'match'" };
  const marker = toRegExp(String(probe.match), "match");
  const { code, out, err, timedOut } = await execCommand(probe.command, timeoutMs);
  if (timedOut) return { ok: false, detail: `command timed out after ${timeoutMs}ms` };
  const combined = `${out}\n${err}`;
  const allowNonZero = probe.allowNonZeroExit === true;
  if (code !== 0 && !allowNonZero) {
    return { ok: false, detail: `command exited ${code}: ${combined.trim().slice(0, 200)}` };
  }
  if (!marker.test(combined)) {
    return { ok: false, detail: `marker /${marker.source}/ absent from command output` };
  }
  return { ok: true, detail: `marker /${marker.source}/ found in command output` };
}

async function runProbe(probe, base, timeoutMs) {
  switch (probe.type) {
    case "bundle":
      return runBundleProbe(probe, base, timeoutMs);
    case "route":
      return runRouteProbe(probe, base, timeoutMs);
    case "db":
      return runDbProbe(probe, timeoutMs);
    default:
      return { ok: false, detail: `unknown probe type '${probe.type}' (expected bundle|route|db)` };
  }
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
function parseArgs(argv) {
  const opts = { base: "", files: [], dir: null, timeout: 8000, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case "--base": opts.base = argv[++i] ?? ""; break;
      case "--probes": opts.files.push(argv[++i] ?? ""); break;
      case "--dir": opts.dir = argv[++i] ?? ""; break;
      case "--timeout": opts.timeout = Number(argv[++i] ?? "8000"); break;
      case "--json": opts.json = true; break;
      case "-h":
      case "--help": opts.help = true; break;
      default:
        if (a.startsWith("--")) throw new ConfigError(`unknown option: ${a}`);
        opts.files.push(a);
    }
  }
  return opts;
}

function helpText() {
  return readFileHeader();
}

function readFileHeader() {
  // The banner comment doubles as --help.
  return [
    "verify-content.mjs — content-based release verification gate (NEO-527 / 522b)",
    "",
    "Usage:",
    "  node scripts/verify-content.mjs --base <url> [probe-file ...]",
    "  node scripts/verify-content.mjs --base <url> --dir release-probes",
    "",
    "Options:",
    "  --base <url>     base URL of the running instance (required)",
    "  --probes <file>  probe file to run (repeatable; positional args also work)",
    "  --dir <dir>      run every *.yaml/*.json probe file in a dir (default: release-probes)",
    "  --timeout <ms>   per-request/command timeout (default 8000)",
    "  --json           emit a JSON summary instead of the human report",
    "",
    "Exit: 0 all green · 1 one or more red · 2 usage/config error",
  ].join("\n");
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`verify-content: ${err.message}\n`);
    return EXIT_CONFIG;
  }
  if (opts.help) {
    process.stdout.write(helpText() + "\n");
    return EXIT_OK;
  }
  if (!opts.base) {
    process.stderr.write("verify-content: --base <url> is required\n\n" + helpText() + "\n");
    return EXIT_CONFIG;
  }

  let files;
  let sets;
  try {
    files = await resolveProbeFiles(opts);
    sets = await Promise.all(files.map(loadProbeFile));
  } catch (err) {
    if (err instanceof ConfigError) {
      process.stderr.write(`verify-content: ${err.message}\n`);
      return EXIT_CONFIG;
    }
    throw err;
  }

  const results = [];
  for (const set of sets) {
    for (const probe of set.probes) {
      let outcome;
      try {
        outcome = await runProbe(probe, opts.base, opts.timeout);
      } catch (err) {
        if (err instanceof ConfigError) {
          process.stderr.write(`verify-content: ${err.message}\n`);
          return EXIT_CONFIG;
        }
        outcome = { ok: false, detail: `probe threw: ${err.message}` };
      }
      results.push({
        issue: set.issue,
        file: set.file,
        name: probe.name ?? "(unnamed)",
        type: probe.type,
        ok: outcome.ok,
        detail: outcome.detail,
      });
    }
  }

  const failed = results.filter((r) => !r.ok);
  if (opts.json) {
    process.stdout.write(
      JSON.stringify({ base: opts.base, total: results.length, failed: failed.length, results }, null, 2) + "\n",
    );
  } else {
    process.stdout.write(`\ncontent-verify against ${opts.base} — ${sets.length} probe file(s), ${results.length} probe(s)\n`);
    for (const r of results) {
      const tag = r.ok ? "\x1b[32mPASS\x1b[0m" : "\x1b[31mFAIL\x1b[0m";
      process.stdout.write(`  ${tag} [${r.issue} · ${r.type}] ${r.name} — ${r.detail}\n`);
    }
    if (failed.length === 0) {
      process.stdout.write(`\x1b[32m✓ all ${results.length} probe(s) green\x1b[0m\n`);
    } else {
      process.stdout.write(`\x1b[31m✗ ${failed.length}/${results.length} probe(s) RED\x1b[0m\n`);
    }
  }
  return failed.length === 0 ? EXIT_OK : EXIT_RED;
}

// Run only when invoked directly (not when imported by the test suite).
if (pathToFileURL(process.argv[1] ?? "").href === import.meta.url) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`verify-content: unexpected error: ${err?.stack || err}\n`);
      process.exit(EXIT_CONFIG);
    });
}

export { parseYaml, runProbe, normalizeStatusList, extractAssetPaths };
