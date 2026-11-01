import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { invocationEnv } from "./record.mjs";

const args = ["--test"];
if (process.env.PAPERCLIP_CI_PROFILE === "true") {
  args.push("--test-reporter=spec", "--test-reporter-destination=stdout",
    `--test-reporter=${fileURLToPath(new URL("./node-reporter.mjs", import.meta.url))}`,
    "--test-reporter-destination=stdout");
}
const result = spawnSync(process.execPath, [...args, ...process.argv.slice(2)], {
  stdio: "inherit", env: invocationEnv("node"),
});
if (result.error) console.error(result.error.message);
if (result.signal) process.kill(process.pid, result.signal);
else process.exitCode = result.status ?? 1;
