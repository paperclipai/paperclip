#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path, { dirname } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const workspacePath = path.join(repoRoot, "pnpm-workspace.yaml");
const releasePackageMapPath = path.join(repoRoot, "scripts", "release-package-map.mjs");

function parseWorkspaceEntries(workspaceText) {
  // Keep this aligned with the repo's block-sequence `packages:` format in
  // pnpm-workspace.yaml. If that file moves to a more complex YAML shape,
  // switch this parser to a real YAML parser instead of line matching.
  return workspaceText
    .split("\n")
    .map((line) => line.match(/^\s*-\s+(.+)\s*$/)?.[1]?.trim() ?? null)
    .map((entry) => {
      if (!entry) return entry;
      return entry.replace(/^(['"])(.*)\1$/, "$2");
    })
    .filter(Boolean)
    .map((entry) => ({
      pattern: entry.startsWith("!") ? entry.slice(1) : entry,
      negated: entry.startsWith("!"),
    }));
}

function globToRegExp(pattern) {
  let regex = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      regex += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      regex += "[^/]*";
      continue;
    }
    if (char === "?") {
      regex += "[^/]";
      continue;
    }
    regex += /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
  }

  return new RegExp(`^${regex}$`);
}

function isWorkspacePackage(pkgDir, workspaceEntries) {
  let included = false;

  for (const entry of workspaceEntries) {
    if (globToRegExp(entry.pattern).test(pkgDir)) {
      included = !entry.negated;
    }
  }

  return included;
}

function listPublicPackages() {
  const output = execFileSync(
    process.execPath,
    [releasePackageMapPath, "list"],
    { cwd: repoRoot, encoding: "utf8" },
  );

  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [dir, name] = line.split("\t");
      return { dir, name };
    });
}

function readPackageJson(pkgDir) {
  return JSON.parse(
    readFileSync(path.join(repoRoot, pkgDir, "package.json"), "utf8"),
  );
}

function run(command, args, cwd) {
  execFileSync(command, args, {
    cwd,
    env: {
      ...process.env,
      CI: "true",
    },
    stdio: "inherit",
  });
}

function main() {
  const workspaceEntries = parseWorkspaceEntries(readFileSync(workspacePath, "utf8"));
  const standalonePackages = listPublicPackages()
    .filter(({ dir }) => !isWorkspacePackage(dir, workspaceEntries));

  if (standalonePackages.length === 0) {
    console.log("  i No standalone public packages detected outside the pnpm workspace");
    return;
  }

  for (const pkg of standalonePackages) {
    const pkgDir = path.join(repoRoot, pkg.dir);
    const pkgJson = readPackageJson(pkg.dir);
    const nodeModulesDir = path.join(pkgDir, "node_modules");
    const packageLockfilePath = path.join(pkgDir, "pnpm-lock.yaml");

    console.log(`  Preparing standalone package ${pkg.name} (${pkg.dir})`);
    if (existsSync(nodeModulesDir)) {
      rmSync(nodeModulesDir, { force: true, recursive: true });
    }

    const installArgs = existsSync(packageLockfilePath)
      ? ["install", "--ignore-workspace", "--frozen-lockfile"]
      : [
        "install",
        "--ignore-workspace",
        "--no-lockfile",
        // Standalone packages intentionally avoid committed lockfile churn in the repo.
      ];

    run("pnpm", installArgs, pkgDir);

    if (pkgJson.scripts?.build) {
      run("pnpm", ["run", "build"], pkgDir);
    } else {
      console.log("    i No build script; skipped build");
    }
  }
}

main();
