#!/usr/bin/env node
// Typechecks the test projects outside `pnpm -r`.
//
// Each project imports server source through relative paths, so its tsconfig.json
// is one program over most of the server. Its tsconfig.layers.json reads that
// source as the declarations from server/scripts/typecheck-layers.mjs, which this
// script builds first. It then fails if a project still loads server source,
// because that is what makes these programs large. See "Typecheck memory" in
// doc/test-infrastructure.md.
//
// --reuse-declarations skips the build. Use it only straight after a server
// typecheck on the same commit, because stale declarations pass silently.
//
// Usage: node scripts/typecheck-test-projects.mjs [--low-memory] [--checkers <n>] [--reuse-declarations] [project ...]

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { LOW_MEMORY_VARIABLE, runTsc } from "./run-tsc.mjs";
import { runPnpm } from "./typecheck-low-memory.mjs";
import { isTestFile, typecheckLayers } from "../server/scripts/typecheck-layers.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const PROJECTS = [
  "server/src/__tests__/helpers/maintenance",
  "tests/e2e",
  "tests/lifecycle-baseline",
  "tests/restart-chaos",
  "tests/runner-e2e",
  "tests/speko-native",
];

// Measured CI durations (seconds, run 45440355579 / 45444347449) used to schedule
// the slowest test projects first so they never land at the end of a lane wave.
export const PROJECT_DURATION_WEIGHTS = {
  "tests/runner-e2e": 21.3,
  "server/src/__tests__/helpers/maintenance": 11.0,
  "tests/e2e": 10.8,
  "tests/restart-chaos": 10.7,
  "tests/lifecycle-baseline": 7.6,
  "tests/speko-native": 5.0,
};

export function orderProjectsLpt(projects = PROJECTS) {
  return [...projects].sort(
    (left, right) => (PROJECT_DURATION_WEIGHTS[right] ?? 10) - (PROJECT_DURATION_WEIGHTS[left] ?? 10),
  );
}

const GLOBAL_PROJECT_INPUTS = new Set([
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.base.json",
  ".npmrc",
  "scripts/run-tsc.mjs",
  "scripts/ci-typecheck-lane.mjs",
  "scripts/typecheck-test-projects.mjs",
  "server/scripts/typecheck-layers.mjs",
  "server/src/types/express.d.ts",
  "server/tsconfig.json",
]);

const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const RESOLVE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".mjs", ".cjs", ".js", ".jsx", ".json"];
const IMPORT_SPECIFIER_PATTERN =
  /(?:(?:import|export)\s+(?:type\s+)?(?:[^;]*?\s+from\s+)?|import\s*\()[\s\n]*["']([^"']+)["']/g;

const toPosix = (value) => value.split(path.sep).join("/");
const stripSourceExtension = (value) => value.replace(/\.(?:[cm]?[jt]s|[jt]sx)$/, "");

const rootGraphCaches = new Map();

function getRootCache(root) {
  let cache = rootGraphCaches.get(root);
  if (cache) return cache;
  cache = {
    dirFiles: new Map(),
    fileEdges: new Map(),
    workspacePackages: null,
    projects: new Map(),
  };
  rootGraphCaches.set(root, cache);
  return cache;
}

function getDirFiles(cache, dir) {
  let set = cache.dirFiles.get(dir);
  if (set) return set;
  set = new Set();
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) set.add(entry.name);
    }
  } catch {}
  cache.dirFiles.set(dir, set);
  return set;
}

function hasFile(cache, absPath) {
  return getDirFiles(cache, path.dirname(absPath)).has(path.basename(absPath));
}

function loadWorkspacePackages(root, cache) {
  if (cache.workspacePackages) return cache.workspacePackages;
  const map = new Map();
  const registerDir = (absDir) => {
    const pkgPath = path.join(absDir, "package.json");
    if (!hasFile(cache, pkgPath)) return;
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (typeof pkg?.name === "string" && pkg.name.length > 0) {
        const relDir = toPosix(path.relative(root, absDir));
        map.set(pkg.name, relDir ? `${relDir}/` : "");
      }
    } catch {}
  };
  const walkPackages = (absDir, depth) => {
    if (depth > 3) return;
    registerDir(absDir);
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name === "dist" || entry.name.startsWith(".")) {
        continue;
      }
      walkPackages(path.join(absDir, entry.name), depth + 1);
    }
  };
  for (const top of ["cli", "server", "ui"]) registerDir(path.join(root, top));
  walkPackages(path.join(root, "packages"), 0);
  cache.workspacePackages = map;
  return map;
}

