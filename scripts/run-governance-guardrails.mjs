#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repoRoot = process.cwd();
const suites = [
  "server/src/__tests__/company-skills-service.test.ts",
  "server/src/__tests__/plugin-managed-skills.test.ts",
  "server/src/__tests__/improvement-suggestions-service.test.ts",
  "server/src/__tests__/heartbeat-issue-liveness-escalation.test.ts",
];

for (const [index, suite] of suites.entries()) {
  const testRoot = mkdtempSync(path.join(os.tmpdir(), `paperclip-governance-${process.pid}-${index}-`));
  const env = {
    ...process.env,
    PAPERCLIP_REQUIRE_EMBEDDED_POSTGRES: "true",
    PAPERCLIP_HOME: path.join(testRoot, "home"),
    PAPERCLIP_INSTANCE_ID: `governance-${process.pid}-${index}`,
    TMPDIR: path.join(testRoot, "tmp"),
  };
  mkdirSync(env.PAPERCLIP_HOME, { recursive: true });
  mkdirSync(env.TMPDIR, { recursive: true });
  process.stdout.write(`\n[governance-guardrails] ${suite}\n`);
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "run",
      "--project",
      "@paperclipai/server",
      suite,
      "--pool=forks",
      "--poolOptions.forks.isolate=true",
    ],
    { cwd: repoRoot, env, stdio: "inherit" },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
