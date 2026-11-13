#!/usr/bin/env node
/**
 * check-pr-release-bootstrap.mjs
 * Detects release packages that this PR adds or newly release-enables whose
 * names do not exist on npm yet, and emits an informational notice: the
 * `policy` CI job will stay red until a maintainer bootstraps the name with
 * `pnpm run release:bootstrap-package`. Contributors cannot fix that
 * themselves, so the notice says so explicitly.
 *
 * Never fails (informational only) — outputs { passed: true, informational: string[] }
 *
 * Runs under pull_request_target from base-branch context: it only parses
 * JSON and diff text fetched from the GitHub API and queries the npm registry
 * with scope-validated names. It never executes PR code.
 */
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';
import { resolveBaseRef } from './check-pr-dependencies.mjs';

const MANIFEST_PATH = 'scripts/release-package-manifest.json';

// Manifest content comes from the PR head (fork-controlled), so only names
// matching our scope are ever looked up on the registry.
const SCOPE_RE = /^@paperclipai\/[a-z0-9][a-z0-9._-]*$/;

const MAX_REGISTRY_LOOKUPS = 5;

function buildContentsPath(repo, filename, ref) {
  return `/repos/${repo}/contents/${filename}?${new URLSearchParams({ ref }).toString()}`;
}

async function fetchManifestEntries(fetchFromGitHub, token, repo, ref) {
  try {
    const res = await fetchFromGitHub(buildContentsPath(repo, MANIFEST_PATH, ref), token);
    const parsed = JSON.parse(Buffer.from(res.content, 'base64').toString());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // manifest missing or unreadable on this ref
  }
}

export async function fetchRegistryPackageExists(packageName) {
  const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, {
    method: 'HEAD',
  });
  if (res.status === 404) return false;
  if (res.ok) return true;
  throw new Error(`npm registry returned ${res.status} for ${packageName}`);
}

// Names this PR newly declares a workspace dependency on, per the diff of any
// changed package.json. If one of them is an unpublished manifest entry that
// is not publishFromCi:true, the release manifest validator rejects the PR.
export function addedWorkspaceDependencyNames(files) {
  const names = new Set();
  for (const file of files) {
    if (!file.filename.endsWith('package.json')) continue;
    if (file.filename.includes('node_modules')) continue;
    for (const line of (file.patch ?? '').split('\n')) {
      if (!line.startsWith('+')) continue;
      const match = line.match(/"(@paperclipai\/[a-z0-9][a-z0-9._-]*)"\s*:\s*"workspace:/);
      if (match) names.add(match[1]);
    }
  }
  return names;
}

function buildNotice({ name, reason }) {
  const bootstrap =
    `a **maintainer** must run \`pnpm run release:bootstrap-package -- ${name} --publish\` ` +
    'and configure npm trusted publishing (see `doc/PUBLISHING.md`)';

  if (reason === 'depended') {
    return (
      `🚀 New release package \`${name}\` is not on npm yet, and published packages in this PR ` +
      `depend on it, so the \`policy\` check will stay red: ${bootstrap}, then set its manifest ` +
      `entry to \`"publishFromCi": true\` — or drop the workspace dependency. ` +
      'No contributor action is needed for the bootstrap itself.'
    );
  }

  return (
    `🚀 New release package \`${name}\` is not on npm yet, so the \`policy\` check will stay ` +
    `red: ${bootstrap}. No contributor action is needed for this.`
  );
}

export async function checkReleaseBootstrap(files, token, repo, prNumber, baseRef, deps = {}) {
  const { fetchFromGitHub = ghFetch, registryPackageExists = fetchRegistryPackageExists } = deps;

  const manifestChanged = files.some(
    f => f.filename === MANIFEST_PATH && f.status !== 'removed'
  );
  // A PR can hit the manifest edge validator without touching the manifest:
  // adding a workspace:* dependency on an existing unpublished
  // publishFromCi:false package. Patch parsing is free, so compute the added
  // dependencies first and keep the zero-API fast path only for PRs that
  // neither touch the manifest nor add a workspace dependency.
  const dependedOn = addedWorkspaceDependencyNames(files);
  if (!manifestChanged && dependedOn.size === 0) return { passed: true, informational: [] };

  const resolvedBaseRef = await resolveBaseRef(fetchFromGitHub, token, repo, prNumber, baseRef);
  const [baseEntries, headEntries] = await Promise.all([
    fetchManifestEntries(fetchFromGitHub, token, repo, resolvedBaseRef),
    fetchManifestEntries(fetchFromGitHub, token, repo, `refs/pull/${prNumber}/head`),
  ]);

  const basePublishFromCiByName = new Map(
    baseEntries
      .filter(e => e && typeof e.name === 'string')
      .map(e => [e.name, e.publishFromCi === true])
  );

  const candidates = [];
  for (const entry of headEntries) {
    if (!entry || typeof entry.name !== 'string') continue;
    const name = entry.name;
    if (!SCOPE_RE.test(name)) continue;

    const enabled = entry.publishFromCi === true;
    const baseEnabled = basePublishFromCiByName.get(name);

    if (enabled && baseEnabled !== true) {
      // Newly release-enabled (added as true, or flipped false -> true): the
      // bootstrap gate itself will fail if the name is missing from npm.
      candidates.push({ name, reason: 'enabled' });
    } else if (!enabled && dependedOn.has(name)) {
      // Not release-enabled but this PR makes published packages depend on
      // it: the manifest edge validator will fail if it stays unpublished.
      candidates.push({ name, reason: 'depended' });
    }
  }

  const informational = [];
  for (const candidate of candidates.slice(0, MAX_REGISTRY_LOOKUPS)) {
    let exists;
    try {
      exists = await registryPackageExists(candidate.name);
    } catch {
      continue; // registry hiccup: stay quiet, the policy job is the enforcer
    }
    if (!exists) informational.push(buildNotice(candidate));
  }

  return { passed: true, informational };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.error('check-pr-release-bootstrap.mjs is a library used by run-quality-gates.mjs');
  process.exit(1);
}
