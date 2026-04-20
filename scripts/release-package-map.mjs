#!/usr/bin/env node

import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const roots = ["packages", "server", "ui", "cli"];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function discoverPublicPackages() {
  const packages = [];

  function walk(relDir) {
    const absDir = join(repoRoot, relDir);
    if (!existsSync(absDir)) return;

    const pkgPath = join(absDir, "package.json");
    if (existsSync(pkgPath)) {
      const pkg = readJson(pkgPath);
      if (!pkg.private) {
        packages.push({
          dir: relDir,
          pkgPath,
          name: pkg.name,
          version: pkg.version,
          pkg,
        });
      }
      return;
    }

    for (const entry of readdirSync(absDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".git") continue;
      walk(join(relDir, entry.name));
    }
  }

  for (const rel of roots) {
    walk(rel);
  }

  return packages;
}

function sortTopologically(packages) {
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];

  function visit(pkg) {
    if (visited.has(pkg.name)) return;
    if (visiting.has(pkg.name)) {
      throw new Error(`cycle detected in public package graph at ${pkg.name}`);
    }

    visiting.add(pkg.name);

    const dependencySections = [
      pkg.pkg.dependencies ?? {},
      pkg.pkg.optionalDependencies ?? {},
      pkg.pkg.peerDependencies ?? {},
    ];

    for (const deps of dependencySections) {
      for (const depName of Object.keys(deps)) {
        const dep = byName.get(depName);
        if (dep) visit(dep);
      }
    }

    visiting.delete(pkg.name);
    visited.add(pkg.name);
    ordered.push(pkg);
  }

  for (const pkg of [...packages].sort((a, b) => a.dir.localeCompare(b.dir))) {
    visit(pkg);
  }

  return ordered;
}

function replaceWorkspaceDeps(deps, version) {
  if (!deps) return deps;
  const next = { ...deps };

  for (const [name, value] of Object.entries(next)) {
    if (!name.startsWith("@paperclipai/")) continue;
    if (typeof value !== "string" || !value.startsWith("workspace:")) continue;
    next[name] = version;
  }

  return next;
}

function setVersion(version) {
  const packages = sortTopologically(discoverPublicPackages());

  for (const pkg of packages) {
    const nextPkg = {
      ...pkg.pkg,
      version,
      dependencies: replaceWorkspaceDeps(pkg.pkg.dependencies, version),
      optionalDependencies: replaceWorkspaceDeps(pkg.pkg.optionalDependencies, version),
      peerDependencies: replaceWorkspaceDeps(pkg.pkg.peerDependencies, version),
      devDependencies: replaceWorkspaceDeps(pkg.pkg.devDependencies, version),
    };

    writeFileSync(pkg.pkgPath, `${JSON.stringify(nextPkg, null, 2)}\n`);
  }

  const cliEntryPath = join(repoRoot, "cli/src/index.ts");
  const cliEntry = readFileSync(cliEntryPath, "utf8");
  const nextCliEntry = cliEntry.replace(
    /\.version\("([^"]+)"\)/,
    `.version("${version}")`,
  );

  if (cliEntry !== nextCliEntry) {
    writeFileSync(cliEntryPath, nextCliEntry);
    return;
  }

  if (!cliEntry.includes(".version(cliVersion)")) {
    throw new Error("failed to rewrite CLI version string in cli/src/index.ts");
  }
}

function listPackages() {
  const packages = sortTopologically(discoverPublicPackages());
  for (const pkg of packages) {
    process.stdout.write(`${pkg.dir}\t${pkg.name}\t${pkg.version}\n`);
  }
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/release-package-map.mjs list",
      "  node scripts/release-package-map.mjs set-version <version>",
      "",
    ].join("\n"),
  );
}

const [command, arg] = process.argv.slice(2);

if (command === "list") {
  listPackages();
  process.exit(0);
}

if (command === "set-version") {
  if (!arg) {
    usage();
    process.exit(1);
  }
  setVersion(arg);
  process.exit(0);
}

usage();
process.exit(1);
