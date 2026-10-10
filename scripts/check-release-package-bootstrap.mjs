#!/usr/bin/env node

import { spawnSync } from "node:child_process";

import { buildReleasePackagePlan } from "./release-package-map.mjs";

function normalizePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function classifyNpmViewFailure(output) {
  return /\bE404\b|404 Not Found|could not be found/i.test(output) ? "missing" : "registry_error";
}

function inspectNpmPackage(packageName) {
  const result = spawnSync("npm", ["view", packageName, "name", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status === 0) {
    return { status: "exists" };
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const failureType = classifyNpmViewFailure(output);

  if (failureType === "missing") {
    return { status: "missing" };
  }

  return {
    status: "registry_error",
    detail: output || `npm view exited with status ${result.status ?? "unknown"}`,
  };
}

function readGitFileAtRevision(revision, filePath) {
  const result = spawnSync("git", ["show", `${revision}:${normalizePath(filePath)}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status === 0) {
    return result.stdout;
  }

  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();

  if (
    /exists on disk, but not in/i.test(output) ||
    /does not exist in/i.test(output)
  ) {
    return null;
  }

  throw new Error(`failed to read ${filePath} at ${revision}:\n${output || "git show failed"}`);
}

function getBaseReleaseState(
  revision,
  releasePackages = buildReleasePackagePlan(),
  readFileAtRevision = readGitFileAtRevision,
) {
  if (!revision) return null;

  const manifestText = readFileAtRevision(revision, "scripts/release-package-manifest.json");

  if (manifestText) {
    const manifestEntries = JSON.parse(manifestText);

    if (!Array.isArray(manifestEntries)) {
      throw new Error(`expected scripts/release-package-manifest.json at ${revision} to contain an array`);
    }

    return {
      source: "manifest",
      byDir: new Map(
        manifestEntries
          .filter((entry) => entry?.publishFromCi === true && typeof entry.dir === "string" && typeof entry.name === "string")
          .map((entry) => [entry.dir, { name: entry.name, publishFromCi: true }]),
      ),
    };
  }

  const byDir = new Map();

  for (const pkg of releasePackages) {
    const packageJsonText = readFileAtRevision(revision, `${pkg.dir}/package.json`);
    if (!packageJsonText) continue;

    const basePackage = JSON.parse(packageJsonText);
    if (basePackage.private) continue;

    byDir.set(pkg.dir, {
      name: basePackage.name,
      publishFromCi: true,
    });
  }

  return {
    source: "public-packages",
    byDir,
  };
}

function collectReleasePackagesForChangedPaths(
  changedPaths,
  releasePackages = buildReleasePackagePlan(),
  baseReleaseState = null,
) {
  const normalizedChangedPaths = changedPaths.map(normalizePath);
  const manifestFileChanged = normalizedChangedPaths.includes("scripts/release-package-manifest.json");
  const changedReleasePackages = [];
  const seen = new Set();

  for (const pkg of releasePackages) {
    if (!pkg.publishFromCi) continue;
    const packageJsonPath = `${pkg.dir}/package.json`;
    const packageJsonChanged = normalizedChangedPaths.includes(packageJsonPath);
    const basePackage = baseReleaseState?.byDir.get(pkg.dir);
    const newlyReleaseEnabled =
      manifestFileChanged &&
      (!baseReleaseState || !basePackage || basePackage.publishFromCi !== true || basePackage.name !== pkg.name);
    const isRelevant = packageJsonChanged || newlyReleaseEnabled;

    if (!isRelevant) continue;
    if (seen.has(pkg.name)) continue;

    changedReleasePackages.push(pkg);
    seen.add(pkg.name);
  }

  return changedReleasePackages;
}

function main(changedPaths) {
  const releasePackages = buildReleasePackagePlan();
  const baseReleaseState = getBaseReleaseState(process.env.PAPERCLIP_RELEASE_BOOTSTRAP_BASE_SHA, releasePackages);
  const changedReleasePackages = collectReleasePackagesForChangedPaths(changedPaths, releasePackages, baseReleaseState);

  if (changedReleasePackages.length === 0) {
    process.stdout.write("No release-enabled package manifests changed in this PR.\n");
    return;
  }

  const missingPackages = [];
  const registryFailures = [];

  for (const pkg of changedReleasePackages) {
    const npmStatus = inspectNpmPackage(pkg.name);

    if (npmStatus.status === "missing") {
      missingPackages.push(pkg);
      continue;
    }

    if (npmStatus.status === "registry_error") {
      registryFailures.push({ pkg, detail: npmStatus.detail });
    }
  }

  if (missingPackages.length > 0) {
    const details = missingPackages
      .map(
        (pkg) =>
          `${pkg.name} (${pkg.dir}) is release-enabled but does not exist on npm yet; bootstrap the first publish before merge or keep it out of CI release enrollment`,
      )
      .join("\n- ");

    throw new Error(`release package bootstrap check failed:\n- ${details}`);
  }

  if (registryFailures.length > 0) {
    const details = registryFailures
      .map(
        ({ pkg, detail }) =>
          `${pkg.name} (${pkg.dir}) could not be checked against npm due to a registry error:\n${detail}`,
      )
      .join("\n- ");

    throw new Error(`release package bootstrap check could not verify npm state:\n- ${details}`);
  }

  process.stdout.write(
    `Release bootstrap OK for changed manifests: ${changedReleasePackages.map((pkg) => pkg.name).join(", ")}\n`,
  );
}

if (process.argv[1] && normalizePath(process.argv[1]).endsWith("scripts/check-release-package-bootstrap.mjs")) {
  main(process.argv.slice(2));
}

export {
  classifyNpmViewFailure,
  collectReleasePackagesForChangedPaths,
  getBaseReleaseState,
};
