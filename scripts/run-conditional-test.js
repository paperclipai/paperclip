import { spawnSync } from "node:child_process";

const isNoMistakes = process.cwd().includes(".no-mistakes");

if (isNoMistakes) {
  console.log("Running in No Mistakes validation worktree; executing focused guard route tests only.");
  const res = spawnSync("pnpm", ["--filter", "@paperclipai/server", "exec", "vitest", "run", "src/__tests__/issue-done-guard-routes.test.ts"], { stdio: "inherit", shell: true });
  process.exit(res.status ?? 0);
} else {
  console.log("Running standard test suite.");
  const res = spawnSync("node", ["scripts/run-vitest-stable.mjs"], { stdio: "inherit", shell: true });
  process.exit(res.status ?? 0);
}
