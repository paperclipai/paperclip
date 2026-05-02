#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const serverRoot = path.join(repoRoot, "server");
const serverTestsDir = path.join(repoRoot, "server", "src", "__tests__");
const nonServerProjects = [
  "@paperclipai/shared",
  "@paperclipai/db",
  "@paperclipai/adapter-utils",
  "@paperclipai/adapter-acpx-local",
  "@paperclipai/adapter-codex-local",
  "@paperclipai/adapter-opencode-local",
  "@paperclipai/ui",
  "paperclipai",
];
const routeTestPattern = /[^/]*(?:route|routes|authz)[^/]*\.test\.ts$/;
const additionalSerializedServerTests = new Set([
  "server/src/__tests__/approval-routes-idempotency.test.ts",
  "server/src/__tests__/assets.test.ts",
  "server/src/__tests__/authz-company-access.test.ts",
  "server/src/__tests__/claude-local-execute.test.ts",
  "server/src/__tests__/companies-route-path-guard.test.ts",
  "server/src/__tests__/company-skills-service.test.ts",
  "server/src/__tests__/company-portability.test.ts",
  "server/src/__tests__/costs-service.test.ts",
  "server/src/__tests__/codex-local-execute.test.ts",
  "server/src/__tests__/cursor-local-adapter-environment.test.ts",
  "server/src/__tests__/cursor-local-execute.test.ts",
  "server/src/__tests__/environment-runtime-driver-contract.test.ts",
  "server/src/__tests__/environment-runtime.test.ts",
  "server/src/__tests__/environment-service.test.ts",
  "server/src/__tests__/express5-auth-wildcard.test.ts",
  "server/src/__tests__/health-dev-server-token.test.ts",
  "server/src/__tests__/health.test.ts",
  "server/src/__tests__/heartbeat-dependency-scheduling.test.ts",
  "server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts",
  "server/src/__tests__/heartbeat-local-environment.test.ts",
  "server/src/__tests__/heartbeat-process-recovery.test.ts",
  "server/src/__tests__/invite-accept-existing-member.test.ts",
  "server/src/__tests__/invite-accept-gateway-defaults.test.ts",
  "server/src/__tests__/invite-accept-replay.test.ts",
  "server/src/__tests__/invite-expiry.test.ts",
  "server/src/__tests__/invite-join-manager.test.ts",
  "server/src/__tests__/invite-onboarding-text.test.ts",
  "server/src/__tests__/issues-checkout-wakeup.test.ts",
  "server/src/__tests__/issues-service.test.ts",
  "server/src/__tests__/opencode-local-adapter-environment.test.ts",
  "server/src/__tests__/plugin-orchestration-apis.test.ts",
  "server/src/__tests__/project-routes-env.test.ts",
  "server/src/__tests__/redaction.test.ts",
  "server/src/__tests__/routines-e2e.test.ts",
  "server/src/__tests__/workspace-runtime.test.ts",
]);
let invocationIndex = 0;

function walk(dir) {
  const entries = readdirSync(dir);
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(dir, entry);
    const stats = statSync(absolute);
    if (stats.isDirectory()) {
      files.push(...walk(absolute));
    } else if (stats.isFile()) {
      files.push(absolute);
    }
  }
  return files;
}

function toRepoPath(file) {
  return path.relative(repoRoot, file).split(path.sep).join("/");
}

function toServerPath(file) {
  return path.relative(serverRoot, file).split(path.sep).join("/");
}

function isRouteOrAuthzTest(file) {
  if (routeTestPattern.test(file)) {
    return true;
  }

  return additionalSerializedServerTests.has(file);
}

function isWindowsEmbeddedPostgresTest(file) {
  if (process.platform !== "win32") return false;
  return readFileSync(file, "utf8").includes("startEmbeddedPostgresTestDatabase");
}

function runVitest(args, label) {
  console.log(`\n[test:run] ${label}`);
  invocationIndex += 1;
  const testRoot = mkdtempSync(path.join(os.tmpdir(), `paperclip-vitest-${process.pid}-${invocationIndex}-`));
  const env = {
    ...process.env,
    PAPERCLIP_HOME: path.join(testRoot, "home"),
    PAPERCLIP_INSTANCE_ID: `vitest-${process.pid}-${invocationIndex}`,
    TMPDIR: path.join(testRoot, "tmp"),
  };
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  const result = spawnSync(pnpmBin, ["exec", "vitest", "run", ...args], {
    cwd: repoRoot,
    env,
    shell: process.platform === "win32",
    stdio: "inherit",
  });
  if (result.error) {
    console.error(`[test:run] Failed to start Vitest: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const serverTests = walk(serverTestsDir)
  .filter((file) => /\.test\.[cm]?[tj]sx?$/.test(file))
  .map((file) => ({
    repoPath: toRepoPath(file),
    serverPath: toServerPath(file),
  }))
  .sort((a, b) => a.repoPath.localeCompare(b.repoPath));

const routeTests = serverTests
  .filter((file) => isRouteOrAuthzTest(file.repoPath) || isWindowsEmbeddedPostgresTest(path.join(repoRoot, file.repoPath)))
  .sort((a, b) => a.repoPath.localeCompare(b.repoPath));

const serializedServerTestPaths = new Set(routeTests.map((file) => file.repoPath));
const nonSerializedServerTests = serverTests
  .filter((file) => !serializedServerTestPaths.has(file.repoPath))
  .map((file) => ({
    repoPath: file.repoPath,
    serverPath: file.serverPath,
  }))
  .sort((a, b) => a.repoPath.localeCompare(b.repoPath));

for (const project of nonServerProjects) {
  runVitest(["--project", project], `non-server project ${project}`);
}

if (nonSerializedServerTests.length > 0) {
  runVitest(
    ["--project", "@paperclipai/server", ...nonSerializedServerTests.map((file) => file.serverPath)],
    `server suites excluding ${routeTests.length} serialized suites`,
  );
}

for (const routeTest of routeTests) {
  runVitest(
    [
      "--project",
      "@paperclipai/server",
      routeTest.repoPath,
      "--pool=forks",
      "--poolOptions.forks.isolate=true",
    ],
    routeTest.repoPath,
  );
}
