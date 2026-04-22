#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vitest.cmd" : "vitest",
);
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const explicitModuleMockPattern = /\bvi\.(?:doMock|mock|hoisted)\b/;
const internalModuleUnmockPattern = /\bvi\.(?:doUnmock|unmock)\(\s*["'](?:\.\.\/|@paperclipai\/)/;
const globalTestHookPattern = /\bset[A-Za-z0-9_]+ForTest\(/;
const pluginSdkEntry = join(repoRoot, "packages", "plugins", "sdk", "dist", "index.js");

function walkFiles(dirPath) {
  const files = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const entryPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function discoverServerMockTests() {
  const serverTestsDir = join(repoRoot, "server", "src", "__tests__");
  if (!existsSync(serverTestsDir)) return [];

  return walkFiles(serverTestsDir)
    .filter((filePath) => testFilePattern.test(filePath))
    .filter((filePath) => {
      const source = readFileSync(filePath, "utf8");
      return (
        explicitModuleMockPattern.test(source) ||
        internalModuleUnmockPattern.test(source) ||
        globalTestHookPattern.test(source)
      );
    })
    .map((filePath) => relative(repoRoot, filePath))
    .sort();
}

function isLikelyTestFilter(arg) {
  if (arg.startsWith("-")) return false;
  const normalized = arg.replace(/\\/g, "/");
  return testFilePattern.test(normalized) || normalized.includes("/") || normalized.startsWith(".");
}

function normalizeFilterPath(arg) {
  return arg
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^server\//, "");
}

function testFilterMatchesFile(filter, filePath) {
  const normalizedFilter = normalizeFilterPath(filter);
  const normalizedFile = filePath.replace(/\\/g, "/");
  const serverRelativeFile = normalizedFile.replace(/^server\//, "");
  return (
    normalizedFile === normalizedFilter ||
    serverRelativeFile === normalizedFilter ||
    normalizedFile.endsWith(`/${normalizedFilter}`) ||
    serverRelativeFile.endsWith(`/${normalizedFilter}`) ||
    normalizedFilter.endsWith(`/${normalizedFile}`) ||
    normalizedFilter.endsWith(`/${serverRelativeFile}`)
  );
}

function excludeArgsFor(filePath) {
  const serverRelativePath = filePath.replace(/^server\//, "");
  return ["--exclude", filePath, "--exclude", serverRelativePath];
}

function runVitest(label, args, options = {}) {
  console.log(`\n[paperclip:test] ${label}`);
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.startsWith("PAPERCLIP_")) {
      delete env[key];
    }
  }
  const isolatedHome = mkdtempSync(join(tmpdir(), "paperclip-vitest-home-"));
  env.HOME = isolatedHome;
  env.USERPROFILE = isolatedHome;
  const result = spawnSync(vitestBin, [
    "run",
    ...(options.noCache ? ["--no-cache"] : []),
    "--reporter=dot",
    ...args,
  ], {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
  rmSync(isolatedHome, { recursive: true, force: true });

  if (result.error) {
    console.error(`[paperclip:test] Failed to start Vitest: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

function ensureDistOnlyWorkspaceBuilds() {
  if (existsSync(pluginSdkEntry)) return;

  console.log("\n[paperclip:test] Building @paperclipai/plugin-sdk because its workspace export points at dist/.");
  const result = spawnSync(pnpmBin, ["--filter", "@paperclipai/plugin-sdk", "build"], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    console.error(`[paperclip:test] Failed to start plugin SDK build: ${result.error.message}`);
    process.exit(1);
  }
  if ((result.status ?? 1) !== 0) {
    console.error("[paperclip:test] Failed to build @paperclipai/plugin-sdk before running tests.");
    process.exit(result.status ?? 1);
  }
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cleanupLeakedRuntimeTestServers() {
  if (process.platform === "win32") return;

  const result = spawnSync(
    "pgrep",
    ["-f", String.raw`node -e require\('node:http'\)\.createServer\(\(req,res\)=>res\.end`],
    {
      encoding: "utf8",
    },
  );
  if (result.status !== 0 || !result.stdout.trim()) return;

  const pids = result.stdout
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
  if (pids.length === 0) return;

  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Ignore stale process races.
    }
  }
  sleep(250);
  for (const pid of pids) {
    try {
      process.kill(pid, 0);
    } catch {
      continue;
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore stale process races.
    }
  }
  console.log(`[paperclip:test] Cleaned up ${pids.length} stale runtime test server process(es).`);
}

ensureDistOnlyWorkspaceBuilds();
cleanupLeakedRuntimeTestServers();

const serverMockTests = discoverServerMockTests();
const requestedTestFilters = cliArgs.filter(isLikelyTestFilter);
const nonFilterCliArgs = cliArgs.filter((arg) => !isLikelyTestFilter(arg));
const serverMockTestsToRun = requestedTestFilters.length === 0
  ? serverMockTests
  : serverMockTests.filter((filePath) =>
      requestedTestFilters.some((filter) => testFilterMatchesFile(filter, filePath)),
    );
const failures = [];

for (const filePath of serverMockTestsToRun) {
  const status = runVitest(
    `isolated server mock test without Vitest cache: ${filePath}`,
    [filePath, ...nonFilterCliArgs],
    { noCache: true },
  );
  if (status !== 0) {
    failures.push(filePath);
  }
}

const onlyExplicitServerMockFiles = requestedTestFilters.length > 0
  && requestedTestFilters.every((filter) =>
    testFilePattern.test(filter)
    && serverMockTestsToRun.some((filePath) => testFilterMatchesFile(filter, filePath)),
  );
const shouldRunRemainingSuite = requestedTestFilters.length === 0 || !onlyExplicitServerMockFiles;

if (shouldRunRemainingSuite) {
  const excludeServerMockTests = serverMockTestsToRun.flatMap(excludeArgsFor);
  const remainingStatus = runVitest("remaining test suite", [...excludeServerMockTests, ...cliArgs]);
  if (remainingStatus !== 0) {
    failures.push("remaining test suite");
  }
}

if (failures.length > 0) {
  console.error("\n[paperclip:test] Failed test groups:");
  for (const failure of failures) {
    console.error(`[paperclip:test] - ${failure}`);
  }
  process.exit(1);
}

console.log("\n[paperclip:test] All test groups passed.");