function resolveCandidateFile(cache, basePath) {
  if (hasFile(cache, basePath)) return basePath;
  const stripped = basePath.replace(/\.(?:[cm]?js|jsx)$/, "");
  for (const ext of RESOLVE_EXTENSIONS) {
    if (hasFile(cache, `${stripped}${ext}`)) return `${stripped}${ext}`;
  }
  for (const ext of RESOLVE_EXTENSIONS) {
    const indexPath = path.join(stripped, `index${ext}`);
    if (hasFile(cache, indexPath)) return indexPath;
  }
  return null;
}

function resolvePathAliases(specifier, projectDir, pathsConfig) {
  if (!pathsConfig || typeof pathsConfig !== "object") return [];
  const targets = [];
  for (const [pattern, replacements] of Object.entries(pathsConfig)) {
    if (!Array.isArray(replacements)) continue;
    const starIndex = pattern.indexOf("*");
    if (starIndex === -1) {
      if (specifier !== pattern) continue;
      for (const replacement of replacements) {
        if (typeof replacement === "string") targets.push(path.resolve(projectDir, replacement));
      }
      continue;
    }
    const prefix = pattern.slice(0, starIndex);
    const suffix = pattern.slice(starIndex + 1);
    if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix)) continue;
    const captured = specifier.slice(prefix.length, specifier.length - suffix.length);
    for (const replacement of replacements) {
      if (typeof replacement === "string") {
        targets.push(path.resolve(projectDir, replacement.replace("*", captured)));
      }
    }
  }
  return targets;
}

function extractFileSpecifiers(cache, absFile) {
  let cached = cache.fileEdges.get(absFile);
  if (cached) return cached;
  const specifiers = [];
  try {
    const source = readFileSync(absFile, "utf8");
    IMPORT_SPECIFIER_PATTERN.lastIndex = 0;
    let match;
    while ((match = IMPORT_SPECIFIER_PATTERN.exec(source))) {
      specifiers.push(match[1].split("?")[0]);
    }
  } catch {}
  cache.fileEdges.set(absFile, specifiers);
  return specifiers;
}

function walkSourceFiles(absDir, out = []) {
  let entries;
  try {
    entries = readdirSync(absDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) walkSourceFiles(full, out);
    else if (SOURCE_FILE_PATTERN.test(entry.name)) out.push(full);
  }
  return out;
}

