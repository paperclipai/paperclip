// The general server test job has no Rust binary. The runner check builds it
// first and requires the complete runnerd → PRP → authority → HTTP test.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", [
  "exec", "vitest", "run",
  "server/src/services/native-runtime/runner-api.test.ts",
  "server/src/services/native-runtime/runner-api.integration.test.ts",
], {
  cwd: fileURLToPath(new URL("../../../", import.meta.url)),
  env: { ...process.env, PAPERCLIP_REQUIRE_RUNNER_API_INTEGRATION: "1" },
  stdio: "inherit",
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
