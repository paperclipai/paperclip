import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { planTasks } from "../../.github/scripts/ci-plan.mjs";
import { productInputs } from "../../.github/scripts/ci-inputs.mjs";
import { selectionEligibility } from "../ci/select-tests.mjs";

const chatSuite = "server/src/__tests__/chat-channels.integration.test.ts";

function inventory(root, env, group) {
  const args = group === "serialized" ? ["--mode", "serialized"] : ["--mode", "general", "--group", group];
  return JSON.parse(execFileSync(process.execPath, [path.join(root, "scripts/run-vitest-stable.mjs"), ...args,
    "--shard-index", "0", "--shard-count", "1", "--dry-run"], {
    cwd: root, env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }));
}

export async function planVerification({ root, env, diff, full = false }) {
  const config = JSON.parse(readFileSync(path.join(root, "turbo.json"), "utf8"));
  const lanes = JSON.parse(readFileSync(path.join(root, ".github/ci-task-matrix.json"), "utf8"));
  const coarse = planTasks({ config, lanes, paths: diff.changed });
  const requiredCI = diff.changed.length ? Object.entries(coarse.jobs).filter(([, job]) => job.run).map(([name]) => name) : [];
  if (full) return { kind: "full", jobs: [{ id: "full", args: null, cacheable: false }], requiredCI, selectedFiles: null, reason: "Full Vitest suite explicitly requested; opaque integration coverage runs fresh" };
  if (!productInputs(diff.changed).length) return { kind: "selected", jobs: [], requiredCI, selectedFiles: [], reason: "No changed product inputs" };
  const reason = coarse.forceReason ?? selectionEligibility(coarse, root);
  if (reason) return { kind: "broad", reason, jobs: [], requiredCI };
  try {
    const groups = [...new Set(["general_tests", "verify_serialized_server"].flatMap(job =>
      coarse.jobs[job]?.run ? coarse.jobs[job].matrix.include.map(entry => entry.group ?? "serialized") : []))];
    const inventories = new Map(groups.filter(group => group !== "general-chat").map(group => [group, inventory(root, env, group)]));
    const projects = [...new Set([...inventories.values()].flatMap(value => value.workspaceProjects ?? ["@paperclipai/server"]))];
    const { selectProjects } = await import("../ci/select-projects.mjs");
    const graphs = await selectProjects({ root, projects, changed: productInputs(diff.changed), concurrency: 1, env });
    if (graphs.some(graph => !graph.isolated)) throw new Error("Non-isolated projects require broad verification");
    const covered = new Set(graphs.flatMap(graph => graph.coveredChanges));
    const uncovered = productInputs(diff.changed).filter(file => !covered.has(file));
    if (uncovered.length) throw new Error(`Changes outside resolved test graphs: ${uncovered.join(", ")}`);
    const byProject = new Map(graphs.map(graph => [graph.project, graph]));
    const manifest = { version: 1, head: diff.head, lanes: {} }, jobs = [], selectedFiles = new Set();
    for (const group of groups) {
      if (group === "general-chat") {
        if (byProject.get("@paperclipai/server")?.selected.includes(chatSuite)) {
          selectedFiles.add(chatSuite);
          for (let index = 0; index < 6; index++) jobs.push({ id: `chat-${index + 1}`, cacheable: false, args: ["--mode", "general", "--group", group,
            "--shard-index", String(index), "--shard-count", "6", "--serial-chat"] });
        }
        continue;
      }
      const value = inventories.get(group);
      const owners = value.workspaceProjects
        ? Object.fromEntries(value.workspaceProjects.map(project => [project, byProject.get(project).inventory]))
        : { "@paperclipai/server": group === "serialized" ? value.selectedSerializedSuites : value.selectedGeneralServerSuites };
      const reusable = {}, fresh = {};
      for (const [project, files] of Object.entries(owners)) {
        const graph = byProject.get(project), all = new Set(graph.inventory), affected = new Set(graph.selected);
        if (!Array.isArray(files) || files.some(file => !all.has(file))) throw new Error(`Runner/graph inventory mismatch: ${group}`);
        const matches = files.filter(file => affected.has(file));
        const opaque = new Set(graph.alwaysRun);
        const pure = matches.filter(file => !opaque.has(file)), retained = matches.filter(file => opaque.has(file));
        if (pure.length) reusable[project] = pure;
        if (retained.length) fresh[project] = retained;
        matches.forEach(file => selectedFiles.add(file));
      }
      const partitions = [reusable, fresh].filter(files => Object.keys(files).length);
      if (!partitions.length) continue;
      manifest.lanes[group] = { shards: partitions };
      for (const [index, files] of partitions.entries()) jobs.push({ id: `${group}-${files === reusable ? "reusable" : "fresh"}`,
        cacheable: files === reusable, selected: true, args: ["--mode", group === "serialized" ? "serialized" : "general",
          ...(group === "serialized" ? [] : ["--group", group]), "--shard-index", String(index), "--shard-count", String(partitions.length)] });
    }
    const expected = new Set(graphs.flatMap(graph => graph.selected));
    if (expected.size !== selectedFiles.size || [...expected].some(file => !selectedFiles.has(file))) {
      throw new Error("Selected tests are not completely covered by local runner ownership");
    }
    const { validateSelection } = await import("../ci/test-selection-manifest.mjs");
    validateSelection(manifest);
    return { kind: "selected", jobs, manifest, requiredCI, selectedFiles: [...selectedFiles].sort(),
      totalFiles: graphs.reduce((count, graph) => count + graph.inventory.length, 0),
      retainedFiles: graphs.reduce((count, graph) => count + graph.alwaysRun.length, 0) };
  } catch (error) {
    return { kind: "broad", reason: `Conservative selection unavailable: ${error.message}`, jobs: [], requiredCI };
  }
}
