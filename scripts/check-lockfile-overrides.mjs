#!/usr/bin/env node

/**
 * check-lockfile-overrides.mjs
 *
 * Guards the one part of `pnpm-lock.yaml` that the PR pipeline never measures:
 * the committed lockfile itself.
 *
 * `pr.yml` regenerates the lockfile whenever a PR touches a manifest and hands
 * the regenerated copy to every downstream job as the `pr-lockfile` artifact.
 * That is deliberate — contributors are not allowed to commit the lockfile — but
 * it means the manifest-changing PRs (exactly the ones that can break dependency
 * resolution) run `pnpm install --frozen-lockfile` against a *repaired* lockfile
 * that is thrown away afterwards. A committed lockfile whose `overrides:` block
 * contradicts the root manifest therefore merges green and only detonates in the
 * next, unrelated PR.
 *
 * This check compares the `overrides:` mapping of the committed lockfile against
 * the effective `pnpm.overrides` of the root manifest, before any regeneration
 * happens. It deliberately carries no `dependabot[bot]` exception — the
 * `Block manual lockfile edits` step above it does, and dependabot was the
 * trigger the one time this hole was hit.
 *
 * The check is scoped to mismatches *this PR introduces*: a mismatch that
 * already exists identically on the base commit is reported but not failed, so a
 * broken base branch does not blame unrelated PRs. Set `BASE_SHA` to enable that
 * scoping; without it the check compares the working tree strictly, which is the
 * useful behaviour for a local run.
 *
 * Exports: parseYamlScalarBlock, readManifestOverrides, changedKeys,
 *          checkLockfileOverrides, runCheck
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const LOCKFILE = "pnpm-lock.yaml";
const MANIFEST = "package.json";
const WORKSPACE = "pnpm-workspace.yaml";

/**
 * Unwraps a YAML scalar. pnpm writes override keys and values verbatim, quoting
 * only when YAML forces it (`'>=4.59.0'`, `'@lexical/react'`), so unquoting is
 * all that is needed to compare against the JSON manifest.
 */
function unquoteYamlScalar(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\(["\\])/g, "$1");
  }
  return value;
}

/** Splits `key: value`, honouring a quoted key that may itself contain a colon. */
function splitEntry(trimmed) {
  const quote = trimmed[0];
  if (quote === "'" || quote === '"') {
    let i = 1;
    for (; i < trimmed.length; i++) {
      if (quote === '"' && trimmed[i] === "\\") {
        i++;
        continue;
      }
      if (trimmed[i] === quote) {
        if (quote === "'" && trimmed[i + 1] === "'") {
          i++;
          continue;
        }
        break;
      }
    }
    if (i >= trimmed.length) return null;
    const rest = trimmed.slice(i + 1).trimStart();
    if (!rest.startsWith(":")) return null;
    return { key: unquoteYamlScalar(trimmed.slice(0, i + 1)), value: rest.slice(1) };
  }

  const idx = trimmed.indexOf(":");
  if (idx === -1) return null;
  return { key: trimmed.slice(0, idx).trim(), value: trimmed.slice(idx + 1) };
}

/**
 * Reads a top-level block of flat `key: value` scalars (`overrides:`) out of a
 * YAML document. Returns null when the block is absent, so "no block" stays
 * distinguishable from "empty block".
 *
 * Throws on any shape it cannot represent faithfully — a guard that silently
 * mis-parses is the very failure mode this file exists to close.
 */
export function parseYamlScalarBlock(text, blockName) {
  const lines = text.split("\n");
  const header = `${blockName}:`;

  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trimEnd() === header) {
      start = i + 1;
      break;
    }
  }
  if (start === -1) return null;

  const entries = {};
  let baseIndent = null;

  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === "") continue;

    const indent = line.length - line.trimStart().length;
    if (indent === 0) break;

    const trimmed = line.trim();
    if (trimmed.startsWith("#")) continue;

    if (baseIndent === null) baseIndent = indent;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      throw new Error(
        `${LOCKFILE}: unsupported nested value under \`${blockName}:\` at line ${i + 1}: ${trimmed}`,
      );
    }

    const entry = splitEntry(trimmed);
    if (!entry || entry.value.trim() === "") {
      throw new Error(
        `${LOCKFILE}: unsupported entry under \`${blockName}:\` at line ${i + 1}: ${trimmed}`,
      );
    }
    entries[entry.key] = unquoteYamlScalar(entry.value);
  }

  return entries;
}

/**
 * The effective override map of the workspace root. pnpm 9 reads
 * `pnpm.overrides` from package.json; pnpm 10 moved the field to
 * pnpm-workspace.yaml. Both are honoured, workspace-level last, so this check
 * does not silently go blind the day the repo migrates.
 */
export function readManifestOverrides({ packageJsonText, workspaceYamlText }) {
  const fromManifest = JSON.parse(packageJsonText)?.pnpm?.overrides ?? null;
  const fromWorkspace =
    workspaceYamlText == null ? null : parseYamlScalarBlock(workspaceYamlText, "overrides");

  const merged = {};
  for (const [key, value] of Object.entries(fromManifest ?? {})) merged[key] = String(value);
  for (const [key, value] of Object.entries(fromWorkspace ?? {})) merged[key] = String(value);
  return merged;
}

/** Override keys whose value differs between two maps (added and removed included). */
export function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].filter(key => before[key] !== after[key]);
}

/**
 * Compares the committed lockfile's overrides against the root manifest's.
 *
 * A key is exempt when either
 *  - the identical mismatch already exists on the base commit (pre-existing
 *    breakage is reported, not blamed on this PR), or
 *  - this PR changed the key in the manifest while leaving the lockfile's entry
 *    for it untouched — the legitimate shape of an override change, since
 *    contributors must not commit the lockfile and CI regenerates it.
 */
