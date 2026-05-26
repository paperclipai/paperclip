import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { OnboardingScanRequest, OnboardingScanResponse, OnboardingScanWarning } from "@paperclipai/shared";

import { badRequest } from "../errors.js";

const DEFAULT_MAX_DEPTH = 3;
const MAX_ENTRIES = 5_000;
const MAX_STAT_CALLS = 7_500;
const SCAN_TIMEOUT_MS = 5_000;
const MAX_DIRECTORY_STRUCTURE_ITEMS = 100;
const MAX_DEPENDENCY_ITEMS = 50;
const MAX_PACKAGE_JSON_BYTES = 128 * 1024;

const HEAVY_DIRECTORY_NAMES = new Set([
  ".git",
  "node_modules",
  "bower_components",
  "dist",
  "build",
  "out",
  "target",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
  ".nyc_output",
  "vendor",
]);

const SOURCE_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".dart",
  ".go",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".swift",
  ".ts",
  ".tsx",
  ".vue",
]);

const EMPTY_FOLDER_DEFAULT_FILES = new Set([
  ".gitignore",
  ".gitattributes",
  "readme",
  "readme.md",
  "license",
  "license.md",
]);

const SAFE_MANIFEST_FILES = new Set([
  "package.json",
  "tsconfig.json",
  "vite.config.ts",
  "vite.config.js",
  "next.config.js",
  "next.config.mjs",
  "pnpm-lock.yaml",
  "yarn.lock",
  "package-lock.json",
  "bun.lockb",
  "pyproject.toml",
  "requirements.txt",
  "poetry.lock",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "pubspec.yaml",
]);

const SECRET_FILE_PATTERNS = [
  /^\.env(?:\.|$)/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /(?:^|[-_.])(token|secret|credential|credentials|apikey|api_key|password)(?:[-_.]|$)/i,
  /id_rsa/i,
  /id_ed25519/i,
];

type ScanState = {
  deadlineMs: number;
  maxDepth: number;
  includeManifests: boolean;
  statCalls: number;
  entryCount: number;
  stoppedForLimit: boolean;
  timedOut: boolean;
  counts: OnboardingScanResponse["counts"];
  warnings: OnboardingScanWarning[];
  detectedStacks: Set<string>;
  packageManagers: Set<string>;
  safeManifestIndicators: Set<string>;
  directoryStructure: string[];
  dependencies: Set<string>;
  devDependencies: Set<string>;
  hasReadme: boolean;
  meaningfulFileCount: number;
};

function normalizeDisplayPath(value: string): string {
  const home = os.homedir();
  return value === home ? "~" : value.startsWith(`${home}${path.sep}`) ? `~${value.slice(home.length)}` : value;
}

function isPathWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || Boolean(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function sensitiveRoots(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".ssh"),
    path.join(home, ".gnupg"),
    path.join(home, ".aws"),
    path.join(home, ".kube"),
    path.join(home, ".docker"),
    path.join(home, ".config"),
    path.join(home, ".paperclip"),
    path.join(home, "Library", "Application Support", "Google", "Chrome"),
    path.join(home, "Library", "Application Support", "Firefox"),
    path.join(home, "Library", "Safari"),
    "/etc",
    "/var",
    "/private/etc",
    "/private/var",
    "/System",
    "/Library",
    "/Windows",
    "/boot",
    "/dev",
    "/proc",
    "/sys",
  ];
}

function assertSafeRoot(realPath: string): void {
  for (const root of sensitiveRoots()) {
    if (isPathWithin(realPath, path.resolve(root))) {
      throw badRequest("Path targets a sensitive system or credential directory", {
        code: "sensitive_root",
        path: normalizeDisplayPath(realPath),
      });
    }
  }
}

