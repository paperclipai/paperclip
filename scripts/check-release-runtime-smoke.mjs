#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { getReleasePackages } from "./release-package-map.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const defaultTempParent = join(repoRoot, "tmp", "release-runtime-smoke");
const dependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
];
const requiredInternalEdges = [
  { from: "paperclipai", to: "@paperclipai/server" },
  { from: "@paperclipai/server", to: "@paperclipai/shared" },
];

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function packageLabel(pkg) {
  return `${pkg.name}@${pkg.version}`;
}

function getDependencyEntries(pkg) {
  const entries = [];
  for (const field of dependencyFields) {
    const deps = pkg.pkg?.[field] ?? {};
    for (const [name, range] of Object.entries(deps)) {
      entries.push({ field, name, range });
    }
  }
  return entries;
}

function assertNoWorkspaceDependencies(pkg) {
  const problems = [];
  for (const dep of getDependencyEntries(pkg)) {
    if (typeof dep.range === "string" && dep.range.startsWith("workspace:")) {
      problems.push(
        `${packageLabel(pkg)} has ${dep.field}.${dep.name}=${dep.range}; publishable manifests must not contain workspace:* dependencies.`,
      );
    }
  }
  return problems;
}

function assertRequiredInternalDependency(pkgByName, fromName, toName) {
  const fromPkg = pkgByName.get(fromName);
  const toPkg = pkgByName.get(toName);
  const problems = [];

  if (!fromPkg) {
    problems.push(`release smoke package set is missing required package ${fromName}.`);
    return problems;
  }

  if (!toPkg) {
    problems.push(
      `${packageLabel(fromPkg)} requires ${toName}, but ${toName} is not in the tested release package set.`,
    );
    return problems;
  }

  const matchingDeps = getDependencyEntries(fromPkg).filter((dep) => dep.name === toName);
  if (matchingDeps.length === 0) {
    problems.push(
      `${packageLabel(fromPkg)} must depend on ${packageLabel(toPkg)} in dependencies, optionalDependencies, or peerDependencies.`,
    );
    return problems;
  }

  for (const dep of matchingDeps) {
    if (dep.range !== toPkg.version) {
      problems.push(
        `${packageLabel(fromPkg)} has ${dep.field}.${toName}=${dep.range}, but the tested package is ${packageLabel(toPkg)}.`,
      );
    }
  }

  return problems;
}

function collectDependencyProblems(packages) {
  const problems = [];
  const pkgByName = new Map(packages.map((pkg) => [pkg.name, pkg]));

  for (const pkg of packages) {
    problems.push(...assertNoWorkspaceDependencies(pkg));
  }

  for (const edge of requiredInternalEdges) {
    problems.push(...assertRequiredInternalDependency(pkgByName, edge.from, edge.to));
  }

  return problems;
}

function validateReleaseDependencyGraph(packages) {
  const problems = collectDependencyProblems(packages);
  if (problems.length > 0) {
    throw new Error(`release runtime smoke dependency validation failed:\n- ${problems.join("\n- ")}`);
  }
}

