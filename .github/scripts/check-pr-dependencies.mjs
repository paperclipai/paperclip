#!/usr/bin/env node
/**
 * check-pr-dependencies.mjs
 * Detects new npm packages added in this PR vs. the base branch.
 * Never fails (informational only) — outputs { passed: true, informational: string[] }
 */
import { fileURLToPath } from 'node:url';
import { ghFetch } from './get-bot-token.mjs';

function buildContentsPath(repo, filename, ref) {
  return `/repos/${repo}/contents/${filename}?${new URLSearchParams({ ref }).toString()}`;
}

export async function resolveBaseRef(fetchFromGitHub, token, repo, prNumber, baseRef) {
  if (baseRef) {
    return baseRef;
  }

  const pr = await fetchFromGitHub(`/repos/${repo}/pulls/${prNumber}`, token);
  if (pr.base?.ref) {
    return pr.base.ref;
  }

  const repository = await fetchFromGitHub(`/repos/${repo}`, token);
  if (repository.default_branch) {
    return repository.default_branch;
  }

  throw new Error(`Unable to resolve a base branch for ${repo}#${prNumber}.`);
}

export async function checkDependencies(files, token, repo, prNumber, baseRef, fetchFromGitHub = ghFetch) {
  const pkgFiles = files.filter(
    f => f.filename.endsWith('package.json') &&
         !f.filename.includes('node_modules') &&
         f.status !== 'removed'
  );

  if (pkgFiles.length === 0) return { passed: true, informational: [] };

  const resolvedBaseRef = await resolveBaseRef(fetchFromGitHub, token, repo, prNumber, baseRef);
  const newPackages = new Set();

  for (const file of pkgFiles) {
    try {
      const [baseRes, prRes] = await Promise.all([
        fetchFromGitHub(buildContentsPath(repo, file.filename, resolvedBaseRef), token),
        fetchFromGitHub(buildContentsPath(repo, file.filename, `refs/pull/${prNumber}/head`), token),
      ]);

      const basePkg = JSON.parse(Buffer.from(baseRes.content, 'base64').toString());
      const prPkg = JSON.parse(Buffer.from(prRes.content, 'base64').toString());

      const baseDeps = new Set([
        ...Object.keys(basePkg.dependencies ?? {}),
        ...Object.keys(basePkg.devDependencies ?? {}),
        ...Object.keys(basePkg.peerDependencies ?? {}),
      ]);

      for (const dep of [
        ...Object.keys(prPkg.dependencies ?? {}),
        ...Object.keys(prPkg.devDependencies ?? {}),
        ...Object.keys(prPkg.peerDependencies ?? {}),
      ]) {
        if (!baseDeps.has(dep)) newPackages.add(dep);
      }
    } catch {
      // File may not exist on base — skip
    }
  }

  if (newPackages.size === 0) return { passed: true, informational: [] };

  const pkgList = [...newPackages].map(p => `\`${p}\``).join(', ');
  return {
    passed: true,
    informational: [
      `📦 New dependencies added: ${pkgList}. Review may take longer and new dependencies ` +
      `are less likely to be accepted — please check if existing deps cover this need.`,
    ],
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { GH_TOKEN, GH_REPO, PR_NUMBER, PR_FILES, PR_BASE_REF } = process.env;
  const files = JSON.parse(PR_FILES ?? '[]');
  const result = await checkDependencies(files, GH_TOKEN, GH_REPO, PR_NUMBER, PR_BASE_REF);
  console.log(JSON.stringify(result));
}
