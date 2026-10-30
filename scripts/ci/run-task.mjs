import { spawnSync, execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { matchesGlob } from "node:path";
import { executionPlan, sourceFiles } from "./execution-plan.mjs";
import { turboArgs } from "./turbo-args.mjs";

const task = process.env.CI_TASK;
if (!/^ci:[a-z-]+$/.test(task ?? "")) throw new Error("Invalid CI task");
const args = JSON.parse(process.env.CI_TASK_ARGS || "[]");
if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) throw new Error("Invalid task arguments");
const version = (command, argv) => {
  try { return execFileSync(command, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(); }
  catch { return "unavailable"; }
};
const config = JSON.parse(readFileSync("turbo.json", "utf8"));
const files = sourceFiles();
const execution = executionPlan(config, task, args, files);
mkdirSync(".turbo/task-configs", { recursive: true });
const runtimeConfig = `.turbo/task-configs/${task.replace(":", "-")}.json`;
writeFileSync(runtimeConfig, JSON.stringify(execution.config));
const classified = [...config.globalDependencies, ...Object.values(config.tasks).flatMap((entry) => entry.inputs)];
const unknownInputs = createHash("sha256");
let uncacheable = false;
for (const file of files) {
  if (classified.some((glob) => matchesGlob(file, glob))) continue;
  unknownInputs.update(JSON.stringify(file));
  try {
    if (lstatSync(file).isFile()) unknownInputs.update(readFileSync(file));
    else uncacheable = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    unknownInputs.update("<deleted>");
  }
}
const scope = {
  node: process.version, pnpm: version("pnpm", ["--version"]),
  platform: process.platform, arch: process.arch, cwd: realpathSync(process.cwd()),
  libc: process.report.getReport().header.glibcVersionRuntime ?? null,
  rust: version("rustc", ["--version", "--verbose"]),
  unknownInputs: unknownInputs.digest("hex"),
};
const force = process.env.CI_FORCE_TASKS === "true" || uncacheable;
const result = spawnSync("pnpm", ["exec", "turbo", ...turboArgs({
  target: execution.target, runtimeConfig, cacheDir: ".turbo/cache", force,
  dryRun: process.env.CI_TASK_DRY_RUN === "true", args: execution.args,
})], {
  stdio: "inherit",
  env: { ...process.env, TURBO_TELEMETRY_DISABLED: "1",
    CI_TASK_CACHE_SCOPE: createHash("sha256").update(JSON.stringify(scope)).digest("hex") },
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