export function checkLockfileOverrides({
  lockOverrides,
  manifestOverrides,
  baseLockOverrides = null,
  baseManifestOverrides = null,
}) {
  const hasBase = baseLockOverrides !== null && baseManifestOverrides !== null;
  const manifestTouched = hasBase ? new Set(changedKeys(baseManifestOverrides, manifestOverrides)) : new Set();
  const lockTouched = hasBase ? new Set(changedKeys(baseLockOverrides, lockOverrides)) : new Set();

  const keys = [...new Set([...Object.keys(lockOverrides), ...Object.keys(manifestOverrides)])].sort();
  const problems = [];
  const preExisting = [];

  for (const key of keys) {
    const inLock = Object.hasOwn(lockOverrides, key);
    const inManifest = Object.hasOwn(manifestOverrides, key);
    if (inLock && inManifest && lockOverrides[key] === manifestOverrides[key]) continue;

    const problem = {
      key,
      lock: inLock ? lockOverrides[key] : null,
      manifest: inManifest ? manifestOverrides[key] : null,
    };

    // A manifest-only override change with an untouched lockfile entry is the
    // sanctioned flow: CI owns the lockfile and regenerates it after merge.
    if (manifestTouched.has(key) && !lockTouched.has(key)) continue;

    // Unchanged on both sides and already broken at the base — not this PR's doing.
    if (
      hasBase &&
      baseLockOverrides[key] === problem.lock &&
      baseManifestOverrides[key] === problem.manifest
    ) {
      preExisting.push(problem);
      continue;
    }

    problems.push(problem);
  }

  return { passed: problems.length === 0, problems, preExisting };
}

function describe(problem) {
  const { key, lock, manifest } = problem;
  if (lock === null) return `  ${key}: missing from ${LOCKFILE}, manifest pins ${manifest}`;
  if (manifest === null) return `  ${key}: ${LOCKFILE} pins ${lock}, manifest declares no override`;
  return `  ${key}: ${LOCKFILE} pins ${lock}, manifest pins ${manifest}`;
}

function readBaseFile(repoRoot, baseSha, file) {
  return execFileSync("git", ["show", `${baseSha}:${file}`], {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function runCheck({ repoRoot, baseSha = null, log = console.log, error = console.error }) {
  const lockfilePath = path.join(repoRoot, LOCKFILE);
  if (!existsSync(lockfilePath)) {
    error(`ERROR: ${LOCKFILE} not found at repository root.`);
    return 1;
  }

  const workspacePath = path.join(repoRoot, WORKSPACE);
  const lockOverrides = parseYamlScalarBlock(readFileSync(lockfilePath, "utf8"), "overrides") ?? {};
  const manifestOverrides = readManifestOverrides({
    packageJsonText: readFileSync(path.join(repoRoot, MANIFEST), "utf8"),
    workspaceYamlText: existsSync(workspacePath) ? readFileSync(workspacePath, "utf8") : null,
  });

  let baseLockOverrides = null;
  let baseManifestOverrides = null;
  if (baseSha) {
    // fetch-depth: 0 is set on the policy job, so a missing base object means a
    // broken assumption rather than a shallow clone. Fail loudly instead of
    // quietly downgrading to a comparison that cannot exempt anything.
    try {
      baseLockOverrides = parseYamlScalarBlock(readBaseFile(repoRoot, baseSha, LOCKFILE), "overrides") ?? {};
      baseManifestOverrides = readManifestOverrides({
        packageJsonText: readBaseFile(repoRoot, baseSha, MANIFEST),
        workspaceYamlText: (() => {
          try {
            return readBaseFile(repoRoot, baseSha, WORKSPACE);
          } catch {
            return null;
          }
        })(),
      });
    } catch (e) {
      error(`ERROR: could not read ${LOCKFILE}/${MANIFEST} at base commit ${baseSha}: ${e.message}`);
      return 1;
    }
  }

  const { passed, problems, preExisting } = checkLockfileOverrides({
    lockOverrides,
    manifestOverrides,
    baseLockOverrides,
    baseManifestOverrides,
  });

  if (preExisting.length > 0) {
    log(`  !  ${preExisting.length} pre-existing override mismatch(es) on the base commit (not failed here):`);
    for (const problem of preExisting) log(describe(problem));
  }

  if (!passed) {
    error(`ERROR: the committed ${LOCKFILE} contradicts the root manifest's \`pnpm.overrides\`:\n`);
    for (const problem of problems) error(describe(problem));
    error(
      `\nDownstream jobs install from a lockfile that ${
        baseSha ? "this PR regenerates and then discards" : "CI regenerates and then discards"
      }, so this mismatch would merge green and break the next unrelated PR at ` +
        "`pnpm install --frozen-lockfile`.",
    );
    error(
      `\nTo fix: run \`pnpm install --lockfile-only\` and align the root ${MANIFEST} \`pnpm.overrides\` ` +
        `with the versions the lockfile resolves — the two must agree in the same commit.`,
    );
    return 1;
  }

  const count = Object.keys(manifestOverrides).length;
  log(
    preExisting.length > 0
      ? `  ✓  This PR introduces no override mismatch (${count} checked; see the pre-existing one above).`
      : `  ✓  Committed ${LOCKFILE} overrides match the root manifest (${count} checked).`,
  );
  return 0;
}

function isMainModule() {
  return process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  process.exit(runCheck({ repoRoot: process.cwd(), baseSha: process.env.BASE_SHA || null }));
}
