#!/usr/bin/env node
// NEO-440 (W3) — guard unit test (plan §6 "Guard unit test").
//
// Proves the merge-time guard's fire / freeze / codemod behaviour without
// needing the app tree checked out:
//   1. LOCKSTEP  — the vendored branding-guard-spec.mjs is byte-identical to
//                  NEO-438/W1's tools/guard-spec.mjs (single source of truth),
//                  and its exported detector matches manifests/guard-spec.json.
//   2. FIRE      — plant a standalone "Paperclip" in EACH guarded glob → guard
//                  lints non-zero and names every planted file.
//   3. FREEZE    — plant frozen-contract shapes (PAPERCLIP_*, @paperclipai/*,
//                  paths, headers, identifiers, CSS, ns/conn, tests) → guard is
//                  green and the codemod leaves them untouched.
//   4. CODEMOD   — --fix rewrites the planted brand words case-preservingly and
//                  the tree then lints clean.
//
// Run: node scripts/check-branding-no-paperclip.test.mjs
// Exit 0 = all pass, 1 = failure.

import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GUARD_GLOBS,
  BRAND_WORD_RE,
  ALLOWLIST,
  hasBrandWord,
  strongContract,
} from './branding-guard-spec.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUARD = join(HERE, 'check-branding-no-paperclip.mjs');
const REPO_ROOT = join(HERE, '..', '..', '..'); // wt/<repo>
const W1_SPEC = join(HERE, '..', '..', 'tools', 'guard-spec.mjs');
const W1_JSON = join(HERE, '..', '..', 'manifests', 'guard-spec.json');

let failed = 0;
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failed++;
}

// Run the guard against a tree; returns {code, stdout, stderr}.
function runGuard(root, args = []) {
  try {
    const stdout = execFileSync('node', [GUARD, '--root', root, ...args], { encoding: 'utf8' });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status ?? 1, stdout: e.stdout?.toString() ?? '', stderr: e.stderr?.toString() ?? '' };
  }
}

// Turn a guard glob into a concrete file path under `root` (fills `*`/`**`).
function concretePath(glob) {
  return glob
    .replace(/\*\*\//g, 'x/')     // **/  -> x/
    .replace(/\*\*/g, 'x')        // **   -> x
    .replace(/\*/g, 'x');         // *    -> x
}

// -------------------------------------------------------------------------
// 1. LOCKSTEP with W1's single source of truth
// -------------------------------------------------------------------------
if (existsSync(W1_SPEC)) {
  const vendored = readFileSync(join(HERE, 'branding-guard-spec.mjs'), 'utf8');
  const w1 = readFileSync(W1_SPEC, 'utf8');
  check('lockstep: vendored spec byte-identical to W1 tools/guard-spec.mjs', vendored === w1,
    vendored === w1 ? '' : 'DRIFT — re-vendor: cp tools/guard-spec.mjs w3/scripts/branding-guard-spec.mjs');
} else {
  // In the fork the W1 tool is absent; lockstep is enforced in cortex-program CI.
  check('lockstep: W1 tool present (skipped — fork checkout)', true, 'W1 tool not in this tree');
}
if (existsSync(W1_JSON)) {
  const j = JSON.parse(readFileSync(W1_JSON, 'utf8'));
  check('lockstep: detector regex matches guard-spec.json', j.primaryDetector.regex === BRAND_WORD_RE.source);
  check('lockstep: guarded globs match guard-spec.json',
    JSON.stringify(j.guardGlobs) === JSON.stringify(GUARD_GLOBS));
}

// -------------------------------------------------------------------------
// 2. FIRE — a standalone brand word in EVERY guarded glob is caught
// -------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'w3-fire-'));
  const planted = [];
  for (const glob of GUARD_GLOBS) {
    const rel = concretePath(glob);
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    // A rendered brand line appropriate to the file kind.
    writeFileSync(abs, `# heading\nWelcome to Paperclip — get started.\n`);
    planted.push(rel);
  }
  const { code, stderr, stdout } = runGuard(root);
  check('fire: lint exits non-zero when brand text present', code === 1, `exit=${code}`);
  const out = stderr + stdout;
  for (const rel of planted) {
    check(`fire: names planted file ${rel}`, out.includes(rel));
  }
  rmSync(root, { recursive: true, force: true });
}

