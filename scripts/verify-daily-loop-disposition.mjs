import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const result = spawnSync("pnpm", ["exec", "vitest", "run", "server/src/__tests__/daily-loop-disposition.test.ts", "server/src/__tests__/legacy-continuation-authority.test.ts", "server/src/__tests__/issue-continuation-summary.test.ts", "--reporter=verbose"], {
  cwd: fileURLToPath(new URL("..", import.meta.url)),
  stdio: "inherit",
});
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
