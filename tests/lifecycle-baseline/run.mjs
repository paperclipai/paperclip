import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve, join } from "node:path";
import { lanes } from "./inventory.mjs";
import { summarize, markdown } from "./report.mjs";
const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const selected = args.filter((a) => !a.startsWith("--"));
if (selected.some((l) => !(l in lanes)))
  throw new Error(`Use layers: ${Object.keys(lanes).join(", ")}`);
const layers = selected.length ? selected : Object.keys(lanes);
if (args.includes("--list")) {
  console.log(
    JSON.stringify(
      {
        layers: Object.fromEntries(layers.map((l) => [l, lanes[l]])),
        live: "never invoked by this command",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}
const git = (...args) =>
  spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout;
const stamp = new Date().toISOString().replaceAll(":", "-");
const output = join(root, ".lifecycle-baseline", stamp);
mkdirSync(output, { recursive: true });
const results = {};
const execution = {};
let failed = false;
for (const layer of layers) {
  const file = join(output, `${layer}.json`);
  const result = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/vitest/vitest.mjs"),
      "run",
      "--config",
      "tests/lifecycle-baseline/vitest.config.ts",
      "--reporter=default",
      "--reporter=json",
      `--outputFile.json=${file}`,
    ],
    {
      cwd: root,
      env: {
        ...process.env,
        LIFECYCLE_BASELINE_LAYER: layer,
        LIFECYCLE_BASELINE_OBSERVATIONS: join(
          output,
          `${layer}-observations.jsonl`,
        ),
      },
      stdio: "inherit",
    },
  );
  if (existsSync(file)) results[layer] = JSON.parse(readFileSync(file, "utf8"));
  else
    results[layer] = {
      testResults: [],
      launchError:
        result.error?.message ??
        `exit ${result.status}, signal ${result.signal}`,
    };
  execution[layer] = {
    exitCode: result.status,
    signal: result.signal,
    success: results[layer].success ?? false,
    total: results[layer].numTotalTests ?? 0,
    passed: results[layer].numPassedTests ?? 0,
    failed: results[layer].numFailedTests ?? 0,
    pending: results[layer].numPendingTests ?? 0,
    launchError: results[layer].launchError ?? null,
  };
  if (result.status !== 0) failed = true;
}
const hash = createHash("sha256")
  .update(git("rev-parse", "HEAD"))
  .update(git("diff", "HEAD"));
// Include untracked authored tests too; staged/unstaged source differences remain inspectable.
for (const path of git("ls-files", "--others", "--exclude-standard")
  .trim()
  .split("\n")
  .filter(Boolean)
  .sort()) {
  hash.update(path).update(readFileSync(join(root, path)));
}
const report = {
  schema: "paperclip.lifecycle-baseline/v1",
  commit: git("rev-parse", "HEAD").trim(),
  fingerprint: hash.digest("hex"),
  measuredAt: new Date().toISOString(),
  layers,
  execution,
  scenarios: summarize(results),
};
writeFileSync(
  join(output, "baseline.json"),
  JSON.stringify(report, null, 2) + "\n",
);
writeFileSync(join(output, "baseline.md"), markdown(report));
writeFileSync(join(output, "source.diff"), git("diff", "HEAD"));
console.log(`Baseline retained at ${output}/baseline.md`);
if (
  report.scenarios.some((s) =>
    s.coverage.some((c) => !["pass", "not_run"].includes(c.status)),
  )
)
  failed = true;
process.exitCode = failed ? 1 : 0;