// -------------------------------------------------------------------------
// 3. FREEZE — frozen-contract shapes never fire, incl. allowlisted PAPERCLIP_*
//    and @paperclipai/*, and test files are excluded by path.
// -------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'w3-freeze-'));
  // Frozen shapes dropped into a guarded glob (ui/src/**):
  const frozen = [
    'const PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;',
    'import { x } from "@paperclipai/server";',
    'import type { PaperclipConfig } from "../config/schema.js";',
    'export function usePaperclipIssueRuntime() {}',
    'res.setHeader("X-Paperclip-Run-Id", id);',
    'fetch("/paperclip/issues");',
    '.paperclip-thumb { color: red }',
    'const DRAFT_KEY = "paperclip:issue-draft";',
    'const dsn = "postgres://paperclip:paperclip@127.0.0.1:5432/paperclip";',
  ];
  mkdirSync(join(root, 'ui/src'), { recursive: true });
  writeFileSync(join(root, 'ui/src/contracts.ts'), frozen.join('\n') + '\n');
  // A brand word, but inside a TEST file within a guarded glob → frozen by path.
  mkdirSync(join(root, 'ui/src/__tests__'), { recursive: true });
  writeFileSync(join(root, 'ui/src/__tests__/x.test.ts'), 'expect(title).toBe("Paperclip");\n');

  const { code } = runGuard(root);
  check('freeze: lint is green on frozen contracts + test file', code === 0, `exit=${code}`);

  // Codemod must not touch any frozen shape.
  const before = readFileSync(join(root, 'ui/src/contracts.ts'), 'utf8');
  runGuard(root, ['--fix']);
  const after = readFileSync(join(root, 'ui/src/contracts.ts'), 'utf8');
  check('freeze: codemod leaves frozen contracts byte-for-byte', before === after);
  const testAfter = readFileSync(join(root, 'ui/src/__tests__/x.test.ts'), 'utf8');
  check('freeze: codemod leaves test files untouched', testAfter.includes('Paperclip'));
  rmSync(root, { recursive: true, force: true });
}

// -------------------------------------------------------------------------
// 4. CODEMOD — case-preserving rewrite makes the tree lint clean
// -------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'w3-fix-'));
  mkdirSync(join(root, 'ui/src'), { recursive: true });
  const p = join(root, 'ui/src/app.tsx');
  // Mixed case + a frozen env on the same line as a rendered word (the boundary
  // detector must rewrite the word but not the env token).
  writeFileSync(p, [
    '<title>Paperclip</title>',
    'toast("paperclip run started");',
    'const PAPERCLIP_NAME = "Paperclip";',
  ].join('\n') + '\n');

  const fix = runGuard(root, ['--fix']);
  check('codemod: --fix exits 0', fix.code === 0, `exit=${fix.code}`);
  const out = readFileSync(p, 'utf8');
  check('codemod: Paperclip→Cortex (capitalised)', out.includes('<title>Cortex</title>'));
  check('codemod: paperclip→cortex (lower)', out.includes('toast("cortex run started");'));
  check('codemod: preserves frozen env token PAPERCLIP_NAME', out.includes('const PAPERCLIP_NAME ='));
  check('codemod: rewrites rendered word but not env on mixed line',
    out.includes('const PAPERCLIP_NAME = "Cortex";'));
  const relint = runGuard(root);
  check('codemod: tree lints clean after --fix', relint.code === 0, `exit=${relint.code}`);
  rmSync(root, { recursive: true, force: true });
}

// -------------------------------------------------------------------------
// 5. Unit-level detector sanity (mirrors W1 conformance, guards against
//    accidental edits to the vendored spec surface used by the codemod).
// -------------------------------------------------------------------------
check('detector: fires on standalone "Paperclip"', hasBrandWord('Welcome to Paperclip'));
check('detector: freezes PAPERCLIP_ env by boundary', !hasBrandWord('PAPERCLIP_API_URL'));
check('detector: freezes @paperclipai pkg by boundary', !hasBrandWord('from "@paperclipai/server"'));
check('detector: strongContract catches conn string', strongContract('postgres://paperclip:paperclip@h/db') !== null);
check('spec: ALLOWLIST is non-empty', Array.isArray(ALLOWLIST) && ALLOWLIST.length > 0);

