#!/usr/bin/env node
/**
 * publish-penstock-scope.mjs — republish the fork's plugin SDK packages under the
 * Blockcast-owned `@penstock/*` scope to public npm.
 *
 * WHY THIS EXISTS
 * ---------------
 * `Blockcast/paperclip` is a fork of `paperclipai/paperclip`. The fork cannot
 * publish under the `@paperclipai/*` scope (upstream owns it), and the upstream
 * release jobs are guarded `github.repository == 'paperclipai/paperclip'` so they
 * skip here. To get the fork's SDK surface (e.g. `agents.updateAdapterOverrides`,
 * the `agents.adapter.write` capability) to a consumer like
 * `@penstock/paperclip-plugin`, we republish the two SDK packages under the
 * `@penstock/*` scope — which Blockcast DOES control and already publishes to
 * public npm via OIDC trusted publishing. The consumer pins them via a pnpm alias
 * (`"@paperclipai/plugin-sdk": "npm:@penstock/plugin-sdk@<ver>"`) so its import
 * paths stay `@paperclipai/...` unchanged.
 *
 * WHY A SELF-CONTAINED MANIFEST REWRITE (not `pnpm publish`)
 * ---------------------------------------------------------
 * npm's OIDC trusted publishing is an npm-CLI feature, so the actual publish must
 * be `npm publish`. But `npm publish` does NOT (a) replace pnpm `workspace:*`
 * specs, nor (b) apply `publishConfig.{exports,main,types}` overrides — both of
 * which these packages rely on. So this script does that rewrite itself, in place,
 * then restores the pristine manifest in a finally block. The result is a
 * fully-resolved manifest npm can publish verbatim.
 *
 * SAFETY
 * ------
 * Dry-run by default (`npm publish --dry-run`). Pass `--publish` to actually
 * publish; `--provenance` is added only in CI (OIDC). The workflow that calls this
 * is `workflow_dispatch`-only, so nothing publishes on push.
 *
 * Usage:
 *   node scripts/publish-penstock-scope.mjs --version 2026.614.0            # dry-run (default)
 *   node scripts/publish-penstock-scope.mjs --version 2026.614.0 --bootstrap # one-time local 2FA first-publish
 *   node scripts/publish-penstock-scope.mjs --version 2026.614.0 --publish --provenance  # CI/OIDC (the workflow)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const args = process.argv.slice(2);
const getArg = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const version = getArg("--version");
// --bootstrap: the one-time FIRST publish of each brand-new @penstock/* package,
// run locally by a maintainer with `npm login` + 2FA. npm can't OIDC-publish a
// package that doesn't exist yet, so the first version is published by hand; every
// release after that goes through the OIDC workflow. Bootstrap = publish WITHOUT
// provenance (provenance attestation requires the CI OIDC runner).
const bootstrap = args.includes("--bootstrap");
const doPublish = args.includes("--publish") || bootstrap;
const provenance = args.includes("--provenance") && !bootstrap;

// Mirror upstream's YYYY.<M><DD>.N scheme (no leading zero on month, e.g. 2026.614.0).
if (!version || !/^\d{4}\.\d{3,4}\.\d+$/.test(version)) {
  console.error("Error: --version must be YYYY.MMDD.N (e.g. 2026.614.0)");
  process.exit(1);
}

// @paperclipai/* -> @penstock/* rename map (also used to rewrite internal deps).
const RENAME = {
  "@paperclipai/plugin-sdk": "@penstock/plugin-sdk",
  "@paperclipai/shared": "@penstock/shared",
};

// Publish order matters for human legibility: shared first (plugin-sdk depends on it).
const PACKAGES = ["packages/shared", "packages/plugins/sdk"];

// Manifest fields that `publishConfig` may override at publish time. npm only
// honors registry/access/tag from publishConfig, so we flatten the rest ourselves.
const PUBLISH_CONFIG_MANIFEST_FIELDS = ["exports", "main", "types", "module", "browser", "bin"];

function rewriteDeps(deps) {
  if (!deps || typeof deps !== "object") return deps;
  const out = {};
  for (const [name, spec] of Object.entries(deps)) {
    // Renamed internal deps are pinned to THIS republish version (discarding the
    // original `workspace:*`/range spec, since the renamed pkg only exists at this version).
    if (RENAME[name]) out[RENAME[name]] = version;
    else out[name] = spec;
  }
  return out;
}

function buildPublishManifest(pkg) {
  const toName = RENAME[pkg.name];
  if (!toName) {
    console.error(`Error: unexpected package name "${pkg.name}" — not in rename map`);
    process.exit(1);
  }
  const next = {
    ...pkg,
    name: toName,
    version,
    dependencies: rewriteDeps(pkg.dependencies),
    peerDependencies: rewriteDeps(pkg.peerDependencies),
    optionalDependencies: rewriteDeps(pkg.optionalDependencies),
  };
  delete next.private;

  // Flatten publishConfig manifest overrides into the top level (npm won't apply them).
  const pc = pkg.publishConfig ?? {};
  for (const field of PUBLISH_CONFIG_MANIFEST_FIELDS) {
    if (pc[field] !== undefined) next[field] = pc[field];
  }
  next.publishConfig = { access: "public" };
  return next;
}

if (bootstrap) {
  console.log(
    "Bootstrap mode: local 2FA publish, no provenance. " +
      "Ensure `npm whoami` is an owner of the @penstock scope and 2FA is ready.",
  );
}

let failed = false;
for (const dir of PACKAGES) {
  const pjPath = resolve(dir, "package.json");
  const original = readFileSync(pjPath, "utf8");
  const pkg = JSON.parse(original);
  const next = buildPublishManifest(pkg);
  const publishArgs = ["publish", "--access", "public"];
  if (provenance) publishArgs.push("--provenance");
  if (!doPublish) publishArgs.push("--dry-run");
  try {
    writeFileSync(pjPath, JSON.stringify(next, null, 2) + "\n");
    console.log(`\n[${doPublish ? "PUBLISH" : "DRY-RUN"}] ${pkg.name} -> ${next.name}@${version}  (from ${dir})`);
    execFileSync("npm", publishArgs, { cwd: dir, stdio: "inherit" });
  } catch (err) {
    failed = true;
    console.error(`Failed to publish ${next.name}: ${err.message}`);
  } finally {
    writeFileSync(pjPath, original); // always restore the pristine workspace manifest
  }
  if (failed) break;
}

if (failed) process.exit(1);
console.log(`\nDone (${doPublish ? "published" : "dry-run"}): @penstock/shared@${version}, @penstock/plugin-sdk@${version}`);
