// The general server test job has no Rust binary. This check builds and stages
// its own binary, then requires the complete runnerd -> PRP -> authority -> HTTP test.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runUnderSharedPostgres,
  shouldWrapWithSharedPostgres,
} from "../../../scripts/ci/vitest-shared-postgres.mjs";

const packageRoot = fileURLToPath(new URL("../", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const scriptPath = fileURLToPath(import.meta.url);
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

export const API_AUTHORITY_VITEST_ARGS = [
  "exec",
  "vitest",
  "run",
  "--project",
  "@paperclipai/server",
  "server/src/services/native-runtime/runner-api.test.ts",
  "server/src/services/native-runtime/runner-api-rollout.test.ts",
  "server/src/services/native-runtime/runner-api.integration.test.ts",
];

function run(args, cwd, env = process.env) {
  const result = spawnSync(pnpm, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

export function planApiAuthority({ skipBuild = false } = {}) {
  return {
    skipBuild,
    buildCommands: skipBuild
      ? []
      : [
          { command: pnpm, args: ["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"], cwd: repoRoot },
          { command: pnpm, args: ["run", "build:binary"], cwd: packageRoot },
        ],
    vitestCommand: {
      command: pnpm,
      args: API_AUTHORITY_VITEST_ARGS,
      cwd: repoRoot,
      env: { PAPERCLIP_REQUIRE_RUNNER_API_INTEGRATION: "1" },
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  const skipBuild = args.includes("--skip-build");
  const dryRun = args.includes("--dry-run");
  const unknown = args.filter((arg) => arg !== "--skip-build" && arg !== "--dry-run");
  if (unknown.length > 0) {
    console.error(`[check-api-authority] unrecognized argument(s): ${unknown.join(" ")}`);
    process.exit(1);
  }
  const plan = planApiAuthority({ skipBuild });
  if (dryRun) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  for (const step of plan.buildCommands) {
    run(step.args, step.cwd);
  }

  const testEnv = {
    ...process.env,
    PAPERCLIP_REQUIRE_RUNNER_API_INTEGRATION: "1",
  };

  if (
    shouldWrapWithSharedPostgres({
      repoRoot,
      dryRun: false,
      hasSharedTestDatabase: Boolean(process.env.PAPERCLIP_TEST_DATABASE_URL?.trim()),
      usesPostgres: true,
      hasScheduledSuites: true,
      env: testEnv,
    })
  ) {
    await runUnderSharedPostgres({
      repoRoot,
      runnerScriptPath: scriptPath,
      argv: ["--skip-build"],
      env: testEnv,
    });
    return;
  }

  run(plan.vitestCommand.args, plan.vitestCommand.cwd, testEnv);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  await main();
}