// -------------------------------------------------------------------------
// 6. NEO-509 — frozen data-plane forms (amends conf 3b8eba31). The 25 forms the
//    line-based detector under-covered are now frozen (single-line strong
//    contracts + the multi-line S3-bucket default), while renameable prose that
//    sits right next to them (backup filename prefix, UI placeholders) STILL
//    fires. Proves the amendment is NOT a blanket weakening.
// -------------------------------------------------------------------------
{
  const root = mkdtempSync(join(tmpdir(), 'w3-neo509-'));
  mkdirSync(join(root, 'cli/src/commands'), { recursive: true });
  // Frozen forms — every one must stay green, INCLUDING the multi-line S3 default
  // whose tail is a bare "paperclip" literal (context-aware freeze).
  const frozenFile = join(root, 'cli/src/commands/frozen.ts');
  const frozen = [
    'user: "paperclip",',
    'password: "paperclip",',
    'await ensurePostgresDatabase(adminConnectionString, "paperclip");',
    'bucket: source?.storage.s3.bucket ?? "paperclip",',
    'const DEFAULT_AGENT_JWT_ISSUER = "paperclip";',
    'provider: "paperclip",',
    'if (wp.provider === "paperclip") keep();',
    '    case "paperclip":',
    'normalized.startsWith("[paperclip] skipping saved session");',
    'choice.hasPaperclipConfig ? "paperclip" : "no-paperclip-config",',
    'This product is called Cortex. Never refer to it as "Paperclip" in output.',
    // multi-line S3-bucket default — tail literal on its own line:
    '  const storageS3Bucket =',
    '    process.env.PAPERCLIP_STORAGE_S3_BUCKET ??',
    '    config?.storage?.s3?.bucket ??',
    '    "paperclip";',
  ];
  writeFileSync(frozenFile, frozen.join('\n') + '\n');
  check('neo509: lint green on all frozen data-plane forms', runGuard(root).code === 0);

  // Codemod must leave every frozen form (incl. the multi-line tail) untouched.
  const beforeFrozen = readFileSync(frozenFile, 'utf8');
  runGuard(root, ['--fix']);
  const afterFrozen = readFileSync(frozenFile, 'utf8');
  check('neo509: --fix leaves frozen forms byte-for-byte', beforeFrozen === afterFrozen);
  check('neo509: multi-line S3 default tail stays "paperclip"',
    afterFrozen.includes('    "paperclip";'));
  rmSync(frozenFile, { force: true });

  // Renameable prose sitting next to the frozen forms must still FIRE and rename.
  const proseFile = join(root, 'cli/src/commands/prose.ts');
  const prose = [
    'const filenamePrefix = opts.filenamePrefix?.trim() || "paperclip";',
    '.option("--filename-prefix <p>", "Backup filename prefix", "paperclip")',
    'placeholder: "paperclip",',
    'placeholder="paperclip"',
  ];
  writeFileSync(proseFile, prose.join('\n') + '\n');
  const proseLint = runGuard(root);
  check('neo509: prose defaults/placeholders still FIRE', proseLint.code === 1,
    `exit=${proseLint.code}`);
  check('neo509: fire names the backup filenamePrefix prose',
    (proseLint.stderr + proseLint.stdout).includes('prose.ts'));
  runGuard(root, ['--fix']);
  const proseAfter = readFileSync(proseFile, 'utf8');
  check('neo509: --fix renames prose paperclip→cortex', !proseAfter.includes('"paperclip"'));
  check('neo509: tree lints clean after prose --fix', runGuard(root).code === 0);
  rmSync(root, { recursive: true, force: true });
}

// -------------------------------------------------------------------------
// report
// -------------------------------------------------------------------------
for (const r of results) {
  console.log(`${r.ok ? 'ok  ' : 'FAIL'}  ${r.name}${r.detail ? '  — ' + r.detail : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
