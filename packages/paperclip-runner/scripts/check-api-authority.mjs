// The general server test job has no Rust binary. This check builds and stages
// its own binary, then requires the complete runnerd → PRP → authority → HTTP test.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
function run(args, cwd, env = process.env) {
  const result = spawnSync(pnpm, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run(["--filter", "@paperclipai/plugin-sdk", "ensure-build-deps"], fileURLToPath(new URL("../../../", import.meta.url)));
run(["run", "build:binary"], fileURLToPath(new URL("../", import.meta.url)));
run([
  "exec", "vitest", "run",
  "server/src/services/native-runtime/runner-api.test.ts",
  "server/src/services/native-runtime/runner-api-rollout.test.ts",
  "server/src/services/native-runtime/runner-api.integration.test.ts",
], fileURLToPath(new URL("../../../", import.meta.url)), {
  ...process.env, PAPERCLIP_REQUIRE_RUNNER_API_INTEGRATION: "1",
});
