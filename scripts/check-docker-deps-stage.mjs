#!/usr/bin/env node

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const dockerfilePath = path.join(repoRoot, "Dockerfile");
const workspacePath = path.join(repoRoot, "pnpm-workspace.yaml");

function extractDepsStage(dockerfileText) {
  const lines = dockerfileText.split("\n");
  const captured = [];
  let inDeps = false;

  for (const line of lines) {
    if (!inDeps) {
      if (/^FROM .* AS deps$/i.test(line.trim())) inDeps = true;
      continue;
    }
    if (/^FROM /i.test(line.trim())) break;
    captured.push(line);
  }

  return captured.join("\n");
}

function parseWorkspaceRoots(workspaceText) {
  return workspaceText
    .split("\n")
    .map((line) => line.match(/^\s*-\s+(.+)\s*$/)?.[1]?.trim() ?? null)
    .map((entry) => {
      if (!entry) return entry;
      return entry.replace(/^(['"])(.*)\1$/, "$2");
    })
    .filter(Boolean)
    .filter((entry) => !entry.startsWith("!"))
    .map((entry) => entry.replace(/\*+$/, ""))
    .filter((entry) => entry.length > 0)
    .filter((entry) => !entry.includes("examples"))
    .filter((entry) => !entry.includes("create-paperclip-plugin"));
}

function walkPackageJsonFiles(rootRelative, maxDepth) {
  const results = [];
  const rootAbsolute = path.join(repoRoot, rootRelative);

  if (!existsSync(rootAbsolute)) return results;

  function visit(currentAbsolute, depthFromRoot) {
    const entries = readdirSync(currentAbsolute, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name === "node_modules") continue;

      const absolute = path.join(currentAbsolute, entry.name);
      const relative = path.relative(repoRoot, absolute).split(path.sep).join("/");

      if (entry.isDirectory()) {
        if (depthFromRoot < maxDepth) visit(absolute, depthFromRoot + 1);
        continue;
      }

      if (
        entry.name === "package.json" &&
        !relative.includes("/examples/") &&
        !relative.includes("/create-paperclip-plugin/")
      ) {
        results.push(relative);
      }
    }
  }

  visit(rootAbsolute, 0);
  return results;
}

function globToRegExp(pattern) {
  const normalized = pattern.replace("/./", "/");
  let regex = "";

  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];

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

function parseCopySources(depsStage) {
  const sources = [];

  for (const rawLine of depsStage.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("COPY ")) continue;

    const tokens = line.split(/\s+/);
    let index = 1;
    while (tokens[index]?.startsWith("--")) index += 1;

    const args = tokens.slice(index);
    if (args.length < 2) continue;

    const lineSources = args.slice(0, -1);
    for (const source of lineSources) {
      sources.push(source);
    }
  }

  return sources;
}

function main() {
  const depsStage = extractDepsStage(readFileSync(dockerfilePath, "utf8"));
  if (!depsStage.trim()) {
    console.error("Could not extract deps stage from Dockerfile (expected 'FROM ... AS deps').");
    process.exit(1);
  }

  const workspaceRoots = parseWorkspaceRoots(readFileSync(workspacePath, "utf8"));
  if (workspaceRoots.length === 0) {
    console.error("Could not derive workspace roots from pnpm-workspace.yaml.");
    process.exit(1);
  }

  const requiredPackageJsons = [...new Set(
    workspaceRoots.flatMap((root) => walkPackageJsonFiles(root, 2)),
  )].sort();

  const copySources = parseCopySources(depsStage);
  const copyMatchers = copySources.map((source) => ({
    source,
    regex: globToRegExp(source),
  }));

  let missing = 0;
  for (const pkg of requiredPackageJsons) {
    const covered = copyMatchers.some(({ regex }) => regex.test(pkg));
    if (!covered) {
      console.error(`Dockerfile deps stage missing package manifest coverage for: ${pkg}`);
      missing = 1;
    }
  }

  if (existsSync(path.join(repoRoot, "patches"))) {
    const patchesCovered = copySources.includes("patches/");
    if (!patchesCovered) {
      console.error("Dockerfile deps stage missing: COPY patches/ patches/");
      missing = 1;
    }
  }

  if (missing) {
    console.error("Dockerfile deps stage is out of sync. Update it to cover the missing files.");
    process.exit(1);
  }

  console.log("PASS");
}

main();