function run(command, args, options = {}) {
  const cwd = options.cwd ?? repoRoot;
  const label = `${command} ${args.join(" ")}`;
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: options.stdio ?? "pipe",
      env: {
        ...process.env,
        CI: "true",
        ...(options.env ?? {}),
      },
    });
  } catch (err) {
    const stdout = err?.stdout ? String(err.stdout) : "";
    const stderr = err?.stderr ? String(err.stderr) : "";
    const message = err instanceof Error ? err.message : "";
    const output = [stdout, stderr, message].filter(Boolean).join("\n").trim();
    throw new Error(
      [`${label} failed in ${cwd}.`, output ? `Output:\n${output}` : null]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

function buildReleaseArtifacts() {
  run("pnpm", ["build"], { stdio: "inherit" });
  run(process.execPath, [join(repoRoot, "scripts", "build-standalone-public-packages.mjs")], {
    stdio: "inherit",
  });
  run("bash", [join(repoRoot, "scripts", "prepare-server-ui-dist.sh")], {
    stdio: "inherit",
  });
}

function readReleasePackagesWithCurrentManifests() {
  return getReleasePackages().map((pkg) => ({
    ...pkg,
    pkg: readJson(join(repoRoot, pkg.dir, "package.json")),
  }));
}

function readPackedPackageJson(tarballPath) {
  const raw = run("tar", ["-xOf", tarballPath, "package/package.json"]);
  return JSON.parse(raw);
}

function packReleasePackages(packages, tarballDir) {
  const tarballs = [];
  for (const pkg of packages) {
    const output = run("pnpm", ["pack", "--pack-destination", tarballDir], {
      cwd: join(repoRoot, pkg.dir),
      env: { PAPERCLIP_RELEASE_REUSE_UI_DIST: "1" },
    }).trim();
    const tarballName = output.split("\n").filter(Boolean).at(-1);
    if (!tarballName) {
      throw new Error(`pnpm pack did not report a tarball for ${packageLabel(pkg)}.`);
    }
    const tarballPath = join(tarballDir, basename(tarballName));
    if (!existsSync(tarballPath)) {
      throw new Error(`pnpm pack for ${packageLabel(pkg)} reported ${tarballName}, but ${tarballPath} does not exist.`);
    }
    tarballs.push({
      pkg,
      packedPkg: readPackedPackageJson(tarballPath),
      tarballPath,
    });
  }
  return tarballs;
}

function createConsumerProject(consumerDir, tarballs) {
  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "paperclip-release-runtime-smoke-consumer",
        version: "0.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );

  run("npm", [
    "install",
    "--no-save",
    "--package-lock=false",
    "--prefer-offline",
    ...tarballs.map((entry) => entry.tarballPath),
  ], {
    cwd: consumerDir,
    stdio: "inherit",
  });
}

function importFromConsumer(consumerDir, specifier, requiredExport) {
  const importScript = join(consumerDir, ".paperclip-release-import-check.mjs");
  writeFileSync(
    importScript,
    [
      `const mod = await import(${JSON.stringify(specifier)});`,
      "const key = process.argv[2];",
      "if (key && !(key in mod)) {",
      `  console.error(key + " is missing from ${specifier}");`,
      "  process.exit(2);",
      "}",
      "",
    ].join("\n"),
  );
  run(process.execPath, [importScript, requiredExport ?? ""], {
    cwd: consumerDir,
  });
}

function runCliVersion(consumerDir) {
  const binPath = join(
    consumerDir,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "paperclipai.cmd" : "paperclipai",
  );
  run(binPath, ["--version"], { cwd: consumerDir });
}

function resolveSmokeTempParent(env = process.env) {
  return resolve(env.PAPERCLIP_RELEASE_RUNTIME_SMOKE_TMPDIR || defaultTempParent);
}

function createSmokeTempRoot(env = process.env) {
  const tempParent = resolveSmokeTempParent(env);
  mkdirSync(tempParent, { recursive: true });
  return mkdtempSync(join(tempParent, "paperclip-release-runtime-smoke-"));
}

function parseArgs(argv) {
  const args = new Set(argv);
  return {
    help: args.has("--help") || args.has("-h"),
    skipBuildArtifacts: args.has("--skip-build-artifacts"),
    keepTemp: args.has("--keep-temp"),
  };
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/check-release-runtime-smoke.mjs [--skip-build-artifacts] [--keep-temp]",
      "",
      "Runs a release-package runtime smoke test from locally packed tarballs.",
      "",
      "Environment:",
      "  PAPERCLIP_RELEASE_RUNTIME_SMOKE_TMPDIR  Parent directory for the temporary consumer install.",
      "",
    ].join("\n"),
  );
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    usage();
    return;
  }

  if (!options.skipBuildArtifacts) {
    buildReleaseArtifacts();
  }

  const packages = readReleasePackagesWithCurrentManifests();

  const tempRoot = createSmokeTempRoot();
  const tarballDir = join(tempRoot, "tarballs");
  const consumerDir = join(tempRoot, "consumer");
  mkdirSync(tarballDir, { recursive: true });
  mkdirSync(consumerDir, { recursive: true });

  try {
    const tarballs = packReleasePackages(packages, tarballDir);
    const packedPackages = tarballs.map((entry) => ({
      ...entry.pkg,
      name: entry.packedPkg.name,
      version: entry.packedPkg.version,
      pkg: entry.packedPkg,
    }));
    validateReleaseDependencyGraph(packedPackages);
    createConsumerProject(consumerDir, tarballs);
    importFromConsumer(consumerDir, "@paperclipai/shared", "API_PREFIX");
    importFromConsumer(consumerDir, "@paperclipai/server");
    runCliVersion(consumerDir);
    console.log(`release runtime smoke: OK (${packages.length} package tarballs tested)`);
  } finally {
    if (options.keepTemp) {
      console.log(`release runtime smoke temp dir: ${tempRoot}`);
    } else {
      rmSync(tempRoot, { force: true, recursive: true });
    }
  }
}

const isDirectRun = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  try {
    main();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

export {
  assertNoWorkspaceDependencies,
  assertRequiredInternalDependency,
  collectDependencyProblems,
  createSmokeTempRoot,
  getDependencyEntries,
  resolveSmokeTempParent,
  validateReleaseDependencyGraph,
};