function shouldSkipSecretLikeFile(name: string): boolean {
  return SECRET_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function addWarning(state: ScanState, warning: OnboardingScanWarning): void {
  state.warnings.push(warning);
}

function enforceScanBudget(state: ScanState): boolean {
  if (Date.now() > state.deadlineMs) {
    if (!state.timedOut) {
      state.timedOut = true;
      addWarning(state, {
        code: "scan_timeout",
        message: "Large project scan reached the time limit; Paperclip will continue with the partial safe summary.",
      });
    }
    return false;
  }
  if (state.entryCount >= MAX_ENTRIES || state.statCalls >= MAX_STAT_CALLS) {
    if (!state.stoppedForLimit) {
      state.stoppedForLimit = true;
      addWarning(state, {
        code: "scan_limit_reached",
        message: "Large project scan reached the bounded sampling limit; Paperclip will continue with the partial safe summary.",
      });
    }
    return false;
  }
  return true;
}

function trackStructure(state: ScanState, relativePath: string, isDirectory: boolean): void {
  if (state.directoryStructure.length >= MAX_DIRECTORY_STRUCTURE_ITEMS) return;
  const normalized = relativePath.split(path.sep).join("/");
  state.directoryStructure.push(isDirectory ? `${normalized}/` : normalized);
}

function trackStackFromName(state: ScanState, name: string): void {
  const lower = name.toLowerCase();
  const ext = path.extname(lower);

  if (lower === "package.json") state.detectedStacks.add("node");
  if (lower === "tsconfig.json" || ext === ".ts" || ext === ".tsx") state.detectedStacks.add("typescript");
  if (ext === ".jsx" || ext === ".tsx" || lower.includes("react")) state.detectedStacks.add("react");
  if (lower === "vite.config.ts" || lower === "vite.config.js") state.detectedStacks.add("vite");
  if (lower === "next.config.js" || lower === "next.config.mjs" || lower === ".next") state.detectedStacks.add("next");
  if (lower === "drizzle.config.ts" || lower === "drizzle.config.js") state.detectedStacks.add("drizzle");
  if (lower === "pyproject.toml" || ext === ".py") state.detectedStacks.add("python");
  if (lower === "go.mod" || ext === ".go") state.detectedStacks.add("go");
  if (lower === "cargo.toml" || ext === ".rs") state.detectedStacks.add("rust");
  if (lower === "pubspec.yaml" || ext === ".dart") state.detectedStacks.add("dart");

  if (lower === "pnpm-lock.yaml" || lower === "pnpm-workspace.yaml") state.packageManagers.add("pnpm");
  if (lower === "package-lock.json") state.packageManagers.add("npm");
  if (lower === "yarn.lock") state.packageManagers.add("yarn");
  if (lower === "bun.lockb") state.packageManagers.add("bun");
  if (lower === "poetry.lock") state.packageManagers.add("poetry");
  if (lower === "requirements.txt") state.packageManagers.add("pip");
  if (lower === "go.mod") state.packageManagers.add("go");
  if (lower === "cargo.toml") state.packageManagers.add("cargo");
}

function trackMeaningfulFile(state: ScanState, name: string): void {
  const lower = name.toLowerCase();
  if (EMPTY_FOLDER_DEFAULT_FILES.has(lower)) return;
  if (shouldSkipSecretLikeFile(lower)) return;
  if (SAFE_MANIFEST_FILES.has(lower) || SOURCE_EXTENSIONS.has(path.extname(lower))) {
    state.meaningfulFileCount += 1;
  }
}

async function readPackageJsonSummary(state: ScanState, filePath: string): Promise<void> {
  if (!state.includeManifests) return;
  try {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_PACKAGE_JSON_BYTES) {
      addWarning(state, {
        code: "manifest_too_large",
        message: "Skipped package.json dependency summary because the file is too large.",
        path: normalizeDisplayPath(filePath),
      });
      return;
    }
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
    };
    for (const dep of Object.keys(parsed.dependencies ?? {}).slice(0, MAX_DEPENDENCY_ITEMS)) {
      state.dependencies.add(dep);
    }
    for (const dep of Object.keys(parsed.devDependencies ?? {}).slice(0, MAX_DEPENDENCY_ITEMS)) {
      state.devDependencies.add(dep);
    }
  } catch {
    addWarning(state, {
      code: "manifest_unreadable",
      message: "Could not parse package.json dependency summary.",
      path: normalizeDisplayPath(filePath),
    });
  }
}

