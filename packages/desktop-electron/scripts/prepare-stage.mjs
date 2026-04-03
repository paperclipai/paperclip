#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runNodeScript, runPnpm } from "./utils.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const packageDir = path.resolve(__dirname, "..");
const repoRoot = path.resolve(packageDir, "../..");
const stageRootDir = path.resolve(packageDir, ".stage");
const serverDeployDir = path.resolve(stageRootDir, "server-deploy");
const serverDeployNodeModulesDir = path.resolve(serverDeployDir, "node_modules");
const appRuntimeDir = path.resolve(stageRootDir, "app-runtime");
const appRuntimeServerDir = path.resolve(appRuntimeDir, "server");
const appRuntimeNodeModulesDir = path.resolve(appRuntimeDir, "node_modules");
const appRuntimeSkillsDir = path.resolve(appRuntimeDir, "skills");
const bundledSkillsDir = path.resolve(repoRoot, "skills");

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  const nextContents = `${JSON.stringify(value, null, 2)}\n`;
  const tempPath = `${filePath}.tmp`;

  rmSync(tempPath, { force: true });
  writeFileSync(tempPath, nextContents);
  rmSync(filePath, { force: true });
  renameSync(tempPath, filePath);
}

function isInsideStage(targetPath) {
  const realTarget = realpathSync(targetPath);
  const relative = path.relative(stageRootDir, realTarget);
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

function collectScopedPackageJsons(rootDir, scopeName) {
  const packageJsons = new Set();

  const topLevelScopeDir = path.resolve(rootDir, scopeName);
  if (existsSync(topLevelScopeDir)) {
    for (const entry of readdirSync(topLevelScopeDir, { withFileTypes: true })) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const candidate = path.resolve(topLevelScopeDir, entry.name, "package.json");
      if (existsSync(candidate)) {
        packageJsons.add(candidate);
      }
    }
  }

  const pnpmDir = path.resolve(rootDir, ".pnpm");
  if (!existsSync(pnpmDir)) {
    return [...packageJsons];
  }

  const stack = [pnpmDir];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const nextPath = path.resolve(current, entry.name);
      if (!entry.isDirectory()) continue;

      if (entry.name === scopeName) {
        for (const scopedEntry of readdirSync(nextPath, { withFileTypes: true })) {
          if (!scopedEntry.isDirectory()) continue;
          const candidate = path.resolve(nextPath, scopedEntry.name, "package.json");
          if (existsSync(candidate)) {
            packageJsons.add(candidate);
          }
        }
        continue;
      }

      stack.push(nextPath);
    }
  }

  return [...packageJsons];
}

function patchPublishMetadata(packageJsonPath) {
  if (!existsSync(packageJsonPath)) return false;
  if (!isInsideStage(packageJsonPath)) return false;

  const fileStat = lstatSync(packageJsonPath);
  if (fileStat.isSymbolicLink()) {
    return false;
  }

  const stat = lstatSync(path.dirname(packageJsonPath));
  if (stat.isSymbolicLink()) {
    return false;
  }

  const pkg = readJson(packageJsonPath);
  if (!pkg.name?.startsWith("@penclipai/")) return false;

  let changed = false;
  if (pkg.publishConfig?.exports) {
    pkg.exports = pkg.publishConfig.exports;
    changed = true;
  }
  if (pkg.publishConfig?.main) {
    pkg.main = pkg.publishConfig.main;
    changed = true;
  }
  if (pkg.publishConfig?.types) {
    pkg.types = pkg.publishConfig.types;
    changed = true;
  }

  if (!changed) return false;
  writeJson(packageJsonPath, pkg);
  return true;
}

console.log("[desktop-stage] Building server workspace and dependencies...");
runPnpm(["--dir", repoRoot, "--filter", "@penclipai/server...", "build"], {
  cwd: repoRoot,
});

console.log("[desktop-stage] Preparing bundled UI...");
runNodeScript(path.resolve(repoRoot, "scripts", "prepare-server-ui-dist.mjs"), [], {
  cwd: repoRoot,
});

console.log("[desktop-stage] Building Electron shell...");
runPnpm(["--dir", repoRoot, "--filter", "@penclipai/desktop-electron", "build:release"], {
  cwd: repoRoot,
});

console.log("[desktop-stage] Creating staged packaged runtime...");
rmSync(stageRootDir, { recursive: true, force: true });
mkdirSync(stageRootDir, { recursive: true });

runPnpm(
  [
    "--config.node-linker=hoisted",
    "--dir",
    repoRoot,
    "--filter",
    "@penclipai/server",
    "deploy",
    "--prod",
    serverDeployDir,
  ],
  { cwd: repoRoot },
);

const hoistedSelfRefServerPath = path.resolve(
  serverDeployNodeModulesDir,
  ".pnpm",
  "node_modules",
  "@penclipai",
  "server",
);

if (existsSync(hoistedSelfRefServerPath)) {
  rmSync(hoistedSelfRefServerPath, { recursive: true, force: true });
}

console.log("[desktop-stage] Patching deployed workspace package metadata...");
patchPublishMetadata(path.resolve(serverDeployDir, "package.json"));
const packageJsons = collectScopedPackageJsons(serverDeployNodeModulesDir, "@penclipai");
let patchedCount = 0;
for (const packageJsonPath of packageJsons) {
  if (patchPublishMetadata(packageJsonPath)) {
    patchedCount += 1;
  }
}

console.log(`[desktop-stage] Patched ${patchedCount} deployed package manifests.`);

console.log("[desktop-stage] Assembling packaged app-runtime...");
rmSync(appRuntimeDir, { recursive: true, force: true });
mkdirSync(appRuntimeServerDir, { recursive: true });

cpSync(path.resolve(serverDeployDir, "dist"), path.resolve(appRuntimeServerDir, "dist"), {
  recursive: true,
  force: true,
});
cpSync(path.resolve(serverDeployDir, "ui-dist"), path.resolve(appRuntimeServerDir, "ui-dist"), {
  recursive: true,
  force: true,
});
cpSync(path.resolve(serverDeployDir, "package.json"), path.resolve(appRuntimeServerDir, "package.json"), {
  force: true,
});
cpSync(serverDeployNodeModulesDir, appRuntimeNodeModulesDir, {
  recursive: true,
  force: true,
});
cpSync(bundledSkillsDir, appRuntimeSkillsDir, {
  recursive: true,
  force: true,
});

console.log("[desktop-stage] Packaged runtime ready in .stage/app-runtime.");
