#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestBin = join(
  repoRoot,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "vitest.cmd" : "vitest",
);
const cliArgs = process.argv.slice(2).filter((arg) => arg !== "--");
const heartbeatRuntimeEnvKeys = [
  "PAPERCLIP_AGENT_ID",
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_APPROVAL_ID",
  "PAPERCLIP_APPROVAL_STATUS",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_LINKED_ISSUE_IDS",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_WAKE_COMMENT_ID",
  "PAPERCLIP_WAKE_PAYLOAD_JSON",
  "PAPERCLIP_WAKE_REASON",
  "PAPERCLIP_AGENT_JWT_SECRET",
];

const testFilePattern = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const moduleMockPattern =
  /\bvi\.(?:doMock|mock|hoisted|stub(?:Env|Global)?|unstub(?:AllEnvs|AllGlobals)?|resetModules|unmock|doUnmock)\b/;

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
    .filter((filePath) => moduleMockPattern.test(readFileSync(filePath, "utf8")))
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
  for (const key of heartbeatRuntimeEnvKeys) {
    delete env[key];
  }
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

  if (result.error) {
    console.error(`[paperclip:test] Failed to start Vitest: ${result.error.message}`);
    return 1;
  }

  return result.status ?? 1;
}

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

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
  let status = runVitest(
    `isolated server mock test without Vitest cache: ${filePath}`,
    [filePath, ...nonFilterCliArgs],
    { noCache: true },
  );
  for (let attempt = 1; status !== 0 && attempt <= 2; attempt += 1) {
    sleep(250);
    status = runVitest(
      `retry ${attempt} without Vitest cache: ${filePath}`,
      [filePath, ...nonFilterCliArgs],
      { noCache: true },
    );
  }
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
