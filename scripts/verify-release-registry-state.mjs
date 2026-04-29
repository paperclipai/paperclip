#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const CANARY_VERSION_RE = /-canary\.\d+$/;

export function isCanaryVersion(version) {
  return CANARY_VERSION_RE.test(version);
}

function usage() {
  process.stderr.write(
    [
      "Usage:",
      "  node scripts/verify-release-registry-state.mjs --channel <canary|stable> --dist-tag <tag> --target-version <version> --package <name> [--package <name> ...] [--allow-canary-latest]",
      "",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = {
    channel: "",
    distTag: "",
    targetVersion: "",
    allowCanaryLatest: false,
    packages: [],
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    switch (arg) {
      case "--channel":
        options.channel = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--dist-tag":
        options.distTag = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--target-version":
        options.targetVersion = argv[index + 1] ?? "";
        index += 1;
        break;
      case "--package":
        options.packages.push(argv[index + 1] ?? "");
        index += 1;
        break;
      case "--allow-canary-latest":
        options.allowCanaryLatest = true;
        break;
      case "-h":
      case "--help":
        usage();
        process.exit(0);
      default:
        throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (options.channel !== "canary" && options.channel !== "stable") {
    throw new Error("--channel must be canary or stable");
  }

  if (!options.distTag) {
    throw new Error("--dist-tag is required");
  }

  if (!options.targetVersion) {
    throw new Error("--target-version is required");
  }

  if (options.packages.length === 0 || options.packages.some((name) => !name)) {
    throw new Error("at least one non-empty --package value is required");
  }

  if (options.allowCanaryLatest && options.channel !== "canary") {
    throw new Error("--allow-canary-latest only applies to canary releases");
  }

  return options;
}

function createRegistryUrl(packageName) {
  const registry = process.env.npm_config_registry ?? process.env.NPM_CONFIG_REGISTRY ?? "https://registry.npmjs.org/";
  return new URL(encodeURIComponent(packageName), registry.endsWith("/") ? registry : `${registry}/`);
}

async function fetchPackageDocument(packageName, { allowMissing = false } = {}) {
  const url = createRegistryUrl(packageName);
  const response = await fetch(url, {
    headers: {
      accept: "application/vnd.npm.install-v1+json, application/json;q=0.9",
    },
  });

  if (response.status === 404 && allowMissing) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`npm registry request failed for ${packageName}: ${response.status} ${response.statusText}`);
  }

  return response.json();
}

export function collectInternalDependencyProblems(manifest, packageDocsByName) {
  const problems = [];
  const sections = [
    ["dependencies", manifest.dependencies ?? {}],
    ["optionalDependencies", manifest.optionalDependencies ?? {}],
    ["peerDependencies", manifest.peerDependencies ?? {}],
  ];

  for (const [sectionName, deps] of sections) {
    for (const [dependencyName, dependencyVersion] of Object.entries(deps)) {
      if (!dependencyName.startsWith("@paperclipai/")) {
        continue;
      }

      if (typeof dependencyVersion !== "string" || !dependencyVersion) {
        problems.push(
          `${sectionName} declares ${dependencyName} with a non-string version: ${JSON.stringify(dependencyVersion)}`,
        );
        continue;
      }

      const dependencyDoc = packageDocsByName.get(dependencyName);
      if (!dependencyDoc) {
        problems.push(`${sectionName} requires ${dependencyName}@${dependencyVersion}, but that package is not published`);
        continue;
      }

      if (!(dependencyVersion in (dependencyDoc.versions ?? {}))) {
        problems.push(
          `${sectionName} requires ${dependencyName}@${dependencyVersion}, but npm does not expose that version`,
        );
      }
    }
  }

  return problems;
}

function requireManifest(packageName, version, packageDoc, problems) {
  const manifest = packageDoc.versions?.[version];
  if (!manifest) {
    if (problems) {
      problems.push(`${packageName}: npm registry is missing manifest data for ${version}`);
    }
    return null;
  }
  return manifest;
}

export function verifyPackageRegistryState({
  packageName,
  packageDoc,
  packageDocsByName,
  channel,
  distTag,
  targetVersion,
  allowCanaryLatest,
}) {
  const problems = [];
  const distTags = packageDoc["dist-tags"] ?? {};
  const taggedVersion = distTags[distTag];

  if (taggedVersion !== targetVersion) {
    problems.push(
      `${packageName}: dist-tag ${distTag} resolves to ${taggedVersion ?? "<missing>"}, expected ${targetVersion}`,
    );
  }

  const targetManifest = requireManifest(packageName, targetVersion, packageDoc, problems);
  if (targetManifest) {
    for (const problem of collectInternalDependencyProblems(targetManifest, packageDocsByName)) {
      problems.push(`${packageName}@${targetVersion}: ${problem}`);
    }
  }

  if (channel === "canary") {
    const latestVersion = distTags.latest;

    if (latestVersion && isCanaryVersion(latestVersion) && !allowCanaryLatest) {
      problems.push(
        `${packageName}: latest dist-tag still resolves to canary ${latestVersion}; rerun with --allow-canary-latest only when that state is intentional`,
      );
    }

    if (latestVersion && isCanaryVersion(latestVersion)) {
      const latestManifest = requireManifest(packageName, latestVersion, packageDoc, problems);
      if (latestManifest) {
        for (const problem of collectInternalDependencyProblems(latestManifest, packageDocsByName)) {
          problems.push(`${packageName}@${latestVersion} via latest: ${problem}`);
        }
      }
    }
  }

  return problems;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const packageNames = [...new Set(options.packages)];
  const packageDocsByName = new Map();

  await Promise.all(
    packageNames.map(async (packageName) => {
      packageDocsByName.set(packageName, await fetchPackageDocument(packageName));
    }),
  );

  const additionalInternalDeps = new Set();
  for (const packageDoc of packageDocsByName.values()) {
    const versionsToCheck = new Set([options.targetVersion]);
    const latestVersion = packageDoc["dist-tags"]?.latest;
    if (latestVersion && isCanaryVersion(latestVersion)) {
      versionsToCheck.add(latestVersion);
    }

    for (const version of versionsToCheck) {
      const manifest = packageDoc.versions?.[version];
      if (!manifest) {
        continue;
      }

      for (const deps of [
        manifest.dependencies ?? {},
        manifest.optionalDependencies ?? {},
        manifest.peerDependencies ?? {},
      ]) {
        for (const dependencyName of Object.keys(deps)) {
          if (dependencyName.startsWith("@paperclipai/")) {
            additionalInternalDeps.add(dependencyName);
          }
        }
      }
    }
  }

  const missingDeps = [...additionalInternalDeps].filter((dep) => !packageDocsByName.has(dep));
  await Promise.all(
    missingDeps.map(async (dependencyName) => {
      packageDocsByName.set(
        dependencyName,
        await fetchPackageDocument(dependencyName, { allowMissing: true }),
      );
    }),
  );

  const problems = [];

  for (const packageName of packageNames) {
    process.stdout.write(`  Verifying ${packageName} on dist-tag ${options.distTag}\n`);
    const packageProblems = verifyPackageRegistryState({
      packageName,
      packageDoc: packageDocsByName.get(packageName),
      packageDocsByName,
      channel: options.channel,
      distTag: options.distTag,
      targetVersion: options.targetVersion,
      allowCanaryLatest: options.allowCanaryLatest,
    });

    if (packageProblems.length === 0) {
      process.stdout.write(`    ✓ dist-tag and published internal dependencies are consistent\n`);
      continue;
    }

    for (const problem of packageProblems) {
      process.stderr.write(`    ✗ ${problem}\n`);
      problems.push(problem);
    }
  }

  if (problems.length > 0) {
    throw new Error(`npm registry verification failed for ${problems.length} problem(s)`);
  }
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`Error: ${error.message}\n`);
    process.exit(1);
  });
}
