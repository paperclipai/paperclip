#!/usr/bin/env node
// NEO-440 (W3) — Merge-time branding guard for the Neoreef/paperclip fork.
//
// Fails CI when the "Paperclip" brand word is (re)introduced into the rendered/
// model-echoable surface (Buckets A+B+G+H-text) — the usual vector is an
// upstream sync from paperclipai/paperclip. Frozen internal contracts
// (PAPERCLIP_* env, @paperclipai/* pkgs, paths, headers, identifiers, CSS,
// namespace/conn strings, tests) are structurally exempt, so the guard never
// fights the interop surface we deliberately keep.
//
// Two modes:
//   (default)  lint  — scan the guarded globs; print every violation as
//                       file:line:text; exit 1 if any are found (fails the PR).
//   --fix      codemod — case-preserving rewrite Paperclip→Cortex / paperclip→
//                        cortex over the same globs; exit 0; print change count.
//
// The detector + globs + allowlist are NOT defined here — they are imported
// verbatim from ./branding-guard-spec.mjs, which is kept byte-identical to
// NEO-438/W1's tools/guard-spec.mjs (the single source of truth). See the
// lockstep assertion in check-branding-no-paperclip.test.mjs.
//
// Zero runtime deps (matches the repo's other scripts/check-*.mjs). File
// discovery uses `git ls-files` so the guard sees exactly what a PR would
// merge, and stays fast on a large tree.
//
// Usage:
//   node scripts/check-branding-no-paperclip.mjs            # lint (CI gate)
//   node scripts/check-branding-no-paperclip.mjs --fix      # apply codemod
//   node scripts/check-branding-no-paperclip.mjs --root DIR # scan another tree
//   node scripts/check-branding-no-paperclip.mjs --json     # machine-readable

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GUARD_GLOBS,
  BRAND_WORD_RE,
  hasBrandWord,
  strongContract,
  isAllowlisted,
  TEST_PATH_RE,
} from './branding-guard-spec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---- args -----------------------------------------------------------------
function parseArgs(argv) {
  const opts = { fix: false, json: false, root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--fix') opts.fix = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--root') opts.root = argv[++i];
    else if (a === '-h' || a === '--help') { opts.help = true; }
    else { console.error(`unknown arg: ${a}`); process.exit(2); }
  }
  return opts;
}

// ---- glob → RegExp (only the shapes GUARD_GLOBS actually uses) -------------
// Supports literal segments, `*` (one path segment), and `**` (any depth).
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        // `**/` -> any number of dirs (incl. none); bare `**` -> anything
        if (glob[i + 1] === '/') { i++; re += '(?:[^/]+/)*'; }
        else re += '.*';
      } else {
        re += '[^/]*'; // single segment
      }
    } else if ('\\^$.|?+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  return new RegExp('^' + re + '$');
}

const GLOB_RES = GUARD_GLOBS.map(globToRegExp);
const inGuardedGlobs = (path) => GLOB_RES.some((r) => r.test(path));

// ---- file discovery -------------------------------------------------------
function listGuardedFiles(root) {
  let files;
  const gitDir = join(root, '.git');
  if (existsSync(gitDir)) {
    // Tracked files exactly as a PR would carry them.
    const out = execFileSync('git', ['-C', root, 'ls-files', '-z'], {
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    });
    files = out.split('\0').filter(Boolean);
  } else {
    // Fallback (e.g. the unit-test temp tree): walk the fs.
    files = walk(root, root);
  }
  return files.filter(inGuardedGlobs).filter((p) => !TEST_PATH_RE.test(p));
}

function walk(dir, root) {
  const out = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === '.git' || ent.name === 'node_modules') continue;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(abs, root));
    else if (ent.isFile()) out.push(abs.slice(root.length + 1));
  }
  return out;
}

// ---- case-preserving rewrite ----------------------------------------------
// Global, case-insensitive twin of BRAND_WORD_RE for replace-all.
const BRAND_WORD_RE_G = new RegExp(BRAND_WORD_RE.source, 'gi');

export function rewriteLine(line) {
  // Whole-line freeze for strong contracts (namespace keys, conn strings) that
  // *look* like a brand word to the boundary detector but are interop.
  if (strongContract(line)) return { text: line, changed: 0 };
  let changed = 0;
  const text = line.replace(BRAND_WORD_RE_G, (m) => {
    changed++;
    if (m === m.toUpperCase()) return 'CORTEX';
    if (m[0] === m[0].toUpperCase()) return 'Cortex';
    return 'cortex';
  });
  return { text, changed };
}

