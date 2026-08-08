#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

function main() {
  const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
  const pluginsRoot = join(repoRoot, "packages", "plugins");

  for (const packageRoot of findPluginPackageRoots(pluginsRoot)) {
    const packageJsonPath = join(packageRoot, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    if (!packageJson.paperclipPlugin) continue;

    const packageDir = relative(repoRoot, packageRoot);
    console.log(`Building ${packageJson.name ?? packageDir}`);

    if (packageDir.startsWith("packages/plugins/sandbox-providers/")) {
      run("npm", ["install", "--no-audit", "--no-fund", "--package-lock=false"], packageRoot);
      run("npm", ["run", "build"], packageRoot);
      continue;
    }

    run("pnpm", ["--filter", packageJson.name, "build"], repoRoot);
  }
}

export function findPluginPackageRoots(root) {
  const packageRoots = [];

  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "examples") continue;

    const child = join(root, entry.name);
    if (existsSync(join(child, "package.json"))) {
      packageRoots.push(child);
    }

    if (entry.name === "sandbox-providers") {
      for (const provider of readdirSync(child, { withFileTypes: true })) {
        if (!provider.isDirectory()) continue;
        const providerRoot = join(child, provider.name);
        if (existsSync(join(providerRoot, "package.json"))) {
          packageRoots.push(providerRoot);
        }
      }
    }
  }

  return packageRoots;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });

  if (result.error) {
    console.error(`Failed to spawn ${command}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
