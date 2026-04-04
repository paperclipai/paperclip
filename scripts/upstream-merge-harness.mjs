import { spawnSync } from "node:child_process";

/**
 * Keep this harness small and principle-driven.
 *
 * Admission criteria for suites:
 * - guards a merge-sensitive invariant that has regressed or is easy to break by hand-merge
 * - exercises infrastructure/contract behavior rather than a single feature flow
 * - stays lightweight and deterministic enough to run before the full gate on every upstream sync
 *
 * The concrete suite list is intentionally maintained here, not in the runbook.
 */
const HARNESS_GROUPS = {
  responseLifecycleAndErrorHandling: [
    "server/src/__tests__/error-handler.test.ts",
  ],
  localeAndI18nInfrastructure: [
    "server/src/__tests__/i18n.test.ts",
    "server/src/__tests__/locale-middleware.test.ts",
    "server/src/__tests__/ui-locale.test.ts",
  ],
  windowsWorktreeAndEnvCompatibility: [
    "server/src/__tests__/worktree-config.test.ts",
  ],
};

const suites = Object.values(HARNESS_GROUPS).flat();
const extraArgs = process.argv.slice(2);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const packageManagerExec = process.env.npm_execpath;

console.log("[upstream-merge-harness] running merge-sensitive invariant suites:");
for (const [groupName, groupSuites] of Object.entries(HARNESS_GROUPS)) {
  console.log(`- ${groupName}`);
  for (const suite of groupSuites) {
    console.log(`  ${suite}`);
  }
}

const command = packageManagerExec ? process.execPath : pnpmCommand;
const args = packageManagerExec
  ? [packageManagerExec, "exec", "vitest", "run", ...suites, ...extraArgs]
  : ["exec", "vitest", "run", ...suites, ...extraArgs];

const result = spawnSync(
  command,
  args,
  {
    stdio: "inherit",
    shell: false,
  },
);

if (result.error) {
  console.error("[upstream-merge-harness] failed to start test runner", result.error);
  process.exit(1);
}

if (typeof result.status === "number") {
  process.exit(result.status);
}

process.exit(1);
