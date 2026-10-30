import { execFileSync } from "node:child_process";
import { appendFileSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";
import { refineTestPlan, selectionDurations } from "./test-selection-plan.mjs";

export function selectionEligibility(plan) {
  if (plan?.version !== 1 || plan.mode !== "enabled" || plan.forceReason) return "Full/shadow/forced task plan";
  if (!Array.isArray(plan.changed) || !plan.changed.length || plan.changed.length >= 300) return "Incomplete comparison";
  for (const file of plan.changed) {
    if (!/^(?:ui\/src|server\/src|cli\/src|packages\/.+\/src)\/.+\.[cm]?[jt]sx?$/.test(file)
      || /(?:config|setup)|\.d\.[cm]?ts$/i.test(file) || file.split("/").includes("..")) return `Broad input: ${file}`;
    try {
      if (!lstatSync(file).isFile()) return `Non-regular source: ${file}`;
    } catch { return `Deleted or missing source: ${file}`; }
  }
  return null;
}

function runnerInventory(group) {
  const args = group === "serialized" ? ["--mode", "serialized", "--shard-index", "0", "--shard-count", "1"]
    : ["--mode", "general", "--group", group,
      ...(group === "general-server-without-chat" ? ["--shard-index", "0", "--shard-count", "1"] : [])];
  const env = { ...process.env, GITHUB_WORKFLOW: "PR" };
  delete env.PAPERCLIP_CI_TEST_SELECTION;
  return JSON.parse(execFileSync(process.execPath, ["scripts/run-vitest-stable.mjs", ...args, "--dry-run"],
    { env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }));
}

export async function createTestSelection(plan, head) {
  const reason = selectionEligibility(plan);
  if (reason) throw new Error(reason);
  const groups = new Set();
  for (const job of ["general_tests", "verify_serialized_server"]) {
    if (plan.jobs[job].run) for (const entry of plan.jobs[job].matrix.include) groups.add(entry.group ?? "serialized");
  }
  groups.delete("general-chat"); // Keep its line sharding and DB ownership intact.
  const owners = {}, projects = new Set();
  for (const group of groups) {
    const inventory = runnerInventory(group);
    if (group === "serialized" || group === "general-server-without-chat") {
      owners[group] = { "@paperclipai/server": group === "serialized"
        ? inventory.selectedSerializedSuites : inventory.selectedGeneralServerSuites };
      projects.add("@paperclipai/server");
    } else {
      owners[group] = Object.fromEntries(inventory.workspaceProjects.map((project) => [project, null]));
      for (const project of inventory.workspaceProjects) projects.add(project);
    }
  }
  const { selectProjectTests } = await import("./vitest-selection-graph.mjs");
  const graphs = [];
  for (const project of projects) {
    const graph = await selectProjectTests({ project, changed: plan.changed, onlyOwnChanges: true });
    graphs.push(graph);
    console.log(`${project}: ${graph.selected.length}/${graph.inventory.length} files, ${graph.alwaysRun.length} retained conservatively, ${graph.seconds.toFixed(1)}s`);
    for (const owner of Object.values(owners)) if (owner[project] === null) owner[project] = graph.inventory;
  }
  const covered = new Set(graphs.flatMap((graph) => graph.coveredChanges));
  for (const file of plan.changed) assert.ok(covered.has(file), `Change outside the resolved test graphs: ${file}`);
  const server = graphs.find((graph) => graph.project === "@paperclipai/server");
  if (server) {
    const general = runnerInventory("general-server-without-chat");
    const native = runnerInventory("general-server-native-runner");
    assert.deepEqual([...general.selectedGeneralServerSuites, ...general.selectedSerializedSuites,
      ...native.selectedGeneralServerSuites, "server/src/__tests__/chat-channels.integration.test.ts"].sort(),
    server.inventory, "Server inventory must be completely covered by existing lane ownership");
  }
  return { ...refineTestPlan({ plan, head, owners, graphs, durations: selectionDurations() }), graphs };
}

async function main() {
  const plan = JSON.parse(process.env.CI_PLAN || "null");
  const output = (key, value) => {
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  };
  if (process.argv.includes("--eligible")) {
    const reason = selectionEligibility(plan);
    console.log(reason ?? "Source diff is eligible for graph selection");
    output("enabled", !reason);
    return;
  }
  const directory = ".ci-test-selection";
  mkdirSync(directory, { recursive: true });
  const git = (...args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
  let result;
  try {
    const head = git("rev-parse", "HEAD");
    assert.equal(head, process.env.GITHUB_SHA, "Selection must describe the tested merge commit");
    assert.match(process.env.BASE_SHA ?? "", /^[a-f0-9]{40}$/);
    const changed = execFileSync("git", ["diff", "--name-only", "--no-renames", "-z", process.env.BASE_SHA, head, "--"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0").filter(Boolean).sort();
    assert.deepEqual(changed, [...new Set(plan.changed)].sort(), "Local diff disagrees with the trusted routing diff");
    assert.equal(git("status", "--porcelain", "--untracked-files=normal"), "", "Source inputs changed during dependency setup");
    process.env.NODE_ENV = "test";
    process.env.VITEST = "true";
    result = await createTestSelection(plan, head);
    writeFileSync(`${directory}/manifest.json`, JSON.stringify(result.manifest));
    writeFileSync(`${directory}/audit.json`, JSON.stringify(result.graphs, null, 2));
    output("selected", "true");
  } catch (error) {
    console.warn(`Using the complete task plan: ${error.message}`);
    result = { plan: { ...plan, testSelectionFallback: error.message } };
    output("selected", "false");
  }
  writeFileSync(`${directory}/plan.json`, JSON.stringify(result.plan));
  if (process.env.GITHUB_STEP_SUMMARY) {
    const stats = result.plan.testSelection?.stats;
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, stats
      ? ["### Vitest test selection", "", "| Lane | Test files | Jobs |", "| --- | ---: | ---: |",
        ...stats.map((s) => `| ${s.group} | ${s.selected}/${s.total} | ${s.jobs}/${s.beforeJobs} |`), "",
        "Filesystem/process/opaque consumers are retained. Chat and native Runner lanes keep their existing ownership.", ""].join("\n")
      : `### Vitest test selection\n\nFull task plan: ${result.plan.testSelectionFallback}\n`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error); process.exitCode = 1; });
}
