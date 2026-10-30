import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { matchesGlob } from "node:path";
import { fileURLToPath } from "node:url";

const releaseNote = /^releases\/(beta\/)?v[^/]+\.md$/;
const validPath = (file) => typeof file === "string" && file.length > 0
  && !file.startsWith("/") && !file.split("/").includes("..") && !file.includes("\0");

function validateGlobs(globs) {
  if (!Array.isArray(globs) || globs.some((glob) => !validPath(glob) || /[!{}[\]?$\\]/.test(glob))) {
    throw new Error("Unsupported task input pattern");
  }
}

export function comparisonPaths(comparison) {
  if (!Array.isArray(comparison?.files) || comparison.files.length === 0 || comparison.files.length >= 300) {
    throw new Error("Missing, empty, or possibly truncated comparison");
  }
  return comparison.files.flatMap((file) => {
    if (!validPath(file.filename) || (file.status === "renamed" && !validPath(file.previous_filename))
      || (file.previous_filename !== undefined && !validPath(file.previous_filename))) {
      throw new Error("Malformed changed file");
    }
    return file.previous_filename ? [file.previous_filename, file.filename] : [file.filename];
  });
}

export function planTasks({ config, lanes, paths, mode = "enabled", forceReason = null }) {
  if (!["enabled", "shadow", "full"].includes(mode)) throw new Error("Invalid CI mode");
  validateGlobs(config.globalDependencies);
  const tasks = config.tasks;
  const inputs = new Map();
  function taskInputs(name, parents = []) {
    if (inputs.has(name)) return inputs.get(name);
    if (parents.includes(name)) throw new Error("Cyclic task graph");
    const task = tasks[`//#${name}`];
    if (!task) throw new Error(`Missing task: ${name}`);
    validateGlobs(task.inputs);
    const all = [...task.inputs];
    for (const dependency of task.dependsOn ?? []) {
      if (!dependency.startsWith("//#")) throw new Error("Unsupported task dependency");
      all.push(...taskInputs(dependency.slice(3), [...parents, name]));
    }
    inputs.set(name, [...new Set(all)]);
    return inputs.get(name);
  }
  for (const entries of Object.values(lanes)) {
    if (!Array.isArray(entries) || !entries.length) throw new Error("Empty CI lane");
    for (const entry of entries) taskInputs(entry.task);
  }
  const changed = [...new Set(paths)];
  if (!changed.length || changed.some((file) => !validPath(file))) forceReason ??= "Missing or invalid diff";
  const matches = (file, globs) => globs.some((glob) => matchesGlob(file, glob));
  const globalChanges = changed.filter((file) => matches(file, config.globalDependencies));
  if (globalChanges.length) forceReason ??= `Global CI input changed: ${globalChanges[0]}`;
  const unknown = changed.filter((file) => !releaseNote.test(file)
    && !matches(file, config.globalDependencies) && ![...inputs.values()].some((globs) => matches(file, globs)));
  if (unknown.length) forceReason ??= `Unclassified path: ${unknown[0]}`;
  if (mode === "full") forceReason ??= "Full CI requested";
  const reasons = Object.fromEntries([...inputs].map(([task, globs]) => [task,
    forceReason ? [forceReason] : [...new Set([...globalChanges, ...changed.filter((file) => matches(file, globs))])],
  ]));
  const jobs = Object.fromEntries(Object.entries(lanes).map(([job, entries]) => {
    const affected = entries.filter((entry) => reasons[entry.task].length > 0);
    const selected = mode === "shadow" ? entries : affected;
    return [job, { run: selected.length > 0, matrix: { include: selected.length ? selected : entries },
      selected: selected.length, proposed: affected.length, total: entries.length }];
  }));
  return { version: 1, mode, forceReason, changed, reasons, jobs };
}

export function planSummary(plan) {
  const rows = Object.entries(plan.jobs).map(([job, lane]) =>
    `| ${job} | ${lane.proposed}/${lane.total} | ${lane.selected}/${lane.total} |`);
  return ["### Incremental CI", "", `Mode: **${plan.mode}**${plan.forceReason ? ` — ${plan.forceReason}` : ""}`,
    "", "| Suite | Affected jobs | Scheduled jobs |", "| --- | ---: | ---: |", ...rows,
    "", "<details><summary>Selection reasons</summary>", "", "```json", JSON.stringify(plan.reasons, null, 2),
    "```", "</details>", ""].join("\n");
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const config = JSON.parse(readFileSync(process.env.CI_TASK_CONFIG ?? "turbo.json", "utf8"));
    const lanes = JSON.parse(readFileSync(process.env.CI_TASK_MATRIX ?? ".github/ci-task-matrix.json", "utf8"));
    let paths = [], forceReason = process.env.CI_FORCE_REASON || null;
    try {
      if (process.env.CI_COMPARISON) {
        paths = comparisonPaths(JSON.parse(readFileSync(process.env.CI_COMPARISON, "utf8")));
      } else {
        const [base, head = "HEAD"] = process.argv.slice(2);
        if (!base) throw new Error("Usage: ci-plan.mjs <base> [head]");
        paths = execFileSync("git", ["diff", "--no-renames", "--name-only", "-z", `${base}...${head}`, "--"],
          { encoding: "utf8" }).split("\0").filter(Boolean);
      }
    } catch (error) { forceReason ??= `Diff unavailable: ${error.message}`; }
    const plan = planTasks({ config, lanes, paths, mode: process.env.CI_INCREMENTAL_MODE || "enabled", forceReason });
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `plan=${JSON.stringify(plan)}\n`);
    else console.log(JSON.stringify(plan, null, 2));
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, planSummary(plan));
  } catch (error) {
    console.error(`Incremental CI unavailable; selecting full CI: ${error.message}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, "plan=\n");
    else process.exitCode = 1;
  }
}