async function scanDirectory(currentPath: string, relativePath: string, depth: number, state: ScanState): Promise<void> {
  if (!enforceScanBudget(state)) return;
  let entries;
  try {
    entries = await fs.readdir(currentPath, { withFileTypes: true });
  } catch {
    addWarning(state, {
      code: "directory_unreadable",
      message: "Could not read directory; continuing with remaining scan.",
      path: normalizeDisplayPath(currentPath),
    });
    return;
  }

  for (const entry of entries) {
    if (!enforceScanBudget(state)) return;

    const entryPath = path.join(currentPath, entry.name);
    const entryRelativePath = relativePath ? path.join(relativePath, entry.name) : entry.name;
    state.entryCount += 1;
    state.statCalls += 1;

    if (entry.isSymbolicLink()) {
      state.counts.symlinks += 1;
      if (state.directoryStructure.length < MAX_DIRECTORY_STRUCTURE_ITEMS) {
        trackStructure(state, entryRelativePath, false);
      }
      continue;
    }

    if (entry.isDirectory()) {
      if (HEAVY_DIRECTORY_NAMES.has(entry.name)) {
        state.counts.ignoredDirectories += 1;
        continue;
      }
      state.counts.directories += 1;
      trackStructure(state, entryRelativePath, true);
      trackStackFromName(state, entry.name);
      if (depth < state.maxDepth) {
        await scanDirectory(entryPath, entryRelativePath, depth + 1, state);
      }
      continue;
    }

    if (!entry.isFile()) continue;
    state.counts.files += 1;
    trackStructure(state, entryRelativePath, false);
    trackStackFromName(state, entry.name);
    trackMeaningfulFile(state, entry.name);
    const lowerName = entry.name.toLowerCase();
    if (lowerName === "readme.md" || lowerName === "readme") state.hasReadme = true;
    if (SAFE_MANIFEST_FILES.has(entry.name) || SAFE_MANIFEST_FILES.has(lowerName)) {
      state.safeManifestIndicators.add(entry.name);
    }
    if (lowerName === "package.json" && !shouldSkipSecretLikeFile(lowerName)) {
      await readPackageJsonSummary(state, entryPath);
    }
  }
}

export async function scanOnboardingDirectory(input: OnboardingScanRequest): Promise<OnboardingScanResponse> {
  if (!path.isAbsolute(input.path)) {
    throw badRequest("Path must be absolute", { code: "path_not_absolute" });
  }

  let realPath: string;
  try {
    realPath = await fs.realpath(input.path);
  } catch {
    throw badRequest("Path does not exist or cannot be resolved", { code: "path_unresolvable" });
  }

  assertSafeRoot(realPath);

  const rootStat = await fs.lstat(realPath);
  if (!rootStat.isDirectory()) {
    throw badRequest("Path must point to a directory", { code: "path_not_directory" });
  }

  const state: ScanState = {
    deadlineMs: Date.now() + SCAN_TIMEOUT_MS,
    maxDepth: Math.min(input.maxDepth ?? DEFAULT_MAX_DEPTH, DEFAULT_MAX_DEPTH),
    includeManifests: input.includeManifests ?? true,
    statCalls: 0,
    entryCount: 0,
    stoppedForLimit: false,
    timedOut: false,
    counts: { directories: 0, files: 0, ignoredDirectories: 0, symlinks: 0 },
    warnings: [],
    detectedStacks: new Set(),
    packageManagers: new Set(),
    safeManifestIndicators: new Set(),
    directoryStructure: [],
    dependencies: new Set(),
    devDependencies: new Set(),
    hasReadme: false,
    meaningfulFileCount: 0,
  };

  await scanDirectory(realPath, "", 0, state);

  const repoKind = state.stoppedForLimit || state.timedOut
    ? "too_large"
    : state.meaningfulFileCount > 0
      ? "brownfield"
      : "empty";

  return {
    displayPath: normalizeDisplayPath(realPath),
    repoKind,
    counts: state.counts,
    detectedStacks: Array.from(state.detectedStacks).sort(),
    packageManagers: Array.from(state.packageManagers).sort(),
    safeManifestIndicators: Array.from(state.safeManifestIndicators).sort(),
    warnings: state.warnings,
    boundedSanitizedSummary: {
      projectName: path.basename(realPath) || null,
      dependencies: Array.from(state.dependencies).sort(),
      devDependencies: Array.from(state.devDependencies).sort(),
      hasReadme: state.hasReadme,
      directoryStructure: state.directoryStructure,
    },
  };
}
