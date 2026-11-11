// The public packages the public-install verifier stages: `@paperclipai/server`
// and `paperclipai` plus every public workspace package they reach through
// `workspace:` specs, in the depth-first order the verifier packs them. The
// npm cache warm-up reads the same closure from source manifests before
// `pnpm build` has produced anything, so both share this one definition.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PUBLIC_INSTALL_ROOTS = ['@paperclipai/server', 'paperclipai'];

// Returns `{ packages, needed }`: `packages` maps every public workspace
// package name to `{ dir, manifest }`, and `needed` is the closure in visit
// order.
export function publicInstallClosure(repo, roots = PUBLIC_INSTALL_ROOTS) {
  const listing = execFileSync(process.execPath, [join(repo, 'scripts/release-package-map.mjs'), 'list'], { cwd: repo, stdio: 'pipe' })
    .toString().trim().split('\n').map(line => line.split('\t'));
  const packages = new Map(listing.map(([dir, name]) => [name, { dir, manifest: JSON.parse(readFileSync(join(repo, dir, 'package.json'), 'utf8')) }]));
  const needed = new Set();
  function visit(name) {
    if (needed.has(name)) return;
    const entry = packages.get(name); assert.ok(entry, `Missing public workspace dependency ${name}`); needed.add(name);
    for (const [dep, spec] of Object.entries({ ...entry.manifest.dependencies, ...entry.manifest.optionalDependencies })) {
      if (spec.startsWith('workspace:')) visit(dep);
    }
  }
  for (const root of roots) visit(root);
  return { packages, needed };
}

// The registry dependencies the closure's packages declare, as one consumer
// manifest. A name two packages declare with different specs keeps the first
// spec: the warm-up only fills a cache, and the real install fetches whatever
// it still lacks.
export function publicRegistryDependencies({ packages, needed }) {
  const dependencies = {};
  const optionalDependencies = {};
  for (const name of needed) {
    const { manifest } = packages.get(name);
    for (const [section, target] of [['dependencies', dependencies], ['optionalDependencies', optionalDependencies]]) {
      for (const [dep, spec] of Object.entries(manifest[section] ?? {})) {
        if (needed.has(dep) || /^(workspace|file|link):/.test(spec) || dep in dependencies || dep in optionalDependencies) continue;
        target[dep] = spec;
      }
    }
  }
  return { dependencies, optionalDependencies };
}