// A line is a violation iff it carries a standalone brand word and is not a
// frozen strong-contract shape. (The boundary detector already excludes
// env/pkg/path/header/identifier/CSS; ALLOWLIST is the human-readable echo of
// that and is reported for context, never used to suppress a real hit.)
function violationsInFile(absPath, relPath) {
  const src = readFileSync(absPath, 'utf8');
  const lines = src.split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (hasBrandWord(line) && !strongContract(line)) {
      hits.push({ file: relPath, line: i + 1, text: line.trim(), allow: isAllowlisted(line) });
    }
  }
  return hits;
}

// ---- modes ----------------------------------------------------------------
function runLint(root, json) {
  const files = listGuardedFiles(root);
  const hits = [];
  for (const rel of files) {
    const abs = join(root, rel);
    if (!isTextFile(abs)) continue;
    hits.push(...violationsInFile(abs, rel));
  }
  if (json) { console.log(JSON.stringify({ scanned: files.length, violations: hits }, null, 2)); }
  else if (hits.length) {
    console.error(`✖ branding guard: ${hits.length} "Paperclip" brand-word violation(s) in the guarded surface:\n`);
    for (const h of hits) console.error(`  ${h.file}:${h.line}: ${h.text}`);
    console.error(`\nThese are rendered/model-echoable strings (Buckets A/B/G/H-text) — rename Paperclip→Cortex.`);
    console.error(`Frozen contracts (PAPERCLIP_*, @paperclipai/*, paths, headers, identifiers) are exempt by design.`);
    console.error(`\nAuto-fix:  node scripts/check-branding-no-paperclip.mjs --fix   (see doc/UPSTREAM_MERGE_SOP.md)`);
  } else {
    console.log(`✔ branding guard: no "Paperclip" brand text in the guarded surface (${files.length} files scanned).`);
  }
  return hits.length ? 1 : 0;
}

function runFix(root, json) {
  const files = listGuardedFiles(root);
  const changed = [];
  let total = 0;
  for (const rel of files) {
    const abs = join(root, rel);
    if (!isTextFile(abs)) continue;
    const src = readFileSync(abs, 'utf8');
    const lines = src.split('\n');
    let fileChanged = 0;
    for (let i = 0; i < lines.length; i++) {
      const { text, changed: n } = rewriteLine(lines[i]);
      if (n) { lines[i] = text; fileChanged += n; }
    }
    if (fileChanged) {
      writeFileSync(abs, lines.join('\n'));
      changed.push({ file: rel, replacements: fileChanged });
      total += fileChanged;
    }
  }
  if (json) console.log(JSON.stringify({ files: changed, replacements: total }, null, 2));
  else if (total) {
    console.log(`✔ branding codemod: rewrote ${total} brand word(s) across ${changed.length} file(s):`);
    for (const c of changed) console.log(`  ${c.file}: ${c.replacements}`);
    console.log(`\nNote: graphical-asset & filename renames (Bucket H) are handled by W6, not this codemod.`);
  } else {
    console.log(`✔ branding codemod: nothing to rewrite (guarded surface already clean).`);
  }
  return 0;
}

// Skip obvious binaries; the guarded globs are text, but H-assets (svg) are text
// too — treat anything decodable as UTF-8 without NULs as text.
function isTextFile(abs) {
  try {
    const st = statSync(abs);
    if (!st.isFile() || st.size > 8 * 1024 * 1024) return false;
    const buf = readFileSync(abs);
    return !buf.includes(0);
  } catch { return false; }
}

// ---- main -----------------------------------------------------------------
function help() {
  console.log(`check-branding-no-paperclip — merge-time branding guard (NEO-436/W3)

  node scripts/check-branding-no-paperclip.mjs [--fix] [--root DIR] [--json]

  (default)   lint the guarded globs; exit 1 on any brand-word violation
  --fix       case-preserving codemod Paperclip→Cortex over the guarded globs
  --root DIR  scan/fix a tree other than the cwd (default: repo root)
  --json      machine-readable output

Guarded globs (Buckets A+B+G+H-text):
${GUARD_GLOBS.map((g) => '  ' + g).join('\n')}`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { help(); return 0; }
  if (!opts.root || !existsSync(opts.root)) {
    console.error(`--root not found: ${opts.root}`);
    return 2;
  }
  return opts.fix ? runFix(opts.root, opts.json) : runLint(opts.root, opts.json);
}

process.exit(main());
