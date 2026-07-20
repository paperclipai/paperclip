#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = process.cwd();
const args = new Set(process.argv.slice(2));
const allowedArgs = new Set(["--runtime-assets-only"]);

for (const arg of args) {
  if (!allowedArgs.has(arg)) {
    fail(`Unknown argument: ${arg}`);
  }
}

function fail(message) {
  console.error(`[typecheck:build-gaps] ${message}`);
  process.exit(1);
}

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`[typecheck:build-gaps] Failed to spawn ${command}: ${result.error.message}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function formatPath(filePath) {
  return path.relative(repoRoot, filePath).split(path.sep).join("/");
}

function listFilesRecursive(rootDir) {
  if (!existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const entries = readdirSync(rootDir, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name),
  );

  for (const entry of entries) {
    const entryPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFilesRecursive(entryPath));
      continue;
    }

    if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

function isRuntimeAsset(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return !new Set([".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]).has(ext);
}

function checkServerRuntimeAssets() {
  const runtimeAssetTrees = [
    {
      sourceDir: path.join(repoRoot, "server", "src", "built-ins"),
      distDir: path.join(repoRoot, "server", "dist", "built-ins"),
    },
    {
      sourceDir: path.join(repoRoot, "server", "src", "onboarding-assets"),
      distDir: path.join(repoRoot, "server", "dist", "onboarding-assets"),
    },
  ];
  const missingAssets = [];
  let checkedCount = 0;

  for (const assetTree of runtimeAssetTrees) {
    const sourceAssets = listFilesRecursive(assetTree.sourceDir).filter(isRuntimeAsset);
    checkedCount += sourceAssets.length;

    for (const sourcePath of sourceAssets) {
      const relativeAssetPath = path.relative(assetTree.sourceDir, sourcePath);
      const distPath = path.join(assetTree.distDir, relativeAssetPath);

      if (!existsSync(distPath) || !statSync(distPath).isFile()) {
        missingAssets.push({ sourcePath, distPath });
      }
    }
  }

  if (missingAssets.length > 0) {
    const missingList = missingAssets
      .map(
        ({ sourcePath, distPath }) =>
          `  - source: ${formatPath(sourcePath)}\n    expected dist: ${formatPath(distPath)}`,
      )
      .join("\n");

    fail(
      `Missing server runtime asset(s) in dist:\n${missingList}\nRun pnpm --filter @paperclipai/server build and ensure source runtime asset trees are copied into dist.`,
    );
  }

  console.log(
    `[typecheck:build-gaps] server runtime assets present in dist: ${checkedCount} file(s)`,
  );
}

if (args.has("--runtime-assets-only")) {
  checkServerRuntimeAssets();
  process.exit(0);
}

function listWorkspacePackages() {
  const result = spawnSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  if (result.error) {
    fail(`Unable to spawn pnpm to list workspace packages: ${result.error.message}`);
  }

  if (result.status !== 0) {
    fail("Unable to list pnpm workspace packages.");
  }

  return JSON.parse(result.stdout);
}

function buildSkipsTypeScript(pkg) {
  const buildScript = pkg.scripts?.build;
  if (typeof buildScript !== "string") {
    return false;
  }

  return !/\btsc\b/.test(buildScript);
}

const workspacePackages = listWorkspacePackages();
const buildGapCandidates = workspacePackages
  .filter((workspacePkg) => workspacePkg.path !== repoRoot)
  .map((workspacePkg) => ({
    name: workspacePkg.name,
    path: workspacePkg.path,
    pkg: readJson(path.join(workspacePkg.path, "package.json")),
  }))
  .filter(({ pkg }) => buildSkipsTypeScript(pkg));
const packagesMissingTypecheck = buildGapCandidates.filter(
  ({ pkg }) => typeof pkg.scripts?.typecheck !== "string",
);
if (packagesMissingTypecheck.length > 0) {
  const missingNames = packagesMissingTypecheck.map((workspacePkg) => workspacePkg.name).join(", ");
  fail(
    `Workspace packages with build scripts that skip tsc must define a typecheck script. Missing: ${missingNames}`,
  );
}
const buildGapPackages = buildGapCandidates.filter(
  ({ pkg }) => typeof pkg.scripts?.typecheck === "string",
);

console.log(
  `[typecheck:build-gaps] typechecking ${buildGapPackages.length} workspace(s): ${buildGapPackages.map(({ name }) => name).join(", ") || "(none)"}`,
);

if (buildGapPackages.length > 0) {
  run("pnpm", ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"]);

  for (const workspacePkg of buildGapPackages) {
    run("pnpm", ["--filter", workspacePkg.name, "typecheck"]);
  }
}

checkServerRuntimeAssets();