function expandTsconfigIncludes(root, projectDir, includeEntries, cache) {
  const files = [];
  const patterns = [];
  if (!Array.isArray(includeEntries)) return { files, patterns };
  for (const entry of includeEntries) {
    if (typeof entry !== "string") continue;
    const resolved = path.resolve(projectDir, entry);
    if (!entry.includes("*")) {
      if (hasFile(cache, resolved)) files.push(resolved);
      const rel = toPosix(path.relative(root, resolved));
      if (!rel.startsWith("..")) patterns.push(rel);
      continue;
    }
    // Single-segment wildcard pattern (e.g. "../../maintenance-*.test.ts", "../../server/test-baselines/*.ts")
    if (!entry.includes("**")) {
      const dir = path.dirname(resolved);
      const basePattern = path.basename(resolved);
      const regex = new RegExp(`^${basePattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
      for (const fileName of getDirFiles(cache, dir)) {
        if (regex.test(fileName)) files.push(path.join(dir, fileName));
      }
      const relDir = toPosix(path.relative(root, dir));
      if (!relDir.startsWith("..")) {
        patterns.push({ dir: relDir ? `${relDir}/` : "", regex });
      }
    }
  }
  return { files, patterns };
}

export function collectProjectDependencies(project, root = REPO_ROOT) {
  const cache = getRootCache(root);
  const existing = cache.projects.get(project);
  if (existing) return existing;

  const projectDir = path.join(root, project);
  if (!existsSync(projectDir)) return null;

  const workspacePackages = loadWorkspacePackages(root, cache);
  let tsconfig = null;
  const tsconfigPath = path.join(projectDir, "tsconfig.json");
  if (hasFile(cache, tsconfigPath)) {
    try {
      tsconfig = JSON.parse(readFileSync(tsconfigPath, "utf8"));
    } catch {}
  }
  const pathsConfig = tsconfig?.compilerOptions?.paths ?? null;
  const { files: includeFiles, patterns: includePatterns } = expandTsconfigIncludes(
    root,
    projectDir,
    tsconfig?.include,
    cache,
  );

  const visited = new Set();
  const unresolvedStems = new Set();
  const prefixes = new Set([`${toPosix(project)}/`]);
  const queue = [...walkSourceFiles(projectDir), ...includeFiles];
  for (const file of queue) visited.add(file);

  const enqueueTarget = (absBase) => {
    const resolved = resolveCandidateFile(cache, absBase);
    if (resolved) {
      if (!resolved.includes(`${path.sep}node_modules${path.sep}`) && !visited.has(resolved)) {
        visited.add(resolved);
        queue.push(resolved);
      }
      return;
    }
    const rel = toPosix(path.relative(root, absBase));
    if (!rel.startsWith("..") && !rel.includes("node_modules/")) {
      unresolvedStems.add(stripSourceExtension(rel));
    }
  };

  while (queue.length > 0) {
    const current = queue.pop();
    const specifiers = extractFileSpecifiers(cache, current);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".")) {
        enqueueTarget(path.resolve(path.dirname(current), specifier));
        continue;
      }
      const aliasTargets = resolvePathAliases(specifier, projectDir, pathsConfig);
      if (aliasTargets.length > 0) {
        for (const target of aliasTargets) enqueueTarget(target);
        continue;
      }
      const pkgName = specifier.startsWith("@")
        ? specifier.split("/").slice(0, 2).join("/")
        : specifier.split("/")[0];
      const workspaceDir = workspacePackages.get(pkgName);
      if (workspaceDir) prefixes.add(workspaceDir);
    }
  }

  const files = new Set();
  for (const absFile of visited) {
    const rel = toPosix(path.relative(root, absFile));
    if (!rel.startsWith("..")) files.add(rel);
  }

  const deps = { files, unresolvedStems, prefixes, includePatterns };
  cache.projects.set(project, deps);
  return deps;
}

function matchesProjectDependencies(file, deps) {
  if (deps.files.has(file)) return true;
  if (deps.unresolvedStems.has(stripSourceExtension(file))) return true;
  for (const prefix of deps.prefixes) {
    if (file === prefix || file.startsWith(prefix)) return true;
  }
  for (const pattern of deps.includePatterns) {
    if (typeof pattern === "string") {
      if (file === pattern) return true;
    } else if (file.startsWith(pattern.dir)) {
      const rest = file.slice(pattern.dir.length);
      if (!rest.includes("/") && pattern.regex.test(rest)) return true;
    }
  }
  return false;
}

/**
 * Selects the test projects affected by `changedFiles` in PR mode using each project's
 * static import graph and tsconfig includes. Returns all `projects` when `changedFiles`
 * is null/undefined or touches global inputs.
 */
export function selectTestProjects(changedFiles, projects = PROJECTS, { root = REPO_ROOT } = {}) {
  if (!Array.isArray(changedFiles)) return [...projects];
  const normalizedFiles = changedFiles.map(toPosix);
  if (normalizedFiles.some((file) => GLOBAL_PROJECT_INPUTS.has(file) || file.startsWith("patches/"))) {
    return [...projects];
  }
  return projects.filter((project) => {
    const deps = collectProjectDependencies(project, root);
    // Fail closed for any new or missing project whose import graph cannot be inspected.
    if (!deps) return true;
    return normalizedFiles.some((file) => matchesProjectDependencies(file, deps));
  });
}

// The same steps as the server's typecheck script.
export const PREPARE_STEPS = [
  ["--filter", "@paperclipai/paperclip-runner", "run", "build:typescript"],
  ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"],
];

/**
 * Finds the server source in a program's file list, as paths relative to the
 * server. Test support files have no layer, and declaration and JSON files add
 * little, so only other source files count.
 */
export function findServerSource(files, serverRoot) {
  return files
    .map((file) => path.relative(serverRoot, file).split(path.sep).join("/"))
    .filter(
      (file) =>
        file.startsWith("src/") && /\.[cm]?[jt]sx?$/.test(file) && !/\.d\.[cm]?ts$/.test(file) && !isTestFile(file),
    );
}

function listProgramFiles(config, { cwd, env }) {
  const tsc = path.join(cwd, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "-p", config, "--listFilesOnly"], {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 1 << 26,
  });
  if (result.error) throw result.error;
  return { status: result.status ?? 1, files: result.stdout.split("\n").filter(Boolean), output: result.stdout };
}

export function typecheckTestProjects({
  root,
  projects = PROJECTS,
  reuseDeclarations = false,
  checkers,
  env = process.env,
  pnpm = runPnpm,
  run = runTsc,
  listFiles = listProgramFiles,
  log = console.log,
  logError = console.error,
}) {
  const serverRoot = path.join(root, "server");
  if (!reuseDeclarations) {
    for (const args of PREPARE_STEPS) {
      const status = pnpm(args, { cwd: root, env });
      if (status !== 0) return status;
    }

    const layers = typecheckLayers({
      serverRoot,
      declarationsOnly: true,
      checkers,
      run: (args, options) => run(args, { ...options, env }),
      log,
    });
    // Report the server's own errors first. They would repeat in each project.
    if (layers !== 0) return layers;
  }

  const checkerArgs = Number.isInteger(checkers) && checkers >= 1 ? ["--checkers", String(checkers)] : [];
  let exitCode = 0;
  for (const project of projects) {
    log(`typecheck:test-projects: ${project}`);
    const config = path.posix.join(project, "tsconfig.layers.json");
    const { status, signal } = run(["-p", config, ...checkerArgs], { cwd: root, env });
    if (signal) return status || 1;
    if (status !== 0) exitCode = status;

    const listing = listFiles(config, { cwd: root, env });
    if (listing.status !== 0) {
      logError(`typecheck:test-projects: could not list the files of ${project}\n${listing.output ?? ""}`);
      exitCode ||= listing.status;
      continue;
    }
    const source = findServerSource(listing.files, serverRoot);
    if (source.length > 0) {
      logError(
        `typecheck:test-projects: ${project} loads ${source.length} server source files. ` +
          `It must read them as layer declarations. First files: ${source.slice(0, 5).join(", ")}`,
      );
      exitCode ||= 1;
    }
  }
  return exitCode;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let lowMemory = false;
  let reuseDeclarations = false;
  let checkers;
  const projects = [];
  const unknownFlags = [];
  let invalidCheckers = false;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--low-memory") {
      lowMemory = true;
    } else if (arg === "--reuse-declarations") {
      reuseDeclarations = true;
    } else if (arg === "--checkers") {
      checkers = Number(args[++i]);
      if (!Number.isInteger(checkers) || checkers < 1) invalidCheckers = true;
    } else if (arg.startsWith("--")) {
      unknownFlags.push(arg);
    } else {
      projects.push(arg);
    }
  }
  const unknown = projects.filter((project) => !PROJECTS.includes(project));
  if (unknownFlags.length > 0) {
    console.error(`Unknown option: ${unknownFlags.join(", ")}`);
    process.exitCode = 2;
  } else if (invalidCheckers) {
    console.error("--checkers requires a positive integer");
    process.exitCode = 2;
  } else if (unknown.length > 0) {
    console.error(`Unknown project: ${unknown.join(", ")}. Known projects: ${PROJECTS.join(", ")}`);
    process.exitCode = 2;
  } else {
    process.exitCode = typecheckTestProjects({
      root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      projects: projects.length > 0 ? projects : PROJECTS,
      reuseDeclarations,
      checkers,
      env: lowMemory ? { ...process.env, [LOW_MEMORY_VARIABLE]: "1" } : process.env,
    });
  }
}
