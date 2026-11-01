import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const vitest = path.join(root, "node_modules/vitest/vitest.mjs");
const prefix = "[runner-e2e:unit]";
const args = process.argv.slice(2);
if (args[0] === "--") args.shift();

if (!existsSync(vitest)) {
  console.error(`${prefix} launcher/environment failure: Vitest is not installed. Run pnpm install before validation.`);
  process.exit(2);
}

const env = { ...process.env };
delete env.NODE_PATH;
delete env.NODE_OPTIONS;

for (const [name, command] of [
  ["Vitest", [vitest, "run", "--config", "tests/runner-e2e/vitest.config.ts", ...args]],
  ["Node tests", ["--test", "tests/runner-e2e/artifact-budget.test.mjs", "tests/runner-e2e/native-completion-checks.test.mjs",
    "tests/runner-e2e/native-completion-git-source.test.mjs", "tests/runner-e2e/native-completion-source-contract.test.mjs",
    "tests/runner-e2e/chat-feature-testops-api.test.mjs", "tests/runner-e2e/chat-feature-testops-cli.test.mjs", "tests/runner-e2e/chat-feature-testops-results.test.mjs", "tests/runner-e2e/testops-chat-reporter.test.mjs", "tests/runner-e2e/chat-feature-testops-retained-verification.node-test.mjs",
    "tests/runner-e2e/chat-completion-testops-api.test.mjs", "tests/runner-e2e/chat-completion-testops-contract.test.mjs"]],
]) {
  const result = spawnSync(process.execPath, command, { cwd: root, env, stdio: "inherit" });
  if (result.error || result.signal) {
    console.error(`${prefix} launcher/environment failure: ${name} ${result.error?.message ?? `terminated by ${result.signal}`}`);
    process.exit(2);
  }
  if (result.status !== 0) {
    console.error(`${prefix} ${name} failed (exit ${result.status}); see test runner output above.`);
    process.exit(result.status ?? 1);
  }
}
